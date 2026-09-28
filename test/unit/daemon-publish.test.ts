import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GithubGrant } from '../../src/harness/daemon-protocol';
import { readDefinition } from '../../src/daemon/definition';
import { Git, itemBranch, parseShortstat, pushable, slugify } from '../../src/daemon/git';
import { nullLogger } from '../../src/daemon/log';
import { askpassScript } from '../../src/daemon/provision';
import { Publisher, PublishError } from '../../src/daemon/publish';
import type { ItemRecord } from '../../src/daemon/store/items';
import { exampleDefinition, fakeRunner, tempRoot, type RecordedCommand } from './daemon-fakes';

// Publishing moves commits from an agent-writable worktree to GitHub
// through a root-owned mirror. Pin who runs what: git runs as puck in the
// worktree, root runs git only in the mirror with hooks off, commits cross
// as a bundle written from stdout by the daemon, and only puck/* branches
// are ever pushed.

const BASE = 'b'.repeat(40);
const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const PUCK = { uid: 10001, gid: 10001 };

let root: ReturnType<typeof tempRoot>;
let calls: RecordedCommand[];
let head: string;
let dirty: string;
let commits: string;
let grant: GithubGrant | null;
let requests: Array<{ method: string; url: string; body: unknown; auth: string | null }>;
let pulls: Array<{ number: number; html_url: string; draft: boolean; head: { ref: string } }>;

const def = (() => {
  const r = readDefinition(exampleDefinition());
  if (!r.ok) throw new Error(r.error);
  return r.value;
})();

function publisher(now = 1_000) {
  const fake = fakeRunner((argv) => {
    const sub = argv[0] === 'git' && argv[1] === '-C' ? argv[3] : '';
    if (sub === 'log') return { stdout: commits };
    if (sub === 'diff' && argv.includes('--shortstat')) return { stdout: ' 2 files changed, 10 insertions(+), 3 deletions(-)\n' };
    if (sub === 'diff') return { stdout: ' a.txt | 8 ++++\n b.txt | 5 +++--\n 2 files changed\n' };
    if (sub === 'status') return { stdout: dirty };
    if (sub === 'rev-parse') return { stdout: `${head}\n` };
    return undefined;
  });
  calls = fake.calls;
  const git = new Git({ paths: root.paths, run: fake.run, asPuck: PUCK });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, body, auth: new Headers(init?.headers).get('authorization') });
    if (method === 'GET') return new Response(JSON.stringify(pulls.filter(() => url.includes('head=octo%3Apuck%2FW-4-fix-login-redirect'))), { status: 200 });
    if (method === 'POST') {
      const pr = { number: 7, html_url: 'https://github.com/octo/app/pull/7', draft: body.draft, head: { ref: body.head } };
      pulls.push(pr);
      return new Response(JSON.stringify(pr), { status: 201 });
    }
    return new Response(JSON.stringify({ ...pulls[0], body: body.body }), { status: 200 });
  };
  return new Publisher({
    git,
    tmpDir: path.join(root.paths.state, 'tmp'),
    grantFor: (owner) => (grant && grant.owner === owner ? grant : null),
    definition: () => def,
    envName: () => 'Example',
    apiBase: 'https://api.test',
    fetch: fetchFn,
    log: nullLogger,
    now: () => now,
  });
}

function reviewItem(over: Partial<ItemRecord> = {}): ItemRecord {
  return {
    id: 'itm_01J0000000000000000000000A',
    number: 4,
    title: 'Fix login redirect',
    body: '',
    status: 'review',
    agent: 'implementer',
    repo: 'app',
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 1,
    attempts: 1,
    sessionId: 'ses_01J0000000000000000000000A',
    branch: 'puck/W-4-fix-login-redirect',
    worktree: path.join(root.paths.workspace, '.puck', 'worktrees', 'W-4'),
    base: { branch: 'main', sha: BASE },
    result: {
      summary: 'Fixed the redirect.',
      commits: [],
      diffStat: { files: 2, insertions: 10, deletions: 3, text: ' a.txt | 8 ++++' },
      uncommitted: [],
      interrupted: false,
      endedAt: 1,
    },
    pr: null,
    lastError: null,
    pendingAsk: null,
    requeue: null,
    pushedSha: null,
    ...over,
  };
}

beforeEach(() => {
  root = tempRoot('pd-pub-');
  head = HEAD1;
  dirty = '';
  commits = `${HEAD1}\tFix the redirect\n`;
  grant = { owner: 'octo', installationId: 9, repos: ['octo/app'], token: 'ghs_octotoken', expiresAt: 10_000_000 };
  requests = [];
  pulls = [];
});
afterEach(() => root.cleanup());

