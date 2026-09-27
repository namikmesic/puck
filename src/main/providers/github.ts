/**
 * The GitHub integration provider: the app's own GitHub sign-in, used to
 * read the config repo and list what the user can reach.
 *
 *  - Sign-in is the device flow with the GitHub App's client id only
 *    (github-app.ts). The pair lands encrypted in github-oauth.bin through
 *    createOAuthAccount, whose single-flight refresh matters here: every
 *    refresh rotates the pair and kills the old one, so two concurrent
 *    refreshes would sign the user out. `bad_refresh_token` (or an expired
 *    refresh token) is a local sign-out.
 *  - The fallback is a fine-grained personal access token, stored in the
 *    same file without a refresh token; `mode` in puck-providers.json says
 *    which one is in use (installation endpoints need the app).
 *  - Tokens never leave the main process: Settings sees the login, mode,
 *    config repo and installations only.
 */

import type {
  GitHubInstallation,
  GitHubRepo,
  GitHubStatus,
  ProviderAuthInfo,
} from '../../harness/bridge';
import {
  createGitHubClient,
  GitHubApiError,
  RefreshRejectedError,
  refreshUserToken,
  type GhRepo,
  type GitHubClient,
  type GitHubDeps,
  type UserTokens,
} from '../../harness/github';
import { log } from '../log';
import { githubClientId, githubInstallUrl, GITHUB_PAT_URL } from './github-app';
import { createDeviceSignIn } from './github-device';
import { createOAuthAccount, type LogoutFence } from './oauth';
import { githubSettings, updateGithubSettings } from './providers-store';
import type { IntegrationProvider } from './types';

export interface GitHubTokens extends UserTokens {
  login: string;
  userId: number;
}

/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;

let deps: GitHubDeps | undefined;

/** Test seam: drive fetch and time for the whole provider. */
export function useGitHubDeps(next: GitHubDeps | undefined): void {
  deps = next;
}

const now = (): number => (deps ?? { now: Date.now }).now();

export const account = createOAuthAccount<GitHubTokens>({
  storeName: 'github-oauth.bin',
  freshnessOf: (t) => t.expiresAt ?? 0,
  needsRefresh: (t) => t.refreshToken !== null && t.expiresAt !== null && t.expiresAt - REFRESH_MARGIN_MS <= now(),
  refresh: async (t) => {
    const clientId = githubClientId();
    if (!t.refreshToken || !clientId) return null;
    if (t.refreshExpiresAt !== null && t.refreshExpiresAt <= now()) throw new RefreshRejectedError();
    const next = await refreshUserToken(clientId, t.refreshToken, deps);
    log.info('github.refresh', { login: t.login });
    return { ...next, login: t.login, userId: t.userId };
  },
  // Nothing mirrors this pair into containers.
  parseContainerFile: () => null,
  refreshRejected: (err) => err instanceof RefreshRejectedError,
});

async function accessToken(): Promise<string> {
  const tokens = await account.getFreshTokens();
  if (!tokens) throw new Error('Sign in to GitHub first.');
  return tokens.accessToken;
}

/** One client for the app sign-in, so the rate-limit budget is tracked once. */
let shared: { client: GitHubClient; deps: GitHubDeps | undefined } | null = null;

export function githubClient(): GitHubClient {
  if (!shared || shared.deps !== deps) {
    shared = { client: createGitHubClient({ token: accessToken, deps }), deps };
  }
  return shared.client;
}

/** Fetch the account behind a fresh token and save the pair under the fence. */
async function completeSignIn(tokens: UserTokens, mode: 'app' | 'pat', fence: LogoutFence): Promise<GitHubTokens> {
  const probe = createGitHubClient({ token: async () => tokens.accessToken, deps });
  const user = await probe.user();
  const full: GitHubTokens = { ...tokens, login: user.login, userId: user.id };
  if (!account.save(full, fence)) throw new Error('Signed out while signing in.');
  updateGithubSettings({ mode });
  log.info('github.signin', { login: user.login, mode });
  account.notifyLogin();
  return full;
}

let signInFence: LogoutFence | null = null;

