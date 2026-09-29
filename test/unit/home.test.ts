import { describe, expect, it } from 'vitest';
import { createGitHubClient } from '../../src/harness/github';
import { createHome, gitBlobSha, HOME_TAG } from '../../src/main/home';
import { starterFiles } from '../../src/main/home-starter';
import { fakeGitHub, type Recorded, type Scripted } from './github-fakes';

const API = 'https://api.github.com/repos';
const HEAD = 'c'.repeat(40);

interface FakeRepo {
  defaultBranch?: string;
  /** Root entries of the default branch; null for a repository without commits. */
  root: Array<{ path: string; type: 'blob' | 'tree'; sha?: string }> | null;
}

/**
 * A fake GitHub with a few repositories: reads answer from `repos`, writes
 * are recorded and answered like GitHub does. `treeConflicts` 409s the
 * first tree writes, as GitHub does for a moment after the bootstrap commit.
 */
function world(repos: Record<string, FakeRepo>, opts: { treeConflicts?: number; refError?: Scripted } = {}) {
  let conflicts = opts.treeConflicts ?? 0;
  const handler = (req: Recorded): Scripted => {
    const url = req.url.replace(API, '');
    const m = /^\/([^/]+\/[^/?]+)(.*)$/.exec(url);
    // GitHub matches owner and name without case and answers with the canonical name.
    const fullName = m ? Object.keys(repos).find((k) => k.toLowerCase() === decodeURIComponent(m[1]).toLowerCase()) : undefined;
    const repo = fullName ? repos[fullName] : undefined;
    if (!m || !fullName || !repo) return { status: 404, body: { message: 'Not Found' } };
    const rest = m[2];
    const branch = repo.defaultBranch ?? 'main';
    if (req.method === 'GET') {
      if (rest === '') return { body: { full_name: fullName, private: true, default_branch: branch, html_url: `https://github.com/${fullName}` } };
      if (rest === `/commits/heads/${branch}`) {
        return repo.root === null ? { status: 409, body: { message: 'Git Repository is empty.' } } : { body: HEAD };
      }
      if (rest === `/git/trees/${HEAD}`) return { body: { tree: (repo.root ?? []).map((e) => ({ mode: '100644', sha: 'f'.repeat(40), ...e })) } };
      if (rest === '/branches?per_page=100') return { body: repo.root === null ? [] : [{ name: branch, commit: { sha: HEAD } }] };
    }
    if (req.method === 'PUT' && rest.startsWith('/contents/')) return { status: 201, body: { commit: { sha: 'b'.repeat(40) } } };
    if (req.method === 'POST' && rest === '/git/trees') {
      if (conflicts > 0) {
        conflicts -= 1;
        return { status: 409, body: { message: 'Git Repository is empty.' } };
      }
      return { status: 201, body: { sha: 't'.repeat(40) } };
    }
    if (req.method === 'POST' && rest === '/git/commits') return { status: 201, body: { sha: 'd'.repeat(40) } };
    if (req.method === 'PATCH' && rest.startsWith('/git/refs/')) return opts.refError ?? { body: {} };
    if (req.method === 'POST' && rest === '/git/refs') return { status: 201, body: {} };
    throw new Error(`unexpected request ${req.method} ${req.url}`);
  };
  const gh = fakeGitHub(handler);
  const client = createGitHubClient({ token: async () => 'token', deps: gh.deps });
  const saved: string[] = [];
  const sleeps: number[] = [];
  const home = createHome({
    client: () => client,
    save: (name) => void saved.push(name),
    sleep: async (ms) => void sleeps.push(ms),
  });
  const writes = (): Recorded[] => gh.requests.filter((r) => r.method !== 'GET');
  return { home, saved, sleeps, requests: gh.requests, writes };
}

const HOME_ROOT: FakeRepo['root'] = [
  { path: 'README.md', type: 'blob' },
  { path: 'agents', type: 'tree' },
  { path: 'environments', type: 'tree' },
];
const PROJECT_ROOT: FakeRepo['root'] = [
  { path: 'README.md', type: 'blob' },
  { path: 'src', type: 'tree' },
  { path: 'package.json', type: 'blob' },
];