describe('publishing', () => {
  it('runs git as puck in the worktree and as root only in the mirror, hooks off, via a bundle on stdout', async () => {
    const item = reviewItem();
    let pushed: string | null = null;
    const out = await publisher().publish(item, {}, (sha) => (pushed = sha));
    expect(pushed).toBe(HEAD1);
    expect(out).toEqual({ pr: { number: 7, url: 'https://github.com/octo/app/pull/7', draft: true, lastPushedSha: HEAD1 }, created: true });

    const worktree = defined(item.worktree);
    const mirror = path.join(root.paths.mirrors, 'app.git');
    for (const c of calls) {
      const asPuck = c.opts.uid === 10001;
      if (asPuck) {
        expect(c.opts.gid).toBe(10001);
        expect(c.argv.slice(0, 3)).toEqual(['git', '-C', worktree]);
        expect(c.opts.env?.HOME).toBe(root.paths.home);
      } else {
        expect(c.opts.uid).toBeUndefined();
        expect(c.argv.slice(0, 5)).toEqual(['git', '-c', 'core.hooksPath=/dev/null', '-C', mirror]);
        expect(c.opts.env).toMatchObject({ GIT_ASKPASS: path.join(root.paths.bin, 'git-askpass'), GIT_TERMINAL_PROMPT: '0', PUCK_GIT_OWNER: 'octo' });
      }
    }
    const bundle = defined(calls.find((c) => c.argv.includes('bundle')));
    expect(bundle.opts.uid).toBe(10001);
    expect(bundle.argv).toEqual(['git', '-C', worktree, 'bundle', 'create', '-', `${BASE}..refs/heads/puck/W-4-fix-login-redirect`]);
    expect(bundle.opts.stdoutTo).toBe(path.join(root.paths.state, 'tmp', 'W-4.bundle'));

    const rootCalls = calls.filter((c) => c.opts.uid === undefined).map((c) => c.argv.slice(5));
    expect(rootCalls).toEqual([
      [
        'fetch',
        path.join(root.paths.state, 'tmp', 'W-4.bundle'),
        '+refs/heads/puck/W-4-fix-login-redirect:refs/heads/puck/W-4-fix-login-redirect',
      ],
      [
        '-c',
        'remote.origin.mirror=false',
        'push',
        '--porcelain',
        '--force-with-lease=refs/heads/puck/W-4-fix-login-redirect:',
        'origin',
        'refs/heads/puck/W-4-fix-login-redirect:refs/heads/puck/W-4-fix-login-redirect',
      ],
    ]);
    // The temporary bundle is gone again.
    expect(fs.existsSync(path.join(root.paths.state, 'tmp', 'W-4.bundle'))).toBe(false);
  });

  it('opens a draft pull request the first time and updates it after a follow-up, leased on the last push', async () => {
    const item = reviewItem();
    const first = await publisher().publish(item, {}, (sha) => (item.pushedSha = sha));
    item.pr = first.pr;
    expect(requests.map((r) => r.method)).toEqual(['GET', 'POST']);
    expect(requests[0].url).toBe('https://api.test/repos/octo/app/pulls?head=octo%3Apuck%2FW-4-fix-login-redirect&state=open&per_page=100');
    expect(requests[1].body).toEqual({
      title: 'W-4: Fix login redirect',
      head: 'puck/W-4-fix-login-redirect',
      base: 'main',
      draft: true,
      body: 'Fixed the redirect.\n\n```\n a.txt | 8 ++++\n```\n\nWork item W-4 in Puck environment Example.',
    });
    expect(requests.every((r) => r.auth === 'Bearer ghs_octotoken')).toBe(true);

    head = HEAD2;
    commits = `${HEAD2}\tAddress review\n${HEAD1}\tFix the redirect\n`;
    requests = [];
    const second = await publisher().publish(item, { title: 'Better title' });
    expect(second.created).toBe(false);
    expect(second.pr.lastPushedSha).toBe(HEAD2);
    expect(requests.map((r) => r.method)).toEqual(['GET', 'PATCH']);
    expect(requests[1].url).toBe('https://api.test/repos/octo/app/pulls/7');
    expect(requests[1].body).toMatchObject({ title: 'Better title' });
    const push = defined(calls.find((c) => c.argv.includes('push')));
    expect(push.argv).toContain(`--force-with-lease=refs/heads/puck/W-4-fix-login-redirect:${HEAD1}`);
  });

  it('refuses uncommitted work, an empty branch, and items not in review, before touching the mirror', async () => {
    dirty = ' M src/a.ts\n?? notes.txt\n';
    await expect(publisher().publish(reviewItem())).rejects.toThrow(/uncommitted changes \(2 files\)/);
    dirty = '';
    commits = '';
    await expect(publisher().publish(reviewItem())).rejects.toThrow(/no commits beyond main/);
    await expect(publisher().publish(reviewItem({ status: 'running' }))).rejects.toThrow(/running; publish it once it is in review/);
    expect(calls.some((c) => c.opts.uid === undefined)).toBe(false);
    expect(requests).toEqual([]);
  });

  it('needs a current grant for the repository owner; it never refreshes one itself', async () => {
    grant = null;
    await expect(publisher().publish(reviewItem())).rejects.toThrow(/no GitHub access for octo/);
    grant = { owner: 'octo', installationId: 9, repos: ['octo/app'], token: 'ghs_x', expiresAt: 500 };
    await expect(publisher(1_000).publish(reviewItem())).rejects.toThrow(/expired/);
    grant = { owner: 'octo', installationId: 9, repos: ['octo/other'], token: 'ghs_x', expiresAt: 5_000 };
    await expect(publisher().publish(reviewItem())).rejects.toThrow(/does not include octo\/app/);
    expect(calls).toEqual([]);
  });

  it('pushes only puck/* branches', async () => {
    await expect(publisher().publish(reviewItem({ branch: 'main' }))).rejects.toThrow(PublishError);
    const git = new Git({ paths: root.paths, run: fakeRunner().run, asPuck: PUCK });
    await expect(git.push('app', 'octo/app', 'main', null)).rejects.toThrow(/only puck\/\* branches/);
    await expect(git.push('app', 'octo/app', 'puck/W-1-x', 'not-a-sha')).rejects.toThrow(/Invalid lease/);
    await expect(git.fetchBundle('app', 'octo/app', '/tmp/x.bundle', 'refs/heads/main')).rejects.toThrow(/only puck/);
    expect(['puck/W-1', 'puck/W-12-fix-it'].map(pushable)).toEqual([true, true]);
    expect(['main', 'puck/other', 'puck/W-1-../x', 'puck/W-x', '-puck/W-1'].map(pushable)).toEqual([false, false, false, false, false]);
  });
});

