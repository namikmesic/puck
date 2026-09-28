import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitHubClient } from '../../src/harness/github';
import {
  blobUrl,
  compareSemver,
  createConfigRepo,
  newestTag,
  parseSemverTag,
  sortTags,
} from '../../src/main/config-repo';
import { blobSha, exampleFiles, type Files } from './definitions-fixtures';
import { fakeGitHub, type Recorded, type Scripted } from './github-fakes';

const API = 'https://api.github.com/repos/acme/config';
const V1 = '1'.repeat(40);
const V2 = '2'.repeat(40);
const MAIN = '3'.repeat(40);

interface Commit {
  files: Files;
  /** Tree sizes that differ from the content (to simulate huge files). */
  sizes?: Record<string, number>;
}

/**
 * A fake GitHub serving a config repo: refs, the commits they point at,
 * recursive trees and raw blobs, all built from file maps.
 */
function fakeConfigRepo(opts: {
  commits: Record<string, Commit>;
  tags?: Record<string, string>;
  branches?: Record<string, string>;
}) {
  const tags = opts.tags ?? {};
  const branches = opts.branches ?? {};
  const blobs = new Map<string, string>();
  for (const c of Object.values(opts.commits)) for (const [p, t] of Object.entries(c.files)) blobs.set(blobSha(p + t), t);

  const handler = (req: Recorded): Scripted => {
    const path = req.url.replace(API, '');
    let m: RegExpExecArray | null;
    if (path === '/tags?per_page=100') {
      return { body: Object.entries(tags).map(([name, sha]) => ({ name, commit: { sha } })) };
    }
    if (path === '/branches?per_page=100') {
      return { body: Object.entries(branches).map(([name, sha]) => ({ name, commit: { sha } })) };
    }
    if ((m = /^\/commits\/(.+)$/.exec(path))) {
      const ref = decodeURIComponent(m[1]);
      const sha = ref.startsWith('tags/')
        ? tags[ref.slice(5)]
        : ref.startsWith('heads/')
          ? branches[ref.slice(6)]
          : Object.keys(opts.commits).find((s) => s.startsWith(ref));
      return sha ? { body: sha } : { status: 404, body: { message: 'No commit found for SHA' } };
    }
    if ((m = /^\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(path))) {
      const c = opts.commits[m[1]];
      if (!c) return { status: 404, body: { message: 'Not Found' } };
      const tree = Object.entries(c.files).map(([p, t]) => ({
        path: p,
        mode: '100644',
        type: 'blob',
        sha: blobSha(p + t),
        size: c.sizes?.[p] ?? Buffer.byteLength(t),
      }));
      return { body: { tree, truncated: false } };
    }
    if ((m = /^\/git\/blobs\/([0-9a-f]{40})$/.exec(path))) {
      const text = blobs.get(m[1]);
      return text === undefined ? { status: 404, body: { message: 'Not Found' } } : { body: text };
    }
    throw new Error(`unexpected request ${req.url}`);
  };
  const gh = fakeGitHub(handler);
  const client = createGitHubClient({ token: async () => 'token', deps: gh.deps });
  return { gh, client };
}

const paths = (reqs: Recorded[]) => reqs.map((r) => r.url.replace(API, ''));

function setup(extra: Partial<Parameters<typeof fakeConfigRepo>[0]> = {}, cacheDir: string | null = null) {
  const files = exampleFiles();
  const fake = fakeConfigRepo({
    commits: { [V1]: { files }, ...extra.commits },
    tags: { 'v1.0.0': V1, 'v0.9.0': V1, 'v1.1.0-rc.1': V1, nightly: V1, ...extra.tags },
    branches: { main: MAIN, ...extra.branches },
  });
  const dir = cacheDir ?? mkdtempSync(join(tmpdir(), 'puck-defs-'));
  const repo = createConfigRepo({ client: () => fake.client, repo: () => 'acme/config', cacheDir: () => dir });
  return { ...fake, repo, dir, files };
}

