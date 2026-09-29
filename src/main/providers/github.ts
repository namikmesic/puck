/**
 * The GitHub integration provider: signing in to Puck with GitHub, and the
 * app's own GitHub API access (config repo, installations, repositories).
 *
 *  - Sign-in is the Puck server's GitHub web flow (server/session.ts): the
 *    server holds the GitHub App's client secret and the user's token pair.
 *    The app keeps only its Puck session and never a GitHub refresh token.
 *  - GitHub API calls use the user's current access token, which the server
 *    hands out (`GET /v1/github/token`); it is cached here until a few
 *    minutes before it expires, in memory only.
 *  - The GitHub App's install link comes from the server too (`GET
 *    /v1/me`), once per session: the app holds no App identity of its own.
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
  type GhRepo,
  type GitHubClient,
  type GitHubDeps,
} from '../../harness/github';
import { log } from '../log';
import * as serverApi from '../server/api';
import { ServerApiError, serverUrl } from '../server/http';
import { account, cancelSignIn, current, onSessionChange, signInPending, signOut, startSignIn } from '../server/session';
import { signInStatus } from './oauth';
import { githubSettings, updateGithubSettings } from './providers-store';
import type { IntegrationProvider } from './types';

/** Ask the server again this long before the cached access token expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;

let deps: GitHubDeps | undefined;

/** Test seam: drive fetch and time for the GitHub API client. */
export function useGitHubDeps(next: GitHubDeps | undefined): void {
  deps = next;
  cached = null;
}

const now = (): number => (deps ?? { now: Date.now }).now();

let generation = 0;
let cached: { token: string; expiresAt: number; generation: number } | null = null;
let fetching: { promise: Promise<string>; generation: number } | null = null;

/** The install link the server gave for this session, once it answered. */
let installLink: { url: string | null; generation: number } | null = null;

onSessionChange(() => {
  generation += 1;
  cached = null;
  fetching = null;
  installLink = null;
});

/**
 * Asks the server for the GitHub App's install link once per session, so
 * `state()` can show it; a failure leaves it unknown until the next call.
 */
export async function loadInstallLink(): Promise<void> {
  if (!current() || installLink?.generation === generation) return;
  const gen = generation;
  try {
    const me = await serverApi.me();
    if (gen === generation) installLink = { url: me.installUrl, generation: gen };
  } catch (err) {
    log.warn('github.install-link-failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function accessToken(): Promise<string> {
  if (!current()) throw new Error('Sign in to Puck with GitHub first.');
  const gen = generation;
  if (cached && cached.generation === gen && (cached.expiresAt === 0 || cached.expiresAt - TOKEN_MARGIN_MS > now())) return cached.token;
  if (fetching && fetching.generation === gen) return fetching.promise;
  const promise = serverApi.githubToken().then(
    (t) => {
      if (gen !== generation) throw new Error('Sign in to Puck with GitHub first.');
      cached = { token: t.token, expiresAt: t.expiresAt, generation: gen };
      return t.token;
    },
    (err: unknown) => {
      if (err instanceof ServerApiError && err.code === 'github-auth-lost') {
        throw new Error('GitHub no longer accepts your Puck sign-in. Sign out of Puck and sign in again.');
      }
      throw err;
    },
  );
  fetching = { promise, generation: gen };
  void promise.finally(() => {
    if (fetching?.promise === promise) fetching = null;
  }).catch(() => undefined);
  return promise;
}

/** One client for the app's GitHub access, so the rate-limit budget is tracked once. */
let shared: { client: GitHubClient; deps: GitHubDeps | undefined } | null = null;

export function githubClient(): GitHubClient {
  if (!shared || shared.deps !== deps) {
    shared = { client: createGitHubClient({ token: accessToken, deps }), deps };
  }
  return shared.client;
}

function authStatus(): ProviderAuthInfo {
  const session = current();
  const pending = signInPending();
  if (session) return { connected: true, pending, detail: `Signed in to Puck as ${session.user.login}` };
  const err = account.lastError();
  if (err) return { connected: false, pending, detail: `Sign-in failed: ${err}` };
  return { connected: false, pending, detail: 'Not signed in — sign in to Puck with GitHub' };
}

export const githubProvider: IntegrationProvider = {
  kind: 'integration',
  id: 'github',
  label: 'GitHub',
  status: () => signInStatus(account, authStatus()),
  auth: {
    status: authStatus,
    async start() {
      const url = await startSignIn();
      log.info('github.signin-started');
      return url;
    },
    cancel: () => cancelSignIn(),
    logout: () => signOut(),
  },
  state(): GitHubStatus {
    const settings = githubSettings();
    return {
      login: current()?.user.login ?? null,
      configRepo: settings.configRepo,
      installUrl: installLink?.generation === generation ? installLink.url : null,
      server: serverUrl(),
    };
  },
};

function toRepo(r: GhRepo): GithubRepo {
  return { fullName: r.full_name, private: r.private, defaultBranch: r.default_branch, htmlUrl: r.html_url };
}

export async function installations(): Promise<GithubInstallation[]> {
  if (!current()) return [];
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
  if (!current()) throw new Error('Sign in to Puck with GitHub first.');
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