describe('push rejections', () => {
  it('names a lease failure plainly', async () => {
    const run = fakeRunner((argv) =>
      argv.includes('push')
        ? { code: 1, stdout: 'To file:///srv/git/octo/app.git\n!\trefs/heads/puck/W-1:refs/heads/puck/W-1\t[rejected] (stale info)\nDone\n', stderr: 'error: failed to push some refs' }
        : undefined,
    ).run;
    const git = new Git({ paths: root.paths, run, asPuck: PUCK });
    await expect(git.push('app', 'octo/app', 'puck/W-1', HEAD1)).rejects.toThrow(
      'GitHub refused the push of puck/W-1 (stale info): the branch changed on GitHub since Puck last pushed it.',
    );
  });
});

describe('branch names and diff stats', () => {
  it('slugs titles into puck/W-<n>-<slug>, at most 40 characters of slug', () => {
    expect(itemBranch(4, 'Fix login redirect!')).toBe('puck/W-4-fix-login-redirect');
    expect(slugify('  Ünïcode & spaces -- here  ')).toBe('n-code-spaces-here');
    expect(slugify('x'.repeat(60))).toHaveLength(40);
    expect(itemBranch(2, '!!!')).toBe('puck/W-2');
    expect(pushable(itemBranch(3, 'A'.repeat(80) + ' tail'))).toBe(true);
  });

  it('parses git diff --shortstat', () => {
    expect(parseShortstat(' 3 files changed, 120 insertions(+), 30 deletions(-)')).toEqual({ files: 3, insertions: 120, deletions: 30 });
    expect(parseShortstat(' 1 file changed, 1 deletion(-)')).toEqual({ files: 1, insertions: 0, deletions: 1 });
    expect(parseShortstat('')).toEqual({ files: 0, insertions: 0, deletions: 0 });
  });
});

describe('git-askpass', () => {
  it('answers with the token of the owner named on the git command', () => {
    fs.mkdirSync(root.paths.secrets, { recursive: true });
    fs.writeFileSync(
      path.join(root.paths.secrets, 'github.json'),
      JSON.stringify({
        grants: [
          { owner: 'octo', installationId: 1, repos: ['octo/app'], token: 'ghs_octo', expiresAt: 9 },
          { owner: 'Acme', installationId: 2, repos: ['Acme/web'], token: 'ghs_acme', expiresAt: 9 },
        ],
      }),
    );
    const script = path.join(root.root, 'askpass.sh');
    fs.writeFileSync(script, askpassScript(root.paths), { mode: 0o755 });
    const ask = (prompt: string, owner: string): string =>
      execFileSync('sh', [script, prompt], { env: { PATH: process.env.PATH ?? '', PUCK_GIT_OWNER: owner } }).toString();
    expect(ask("Username for 'https://github.com': ", 'octo')).toBe('x-access-token\n');
    expect(ask("Password for 'https://x-access-token@github.com': ", 'octo')).toBe('ghs_octo');
    expect(ask("Password for 'https://x-access-token@github.com': ", 'acme')).toBe('ghs_acme');
    expect(ask("Password for 'https://x-access-token@github.com': ", 'nobody')).toBe('');
  });
});

function defined<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error('expected a value');
  return v;
}
