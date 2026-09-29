/**
 * The Puck home: the one GitHub repository that holds the user's agent and
 * environment definitions. The app never edits a definition; Git is the
 * only way to change one. This module connects a home and initializes new
 * ones, with the GitHub App permissions Puck already has (contents and
 * workflows write). It never creates a repository.
 *
 *  - Inspect: a repository is a home when `agents/` or `environments/`
 *    sits at the root of its default branch, empty when it has no commits
 *    (or holds only the bootstrap commit of an initialize that stopped
 *    early), and not a home otherwise.
 *  - Connect: only a home is stored. An empty repository or one without
 *    definitions is refused with the way on (initialize, or another pick).
 *  - Initialize: only an empty repository. The Git Data API refuses to
 *    write to a repository without commits, so a Contents API PUT of the
 *    README bootstraps the default branch first. The whole starter home
 *    (home-starter.ts) then becomes one root commit, the default branch is
 *    forced onto it (the bootstrap commit is dropped), and `v1.0.0` tags
 *    it so the default pin resolves.
 *
 * The stored setting keeps its old name, `configRepo`, so existing installs
 * keep their home.
 */

import { createHash } from 'node:crypto';
import { GitHubApiError, type GhRepo, type GhTreeEntry, type GitHubClient } from '../harness/github';
import { starterFiles } from './home-starter';
import { log } from './log';
import { githubClient } from './providers/github';
import { updateGithubSettings } from './providers/providers-store';

export type HomeState = 'home' | 'empty' | 'not-home';

/** What Connect answers: connected, or why the repository is not a home. */
export type HomeConnectResult =
  | { connected: true; repo: string }
  | { connected: false; repo: string; state: 'empty' | 'not-home'; message: string };

export interface HomeDeps {
  client(): GitHubClient;
  /** Store the connected home (`owner/name`). */
  save(fullName: string): void;
  /** Waits between retries of a write GitHub is not ready for yet. */
  sleep?(ms: number): Promise<void>;
}

export const HOME_TAG = 'v1.0.0';
const COMMIT_MESSAGE = 'Initialize the Puck home';
const BOOTSTRAP_FILE = 'README.md';
/** Right after the bootstrap commit GitHub can still answer "Git Repository is empty" for a moment. */
const EMPTY_RETRIES = 3;
const EMPTY_RETRY_MS = 1000;