describe('config repo refs', () => {
  it('lists tags semver-first with the highest release as the default pin', async () => {
    const { repo } = setup();
    const refs = await repo.refs();
    expect(refs.tags.map((t) => t.name)).toEqual(['v1.1.0-rc.1', 'v1.0.0', 'v0.9.0', 'nightly']);
    expect(refs.branches).toEqual([{ name: 'main', sha: MAIN }]);
    expect(refs.defaultTag).toBe('v1.0.0');
  });

  it('resolves tags, branches and commits without letting one shadow another', async () => {
    const { repo, gh } = setup({ tags: { main: V2 } });
    expect(await repo.resolvePin({ kind: 'tag', name: 'v1.0.0' })).toEqual({ kind: 'tag', name: 'v1.0.0', sha: V1 });
    expect(await repo.resolvePin({ kind: 'branch', name: 'main' })).toEqual({ kind: 'branch', name: 'main', sha: MAIN });
    expect(await repo.resolvePin({ kind: 'tag', name: 'main' })).toEqual({ kind: 'tag', name: 'main', sha: V2 });
    expect(await repo.resolvePin({ kind: 'commit', name: V1.slice(0, 7) })).toEqual({ kind: 'commit', name: V1.slice(0, 7), sha: V1 });
    expect(paths(gh.requests)).toEqual(['/commits/tags/v1.0.0', '/commits/heads/main', '/commits/tags/main', `/commits/${V1.slice(0, 7)}`]);
    expect(gh.requests[0].headers.Accept).toBe('application/vnd.github.sha');
  });

  it('explains a missing ref and rejects malformed names before any request', async () => {
    const { repo, gh } = setup();
    await expect(repo.resolvePin({ kind: 'tag', name: 'v9.9.9' })).rejects.toThrow('No tag "v9.9.9" in acme/config.');
    const before = gh.requests.length;
    await expect(repo.resolvePin({ kind: 'branch', name: 'a..b' })).rejects.toThrow(/not a valid branch name/);
    await expect(repo.resolvePin({ kind: 'commit', name: 'xyz' })).rejects.toThrow(/not a commit SHA/);
    expect(gh.requests.length).toBe(before);
  });

  it('needs a config repo', async () => {
    const repo = createConfigRepo({ client: () => setup().client, repo: () => null, cacheDir: () => null });
    await expect(repo.refs()).rejects.toThrow(/Choose a config repo/);
  });
});

