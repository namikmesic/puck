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
 *  - There is no personal-access-token sign-in. A sign-in saved by the
 *    old token mode is discarded at boot (retireLegacyTokenSignIn).
 *  - Tokens never leave the main process: Settings sees the login, config
 *    repo and installations only.
 */

import type {
  GithubInstallation,
  GithubRepo,
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
import { githubClientId, githubInstallUrl } from './github-app';
import { createDeviceSignIn } from './github-device';
import { createOAuthAccount, signInStatus, type LogoutFence } from './oauth';
import { githubSettings, takeLegacyTokenMode, updateGithubSettings } from './providers-store';
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
async function completeSignIn(tokens: UserTokens, fence: LogoutFence): Promise<GitHubTokens> {
  const probe = createGitHubClient({ token: async () => tokens.accessToken, deps });
  const user = await probe.user();
  const full: GitHubTokens = { ...tokens, login: user.login, userId: user.id };
  if (!account.save(full, fence)) throw new Error('Signed out while signing in.');
  log.info('github.signin', { login: user.login });
  account.notifyLogin();
  return full;
}

let signInFence: LogoutFence | null = null;

const device = createDeviceSignIn({
  onTokens: async (tokens) => {
    await completeSignIn(tokens, signInFence ?? account.fence());
  },
  onError: (err) => account.recordError(err),
  deps: () => deps,
});

function authStatus(): ProviderAuthInfo {
  const tokens = account.load();
  const pending = device.pending() !== null;
  if (tokens) {
    return { connected: true, pending, detail: `Signed in as ${tokens.login}` };
  }
  const err = account.lastError();
  if (err) return { connected: false, pending, detail: `Sign-in failed: ${err}` };
  return {
    connected: false,
    pending,
    detail: githubClientId()
      ? 'Not connected — sign in with GitHub'
      : 'GitHub sign-in is not available in this build',
  };
}

export const githubProvider: IntegrationProvider = {
  kind: 'integration',
  id: 'github',
  label: 'GitHub',
  status: () => signInStatus(account, authStatus()),
  auth: {
    status: authStatus,
    async start() {
      const clientId = githubClientId();
      if (!clientId) {
        throw new Error('The GitHub App is not registered in this build yet. Set PUCK_GITHUB_CLIENT_ID.');
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
      configRepo: settings.configRepo,
      installUrl: githubInstallUrl(),
      appConfigured: githubClientId() !== null,
      pendingCode: device.pending(),
    };
  },
};

/**
 * Boot: a sign-in saved by the removed personal-token mode is discarded, so
 * GitHub reads as signed out until the device flow runs. Runs once per file
 * (the store drops the old mode as it answers); the config repo is kept.
 */
export async function retireLegacyTokenSignIn(): Promise<void> {
  if (!takeLegacyTokenMode()) return;
  await account.logout();
  log.info('github.legacy-token-retired');
}

function toRepo(r: GhRepo): GithubRepo {
  return { fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, htmlUrl: r.html_url };
}

export async function installations(): Promise<GithubInstallation[]> {
  if (!account.load()) return [];
  const list = await githubClient().installations();
  return list.map((i) => ({
    id: i.id,
    account: i.account?.login ?? '(unknown account)',
    accountType: i.account?.type ?? '',
    manageUrl: i.html_url,
    repositorySelection: i.repository_selection,
  }));
}

/** Repositories the sign-in reaches: the repos of every app installation. */
export async function repositories(): Promise<GithubRepo[]> {
  if (!account.load()) throw new Error('Sign in to GitHub first.');
  const client = githubClient();
  const repos: GhRepo[] = [];
  for (const inst of await client.installations()) repos.push(...(await client.installationRepos(inst.id)));
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