/** The git blob id of a text, as a tree entry carries it. */
export function gitBlobSha(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function split(fullName: string): { owner: string; name: string } {
  const [owner, name] = fullName.split('/');
  return { owner, name };
}

function notReachable(fullName: string): Error {
  return new Error(`${fullName} is not reachable with this GitHub sign-in. Install Puck on its owner, or add it to the installation's repositories.`);
}

function missingWorkflowsPermission(err: unknown): err is GitHubApiError {
  if (!(err instanceof GitHubApiError) || (err.status !== 403 && err.status !== 422)) return false;
  const prefix = `GitHub ${err.status} on ${err.path}: `;
  const body = err.message.startsWith(prefix) ? err.message.slice(prefix.length) : '';
  return /create or update workflow/i.test(body) && /`workflows` permission/i.test(body);
}

export function createHome(deps: HomeDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function repoOf(fullName: string): Promise<GhRepo> {
    const { owner, name } = split(fullName);
    try {
      return await deps.client().repo(owner, name);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) throw notReachable(fullName);
      throw err;
    }
  }

  /** The root entries of the default branch; null when the repository has no commits. */
  async function rootEntries(repo: GhRepo): Promise<GhTreeEntry[] | null> {
    const { owner, name } = split(repo.full_name);
    const client = deps.client();
    try {
      const head = await client.commitSha(owner, name, `heads/${repo.default_branch}`);
      return await client.treeLevel(owner, name, head);
    } catch (err) {
      if (!(err instanceof GitHubApiError)) throw err;
      if (err.status === 409) return null;
      if ((err.status === 404 || err.status === 422) && (await client.branches(owner, name)).length === 0) return null;
      throw err;
    }
  }

  /** Only the README an earlier initialize committed before it stopped. */
  function bootstrapOnly(entries: readonly GhTreeEntry[]): boolean {
    const readme = starterFiles({ fullName: 'x/x', defaultBranch: 'main' })[BOOTSTRAP_FILE];
    return entries.length === 1 && entries[0].path === BOOTSTRAP_FILE && entries[0].sha === gitBlobSha(readme);
  }

  function stateOf(entries: readonly GhTreeEntry[] | null): HomeState {
    if (entries === null || bootstrapOnly(entries)) return 'empty';
    return entries.some((e) => e.type === 'tree' && (e.path === 'agents' || e.path === 'environments')) ? 'home' : 'not-home';
  }

  async function inspect(fullName: string): Promise<{ repo: GhRepo; state: HomeState; bootstrapped: boolean }> {
    const repo = await repoOf(fullName);
    const entries = await rootEntries(repo);
    return { repo, state: stateOf(entries), bootstrapped: entries !== null };
  }

  async function connect(fullName: string): Promise<HomeConnectResult> {
    const { repo, state } = await inspect(fullName);
    const name = repo.full_name;
    if (state === 'empty') {
      return { connected: false, repo: name, state, message: `${name} is empty, so it has no definitions yet. Initialize it as a new Puck home instead.` };
    }
    if (state === 'not-home') {
      return {
        connected: false,
        repo: name,
        state,
        message: `${name} has no agents/ or environments/ folder at its root, so it is not a Puck home. Pick the repository that holds your definitions, or initialize a new Puck home in an empty repository.`,
      };
    }
    deps.save(name);
    log.info('home.connected', { repo: name });
    return { connected: true, repo: name };
  }

  /** Retries a Git Data write while GitHub still reports the repository empty. */
  async function whenReady<T>(write: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await write();
      } catch (err) {
        if (!(err instanceof GitHubApiError && err.status === 409) || attempt >= EMPTY_RETRIES) throw err;
        await sleep(EMPTY_RETRY_MS);
      }
    }
  }

  /**
   * Commits the starter home into the empty repository `home`, with one
   * environment working on `envRepo`, tags it, and connects it. Refuses a
   * repository that already has content.
   */
  async function initialize(home: string, envRepo: string): Promise<string> {
    const { repo, state, bootstrapped } = await inspect(home);
    const name = repo.full_name;
    if (state !== 'empty') {
      throw new Error(
        state === 'home'
          ? `${name} already holds a Puck home. Connect it instead; Puck initializes only an empty repository, so it never overwrites files.`
          : `${name} already has files. Puck initializes only an empty repository, so it never overwrites files. Create a new repository without a README, or pick an empty one.`,
      );
    }
    const target = await repoOf(envRepo);
    if (target.full_name.toLowerCase() === name.toLowerCase()) {
      throw new Error('The first environment works on a project repository, not on the Puck home itself. Pick a different repository for it.');
    }
    const files = starterFiles({ fullName: target.full_name, defaultBranch: target.default_branch });
    const { owner, name: repoName } = split(name);
    const client = deps.client();
    const started = Date.now();
    try {
      if (!bootstrapped) {
        await client.putContents(owner, repoName, BOOTSTRAP_FILE, {
          message: COMMIT_MESSAGE,
          base64: Buffer.from(files[BOOTSTRAP_FILE], 'utf8').toString('base64'),
        });
      }
      const entries = Object.entries(files).map(([path, content]) => ({ path, content }));
      const tree = await whenReady(() => client.createTree(owner, repoName, entries));
      const commit = await client.createCommit(owner, repoName, { message: COMMIT_MESSAGE, tree: tree.sha, parents: [] });
      await client.updateRef(owner, repoName, `heads/${repo.default_branch}`, commit.sha, true);
      await client.createRef(owner, repoName, `tags/${HOME_TAG}`, commit.sha);
      deps.save(name);
      log.info('home.initialized', { repo: name, files: entries.length, ms: Date.now() - started });
      return name;
    } catch (err) {
      if (missingWorkflowsPermission(err)) {
        throw new Error(`GitHub did not let Puck write the validation workflow to ${name}: ${err.message}. Check that the Puck app's installation has the workflows permission.`);
      }
      throw err;
    }
  }

  return { inspect, connect, initialize };
}

export type Home = ReturnType<typeof createHome>;

const home = createHome({
  client: githubClient,
  save: (fullName) => updateGithubSettings({ configRepo: fullName }),
});

export const connectHome = (fullName: string): Promise<HomeConnectResult> => home.connect(fullName);
export const initializeHome = (fullName: string, envRepo: string): Promise<string> => home.initialize(fullName, envRepo);