describe('definitionsAt', () => {
  it('lists the example environment at a tag, startable, with no errors', async () => {
    const { repo } = setup();
    const listing = await repo.listing({ kind: 'tag', name: 'v1.0.0' });
    expect(listing.repo).toBe('acme/config');
    expect(listing.pin).toEqual({ kind: 'tag', name: 'v1.0.0', sha: V1 });
    expect(listing.sha).toBe(V1);
    expect(listing.errors).toEqual([]);
    expect(listing.environments).toEqual([
      {
        name: 'example',
        path: 'environments/example.yaml',
        description: expect.any(String),
        valid: true,
        startable: true,
        orchestrator: 'lead',
        agents: ['implementer', 'reviewer'],
      },
    ]);
    expect(listing.agents.map((a) => [a.name, a.harness, a.valid])).toEqual([
      ['implementer', 'claude-code', true],
      ['lead', 'claude-code', true],
      ['reviewer', 'claude-code', true],
    ]);
  });

  it('fetches only definition files and the instructions they reference', async () => {
    const { repo, gh } = setup();
    await repo.listing({ kind: 'tag', name: 'v1.0.0' });
    const blobs = gh.requests.filter((r) => r.url.includes('/git/blobs/'));
    expect(blobs).toHaveLength(6); // 3 agents, 1 environment, 2 prompts
    expect(gh.requests.some((r) => r.url.includes('README'))).toBe(false);
  });

  it('caches by SHA in memory and on disk', async () => {
    const { repo, gh, dir, files } = setup();
    await repo.listing({ kind: 'tag', name: 'v1.0.0' });
    const loads = (): number => gh.requests.filter((r) => /\/git\/(trees|blobs)\//.test(r.url)).length;
    const first = loads();
    await repo.listing({ kind: 'branch', name: 'main' }).catch(() => undefined); // another sha: not cached
    gh.requests.length = 0;
    await repo.listing({ kind: 'commit', name: V1 });
    expect(loads()).toBe(0);
    expect(first).toBe(7);

    const cached = JSON.parse(readFileSync(join(dir, `${V1}.json`), 'utf8'));
    expect(cached).toMatchObject({ v: 1, sha: V1 });
    expect(cached.files['prompts/lead.md']).toBe(files['prompts/lead.md']);

    // A fresh instance (the next launch) reads the disk cache.
    const again = setup({}, dir);
    await again.repo.listing({ kind: 'tag', name: 'v1.0.0' });
    expect(again.gh.requests.map((r) => r.url.replace(API, ''))).toEqual(['/commits/tags/v1.0.0']);
  });

  it('ignores a corrupt or foreign cache file', async () => {
    const first = setup();
    await first.repo.listing({ kind: 'tag', name: 'v1.0.0' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(first.dir, `${V1}.json`), JSON.stringify({ v: 1, sha: V2, tree: {}, files: {} }));
    const again = setup({}, first.dir);
    const listing = await again.repo.listing({ kind: 'tag', name: 'v1.0.0' });
    expect(listing.environments).toHaveLength(1);
    expect(again.gh.requests.some((r) => r.url.includes('/git/trees/'))).toBe(true);
  });

  it('never fetches an oversized file and links each error to GitHub', async () => {
    const files = exampleFiles();
    files['agents/lead.yaml'] = files['agents/lead.yaml'].replace('effort: high', 'effort: ludicrous');
    const { repo, gh } = setup({
      commits: { [V2]: { files, sizes: { 'agents/reviewer.yaml': 300 * 1024 } } },
      tags: { 'v2.0.0': V2 },
    });
    const listing = await repo.listing({ kind: 'tag', name: 'v2.0.0' });
    expect(gh.requests.some((r) => r.url.endsWith(blobSha(`agents/reviewer.yaml${files['agents/reviewer.yaml']}`)))).toBe(false);
    expect(listing.errors.map((e) => [e.file, e.rule])).toEqual([
      ['agents/lead.yaml', 'effort'],
      ['agents/reviewer.yaml', 'file.size'],
    ]);
    const line = files['agents/lead.yaml'].split('\n').indexOf('effort: ludicrous') + 1;
    expect(listing.errors[0].url).toBe(`https://github.com/acme/config/blob/${V2}/agents/lead.yaml#L${line}`);
    expect(listing.environments[0]).toMatchObject({ valid: true, startable: false });
  });
});

describe('resolve at a pin', () => {
  it('produces the ResolvedEnvironment with its source', async () => {
    const { repo } = setup();
    const env = await repo.resolve({ kind: 'tag', name: 'v1.0.0' }, 'example');
    expect(env.source).toEqual({ repo: 'acme/config', pin: { kind: 'tag', name: 'v1.0.0', sha: V1 }, path: 'environments/example.yaml' });
    expect(Object.keys(env.agentDefinitions)).toEqual(['lead', 'implementer', 'reviewer']);
  });
});

describe('update checks', () => {
  it('tag pins: a newer release tag', async () => {
    const { repo } = setup({ tags: { 'v1.2.0': V2 } });
    expect(await repo.checkUpdate({ kind: 'tag', name: 'v1.0.0', sha: V1 })).toEqual({
      pin: { kind: 'tag', name: 'v1.2.0', sha: V2 },
    });
    expect(await repo.checkUpdate({ kind: 'tag', name: 'v1.2.0', sha: V2 })).toBeNull();
  });

  it('tag pins: prereleases are offered only to a prerelease pin; other tags never', async () => {
    const { repo } = setup();
    expect(await repo.checkUpdate({ kind: 'tag', name: 'v1.0.0', sha: V1 })).toBeNull();
    expect(await repo.checkUpdate({ kind: 'tag', name: 'v1.1.0-alpha', sha: V1 })).toEqual({
      pin: { kind: 'tag', name: 'v1.1.0-rc.1', sha: V1 },
    });
    expect(await repo.checkUpdate({ kind: 'tag', name: 'nightly', sha: V1 })).toBeNull();
  });

  it('branch pins: the head moved', async () => {
    const { repo } = setup();
    expect(await repo.checkUpdate({ kind: 'branch', name: 'main', sha: V1 })).toEqual({
      pin: { kind: 'branch', name: 'main', sha: MAIN },
    });
    expect(await repo.checkUpdate({ kind: 'branch', name: 'main', sha: MAIN })).toBeNull();
  });

  it('commit pins: never, without a request', async () => {
    const { repo, gh } = setup();
    expect(await repo.checkUpdate({ kind: 'commit', name: V1, sha: V1 })).toBeNull();
    expect(gh.requests).toEqual([]);
  });
});

describe('semver helpers', () => {
  it('parses tags with or without v, and orders prereleases below releases', () => {
    const v = (s: string) => parseSemverTag(s) ?? (() => { throw new Error(s); })();
    expect(parseSemverTag('1.2')).toBeNull();
    expect(parseSemverTag('v01.2.3')).toBeNull();
    expect(compareSemver(v('v1.0.0'), v('1.0.0'))).toBe(0);
    expect(compareSemver(v('1.0.0-rc.1'), v('1.0.0'))).toBeLessThan(0);
    expect(compareSemver(v('1.0.0-rc.2'), v('1.0.0-rc.10'))).toBeLessThan(0);
    expect(compareSemver(v('1.0.0-alpha'), v('1.0.0-alpha.1'))).toBeLessThan(0);
    expect(compareSemver(v('1.0.0-1'), v('1.0.0-alpha'))).toBeLessThan(0);
    expect(compareSemver(v('1.10.0'), v('1.9.9'))).toBeGreaterThan(0);
    expect(compareSemver(v('1.0.0+build.2'), v('1.0.0'))).toBe(0);
  });

  it('sorts and picks the newest', () => {
    const refs = ['x', 'v2.0.0-beta', 'v1.9.0', 'a'].map((name) => ({ name, sha: V1 }));
    expect(sortTags(refs).map((r) => r.name)).toEqual(['v2.0.0-beta', 'v1.9.0', 'a', 'x']);
    expect(newestTag(refs)?.name).toBe('v1.9.0');
    expect(newestTag(refs, true)?.name).toBe('v2.0.0-beta');
    expect(newestTag([{ name: 'x', sha: V1 }])).toBeNull();
  });

  it('builds Open in GitHub links with encoded path segments', () => {
    expect(blobUrl('acme/config', V1, 'prompts/a b.md', 3)).toBe(`https://github.com/acme/config/blob/${V1}/prompts/a%20b.md#L3`);
  });
});