describe('connecting a Puck home', () => {
  it('stores a repository with agents/ or environments/ at its root, by its canonical name', async () => {
    const w = world({ 'me/home': { root: HOME_ROOT }, 'me/agents-only': { root: [{ path: 'agents', type: 'tree' }] } });
    await expect(w.home.connect('me/home')).resolves.toEqual({ connected: true, repo: 'me/home' });
    await expect(w.home.connect('me/agents-only')).resolves.toMatchObject({ connected: true });
    expect(w.saved).toEqual(['me/home', 'me/agents-only']);
    expect(w.writes()).toEqual([]);
  });

  it('refuses a repository without definitions and offers Initialize, storing nothing', async () => {
    const w = world({
      'me/app': { root: PROJECT_ROOT },
      // A file named agents is not the folder.
      'me/odd': { root: [{ path: 'agents', type: 'blob' }] },
    });
    const result = await w.home.connect('me/app');
    expect(result).toMatchObject({ connected: false, state: 'not-home' });
    expect(!result.connected && result.message).toMatch(/no agents\/ or environments\/ folder at its root.*initialize a new Puck home/);
    await expect(w.home.connect('me/odd')).resolves.toMatchObject({ connected: false, state: 'not-home' });
    expect(w.saved).toEqual([]);
  });

  it('calls an empty repository empty, and says to initialize it', async () => {
    const w = world({ 'me/new': { root: null } });
    const result = await w.home.connect('me/new');
    expect(result).toMatchObject({ connected: false, state: 'empty' });
    expect(!result.connected && result.message).toMatch(/is empty.*Initialize it/);
    expect(w.saved).toEqual([]);
  });

  it('explains a repository the sign-in cannot reach', async () => {
    const w = world({});
    await expect(w.home.connect('me/private')).rejects.toThrow(/not reachable with this GitHub sign-in/);
    expect(w.saved).toEqual([]);
  });

  it('reads the root of a default branch whose name has a slash through its commit', async () => {
    const w = world({ 'me/home': { root: HOME_ROOT, defaultBranch: 'release/1' } });
    await expect(w.home.inspect('me/home')).resolves.toMatchObject({ state: 'home' });
    expect(w.requests.map((r) => r.url)).toContain(`${API}/me/home/commits/heads/release/1`);
  });
});

