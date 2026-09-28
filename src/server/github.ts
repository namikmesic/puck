/**
 * The server's side of the Puck GitHub App.
 *
 * - Web-flow sign-in: the authorize URL, and the code exchange and refresh
 *   with the client secret (only the server holds it).
 * - App JWTs (RS256, 9-minute life, `iat` backdated 60 s for clock skew),
 *   produced by an `AppSigner`. The shipped signer holds the PEM in memory
 *   and only ever signs; a key-vault signer can replace it without touching
 *   a caller.
 * - Installation lookup for a repository, and installation tokens minted
 *   with `repository_ids` and an explicit permission set.
 * - Repository access checks with a user's own token: `push` is what Puck
 *   requires, because the environment's installation token can write.
 *
 * REST goes through the shared GitHub transport (`src/harness/github`), so
 * rate limits behave as they do in the app. All effects are injected; the
 * tests run against a fake GitHub.
 */

import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import {
  createHttpClient,
  defaultDeps,
  GitHubApiError,
  GitHubRateLimitError,
  RefreshRejectedError,
  tokensFrom,
  type HttpClient,
  type UserTokens,
} from '../harness/github';
import type { GitHubAppConfig } from './config';
import { b64url } from './ids';

export { GitHubApiError, RefreshRejectedError, type UserTokens };

export interface GitHubAppDeps {
  fetch: typeof fetch;
  now(): number;
}

export interface AppSigner {
  /** An App JWT valid now. */
  appJwt(now: number): string;
}

export function pemSigner(appId: string, pem: string): AppSigner {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('The GitHub App private key is not a readable PEM key.');
  }
  return {
    appJwt(now) {
      const iat = Math.floor(now / 1000) - 60;
      const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const claims = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
      const signature = sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), key);
      return `${header}.${claims}.${b64url(signature)}`;
    },
  };
}

export class GitHubSignInError extends Error {
  constructor(readonly reason: string) {
    super(`GitHub sign-in failed: ${reason}`);
    this.name = 'GitHubSignInError';
  }
}

export interface RepoAccess {
  id: number;
  owner: string;
  name: string;
  push: boolean;
}

export interface InstallationToken {
  token: string;
  expiresAt: number;
}

export class GitHubApp {
  private appClient: HttpClient;

  constructor(
    readonly config: GitHubAppConfig,
    private signer: AppSigner,
    private deps: GitHubAppDeps = { fetch: defaultDeps.fetch, now: defaultDeps.now },
  ) {
    this.appClient = this.client(async () => this.signer.appJwt(this.deps.now()));
  }

  private client(token: () => Promise<string>): HttpClient {
    return createHttpClient({
      token,
      apiBase: this.config.apiUrl,
      deps: { fetch: this.deps.fetch, now: this.deps.now, sleep: defaultDeps.sleep },
      maxWaitMs: 5_000,
    });
  }

  /** Where the browser goes to sign in; GitHub returns it to `redirectUri` with `state`. */
  authorizeUrl(state: string, redirectUri: string): string {
    const q = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: redirectUri, state });
    return `${this.config.webUrl}/login/oauth/authorize?${q}`;
  }

  /** Where a user installs the App on an account, when its slug is known. */
  installUrl(): string | null {
    return this.config.slug ? `${this.config.webUrl}/apps/${encodeURIComponent(this.config.slug)}/installations/new` : null;
  }

  private async oauth(form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.deps.fetch(`${this.config.webUrl}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Puck' },
      body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...form }).toString(),
    });
    let data: unknown = null;
    try {
      data = JSON.parse(await res.text());
    } catch {
      /* reported below */
    }
    if (typeof data !== 'object' || data === null) throw new GitHubSignInError(`GitHub answered ${res.status} without JSON`);
    return data as Record<string, unknown>;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<UserTokens> {
    const data = await this.oauth({ code, redirect_uri: redirectUri });
    if (typeof data.error === 'string') throw new GitHubSignInError(data.error);
    return tokensFrom(data, this.deps.now());
  }

  /** A new pair for `refreshToken`; RefreshRejectedError when GitHub no longer honors it. */
  async refresh(refreshToken: string): Promise<UserTokens> {
    const data = await this.oauth({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (data.error === 'bad_refresh_token') throw new RefreshRejectedError();
    if (typeof data.error === 'string') throw new GitHubSignInError(data.error);
    return tokensFrom(data, this.deps.now());
  }

  async user(accessToken: string): Promise<{ id: number; login: string }> {
    const res = await this.client(async () => accessToken).request<{ id?: unknown; login?: unknown }>('/user');
    if (typeof res.data.id !== 'number' || typeof res.data.login !== 'string') throw new GitHubSignInError('GitHub returned no user');
    return { id: res.data.id, login: res.data.login };
  }

  /** The repository as the user sees it through the App, or null when they cannot see it. */
  async repoAccess(accessToken: string, owner: string, name: string): Promise<RepoAccess | null> {
    try {
      const res = await this.client(async () => accessToken).request<{
        id?: unknown;
        name?: unknown;
        owner?: { login?: unknown };
        permissions?: { push?: unknown };
      }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
      const d = res.data;
      if (typeof d.id !== 'number') return null;
      return {
        id: d.id,
        owner: typeof d.owner?.login === 'string' ? d.owner.login : owner,
        name: typeof d.name === 'string' ? d.name : name,
        push: d.permissions?.push === true,
      };
    } catch (err) {
      if (err instanceof GitHubRateLimitError) throw err;
      if (err instanceof GitHubApiError && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
  }

  /** The App installation covering the repository, or null when the App is not installed there. */
  async repoInstallation(owner: string, name: string): Promise<number | null> {
    try {
      const res = await this.appClient.request<{ id?: unknown }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      );
      return typeof res.data.id === 'number' ? res.data.id : null;
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }

  async mintInstallationToken(
    installationId: number,
    repositoryIds: number[],
    permissions: Record<string, 'read' | 'write'>,
  ): Promise<InstallationToken> {
    const res = await this.appClient.request<{ token?: unknown; expires_at?: unknown }>(
      `/app/installations/${installationId}/access_tokens`,
      { method: 'POST', body: { repository_ids: repositoryIds, permissions } },
    );
    const { token, expires_at: expiresAt } = res.data;
    if (typeof token !== 'string' || typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
      throw new Error('GitHub returned an incomplete installation token.');
    }
    return { token, expiresAt: Date.parse(expiresAt) };
  }
}