const device = createDeviceSignIn({
  onTokens: async (tokens) => {
    await completeSignIn(tokens, 'app', signInFence ?? account.fence());
  },
  onError: (err) => account.recordError(err),
  deps: () => deps,
});

function authStatus(): ProviderAuthInfo {
  const tokens = account.load();
  const pending = device.pending() !== null;
  if (tokens) {
    const how = githubSettings().mode === 'pat' ? 'personal access token' : 'GitHub App';
    return { connected: true, pending, detail: `Signed in as ${tokens.login} (${how})` };
  }
  const err = account.lastError();
  if (err) return { connected: false, pending, detail: `Sign-in failed: ${err}` };
  return {
    connected: false,
    pending,
    detail: githubClientId()
      ? 'Not connected — sign in with GitHub'
      : 'GitHub App sign-in is not available in this build yet — use a personal access token',
  };
}

export const githubProvider: IntegrationProvider = {
  kind: 'integration',
  id: 'github',
  label: 'GitHub',
  auth: {
    status: authStatus,
    async start() {
      const clientId = githubClientId();
      if (!clientId) {
        throw new Error(
          'The GitHub App is not registered in this build yet. Set PUCK_GITHUB_CLIENT_ID, or use a personal access token.',
        );
      }
      signInFence = account.fence();
      const prompt = await device.start(clientId);
      log.info('github.device-code', { expiresAt: prompt.expiresAt });
      return prompt;
    },
    cancel: () => device.cancel(),
    async logout() {
      device.cancel();
      await account.logout();
    },
  },
  state(): GitHubStatus {
    const settings = githubSettings();
    return {
      login: account.load()?.login ?? null,
      mode: settings.mode,
      configRepo: settings.configRepo,
      installUrl: githubInstallUrl(),
      appConfigured: githubClientId() !== null,
      pendingCode: device.pending(),
      patUrl: GITHUB_PAT_URL,
    };
  },
};

/** Sign in with a fine-grained personal access token (validated against GET /user). */
export async function setPersonalToken(token: string): Promise<void> {
  const value = token.trim();
  if (!value) throw new Error('Paste a personal access token.');
  device.cancel();
  const fence = account.fence();
  try {
    await completeSignIn(
      { accessToken: value, expiresAt: null, refreshToken: null, refreshExpiresAt: null },
      'pat',
      fence,
    );
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 401) {
      throw new Error('GitHub rejected this token. Check that it is active and copied in full.');
    }
    throw err;
  }
}

function toRepo(r: GhRepo): GitHubRepo {
  return { fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, htmlUrl: r.html_url };
}

export async function installations(): Promise<GitHubInstallation[]> {
  if (!account.load() || githubSettings().mode === 'pat') return [];
  const list = await githubClient().installations();
  return list.map((i) => ({
    id: i.id,
    account: i.account?.login ?? '(unknown account)',
    accountType: i.account?.type ?? '',
    manageUrl: i.html_url,
    repositorySelection: i.repository_selection,
  }));
}

/** Repositories the sign-in reaches: installation repos (app) or /user/repos (token). */
export async function repositories(): Promise<GitHubRepo[]> {
  if (!account.load()) throw new Error('Sign in to GitHub first.');
  const client = githubClient();
  let repos: GhRepo[];
  if (githubSettings().mode === 'pat') {
    repos = await client.userRepos();
  } else {
    repos = [];
    for (const inst of await client.installations()) repos.push(...(await client.installationRepos(inst.id)));
  }
  const byName = new Map(repos.map((r) => [r.full_name.toLowerCase(), r]));
  return [...byName.values()].map(toRepo).sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** Choose the config repo; it must be reachable with the current sign-in. */
export async function setConfigRepo(fullName: string): Promise<void> {
  const [owner, name] = fullName.split('/');
  let repo: GhRepo;
  try {
    repo = await githubClient().repo(owner, name);
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) {
      throw new Error(`${fullName} is not reachable with this GitHub sign-in. Install the app on its owner, or pick another repo.`);
    }
    throw err;
  }
  updateGithubSettings({ configRepo: repo.full_name });
  log.info('github.config-repo', { repo: repo.full_name });
}