describe('initializing a Puck home', () => {
  it('refuses a repository that has files, writing nothing', async () => {
    const w = world({ 'me/app': { root: PROJECT_ROOT }, 'me/home': { root: HOME_ROOT }, 'me/readme': { root: [{ path: 'README.md', type: 'blob' }] }, 'me/target': { root: PROJECT_ROOT } });
    await expect(w.home.initialize('me/app', 'me/target')).rejects.toThrow(/already has files.*only an empty repository/);
    await expect(w.home.initialize('me/home', 'me/target')).rejects.toThrow(/already holds a Puck home\. Connect it instead/);
    // GitHub's generated README is content too.
    await expect(w.home.initialize('me/readme', 'me/target')).rejects.toThrow(/already has files/);
    expect(w.writes()).toEqual([]);
    expect(w.saved).toEqual([]);
  });

  it('commits the starter home to an empty repository as one root commit, tags v1.0.0, and connects it', async () => {
    const w = world({ 'me/puck-home': { root: null }, 'Acme/Web.App': { root: PROJECT_ROOT, defaultBranch: 'develop' } });
    await expect(w.home.initialize('me/puck-home', 'Acme/Web.App')).resolves.toBe('me/puck-home');
    const writes = w.writes();
    expect(writes.map((r) => `${r.method} ${r.url.replace(`${API}/me/puck-home`, '')}`)).toEqual([
      'PUT /contents/README.md',
      'POST /git/trees',
      'POST /git/commits',
      'PATCH /git/refs/heads/main',
      'POST /git/refs',
    ]);
    const [put, tree, commit, move, tag] = writes.map((r) => JSON.parse(r.body ?? '{}'));
    const files = starterFiles({ fullName: 'Acme/Web.App', defaultBranch: 'develop' });
    expect(Buffer.from(put.content, 'base64').toString('utf8')).toBe(files['README.md']);
    // The whole starter, inline, in one tree.
    const entries = tree.tree as Array<{ path: string; mode: string; type: string; content: string }>;
    expect(entries.map((e) => e.path).sort()).toEqual(Object.keys(files).sort());
    expect(entries.map((e) => e.path).sort()).toEqual([
      '.github/workflows/validate.yml',
      'README.md',
      'agents/implementer.yaml',
      'agents/lead.yaml',
      'agents/reviewer.yaml',
      'environments/web-app.yaml',
      'prompts/lead.md',
      'prompts/reviewer.md',
      'puck.schema.json',
    ]);
    for (const e of entries) expect(e).toEqual({ path: e.path, mode: '100644', type: 'blob', content: files[e.path] });
    expect(commit).toEqual({ message: 'Initialize the Puck home', tree: 't'.repeat(40), parents: [] });
    expect(move).toEqual({ sha: 'd'.repeat(40), force: true });
    expect(tag).toEqual({ ref: `refs/tags/${HOME_TAG}`, sha: 'd'.repeat(40) });
    expect(w.saved).toEqual(['me/puck-home']);
  });

  it('waits out GitHub still calling the repository empty right after the bootstrap commit', async () => {
    const w = world({ 'me/puck-home': { root: null }, 'me/app': { root: PROJECT_ROOT } }, { treeConflicts: 2 });
    await w.home.initialize('me/puck-home', 'me/app');
    expect(w.writes().filter((r) => r.url.endsWith('/git/trees'))).toHaveLength(3);
    expect(w.sleeps).toEqual([1000, 1000]);
    expect(w.saved).toEqual(['me/puck-home']);
  });

  it('finishes an initialize that stopped after its bootstrap commit, without writing the README again', async () => {
    const readme = starterFiles({ fullName: 'me/app', defaultBranch: 'main' })['README.md'];
    const w = world({ 'me/puck-home': { root: [{ path: 'README.md', type: 'blob', sha: gitBlobSha(readme) }] }, 'me/app': { root: PROJECT_ROOT } });
    await expect(w.home.inspect('me/puck-home')).resolves.toMatchObject({ state: 'empty' });
    await w.home.initialize('me/puck-home', 'me/app');
    expect(w.writes().map((r) => r.method)).toEqual(['POST', 'POST', 'PATCH', 'POST']);
    expect(w.saved).toEqual(['me/puck-home']);
  });

  it('says so when GitHub refuses to write the workflow file', async () => {
    const w = world(
      { 'me/puck-home': { root: null }, 'me/app': { root: PROJECT_ROOT } },
      { refError: { status: 422, body: { message: 'refusing to allow a GitHub App to create or update workflow `.github/workflows/validate.yml` without `workflows` permission' } } },
    );
    await expect(w.home.initialize('me/puck-home', 'me/app')).rejects.toThrow(/validation workflow.*workflows permission/);
    expect(w.saved).toEqual([]);
  });

  it('refuses the home itself as the environment repository', async () => {
    const w = world({ 'me/puck-home': { root: null } });
    await expect(w.home.initialize('me/puck-home', 'Me/Puck-Home')).rejects.toThrow(/not on the Puck home itself/);
    expect(w.writes()).toEqual([]);
  });

  it('needs a reachable repository for the environment, before writing anything', async () => {
    const w = world({ 'me/puck-home': { root: null } });
    await expect(w.home.initialize('me/puck-home', 'me/gone')).rejects.toThrow(/me\/gone is not reachable/);
    expect(w.writes()).toEqual([]);
  });
});

describe('gitBlobSha', () => {
  it('is the id git gives a blob', () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});
