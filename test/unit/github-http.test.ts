import { describe, expect, it } from 'vitest';
import {
  createGitHubClient,
  createHttpClient,
  GitHubApiError,
  GitHubRateLimitError,
  nextLink,
} from '../../src/harness/github';
import { fakeGitHub, type Scripted } from './github-fakes';

const token = async (): Promise<string> => 'ghu_test';

function client(script: Scripted[] | Parameters<typeof fakeGitHub>[0], maxWaitMs?: number) {
  const gh = fakeGitHub(script);
  return { gh, http: createHttpClient({ token, deps: gh.deps, maxWaitMs }) };
}

describe('GitHub transport', () => {
  it('sends the bearer token, API version and JSON accept header', async () => {
    const { gh, http } = client([{ body: { login: 'octo', id: 1 } }]);
    const res = await http.request('/user');
    expect(res.data).toEqual({ login: 'octo', id: 1 });
    expect(gh.requests[0].url).toBe('https://api.github.com/user');
    expect(gh.requests[0].headers).toMatchObject({
      Authorization: 'Bearer ghu_test',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('waits out retry-after and retries', async () => {
    const { gh, http } = client([
      { status: 429, headers: { 'retry-after': '3' }, body: { message: 'slow down' } },
      { status: 403, headers: { 'retry-after': '2' }, body: { message: 'You have exceeded a secondary rate limit' } },
      { body: { ok: true } },
    ]);
    const res = await http.request('/user');
    expect(res.data).toEqual({ ok: true });
    expect(gh.sleeps).toEqual([3_000, 2_000]);
    expect(gh.requests).toHaveLength(3);
  });

  it('waits until the reset when the budget is spent and the reset is near', async () => {
    const reset = (nowMs: number, inMs: number): string => String(Math.floor((nowMs + inMs) / 1000));
    let first = true;
    const { gh, http } = client((): Scripted => {
      if (first) {
        first = false;
        return {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': reset(1_000_000, 30_000) },
          body: { message: 'API rate limit exceeded' },
        };
      }
      return { body: { ok: true } };
    });
    await http.request('/user');
    expect(gh.sleeps).toHaveLength(1);
    expect(gh.sleeps[0]).toBeGreaterThan(29_000);
    expect(gh.sleeps[0]).toBeLessThanOrEqual(30_000);
  });

  it('fails with the reset time instead of waiting long, then fails fast without a request', async () => {
    const resetAt = Math.floor((1_000_000 + 45 * 60_000) / 1000);
    const { gh, http } = client([
      {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) },
        body: { message: 'API rate limit exceeded' },
      },
    ]);
    const err = await http.request('/user/installations').catch((e) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect(err.resetAt).toBe(resetAt * 1000);
    expect(gh.sleeps).toEqual([]);
    // The spent budget is remembered: the next call throws before fetching.
    await expect(http.request('/user')).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(gh.requests).toHaveLength(1);
    expect(http.rateLimit()).toMatchObject({ remaining: 0, resetAt: resetAt * 1000 });
  });

  it('gives up after the retry budget on a limit that keeps coming back', async () => {
    const { gh, http } = client(() => ({ status: 429, headers: { 'retry-after': '1' }, body: {} }));
    await expect(http.request('/user')).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(gh.requests).toHaveLength(4); // first try + 3 retries
  });

  it('bounds the total wait per request, so an unguided secondary limit waits once, not per retry', async () => {
    const { gh, http } = client(() => ({ status: 403, body: { message: 'You have exceeded a secondary rate limit' } }));
    await expect(http.request('/user')).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(gh.sleeps).toEqual([60_000]);
    expect(gh.requests).toHaveLength(2);
  });

  it('does not treat a permission 403 as a rate limit', async () => {
    const { gh, http } = client([
      { status: 403, headers: { 'x-ratelimit-remaining': '4999' }, body: { message: 'Resource not accessible by integration' } },
    ]);
    const err = await http.request('/repos/o/r').catch((e) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).not.toBeInstanceOf(GitHubRateLimitError);
    expect(err.status).toBe(403);
    expect(err.message).toContain('Resource not accessible by integration');
    expect(gh.sleeps).toEqual([]);
  });

  it('follows Link rel="next" across pages', async () => {
    const { gh, http } = client([
      { body: [{ n: 1 }, { n: 2 }], headers: { link: '<https://api.github.com/repos/me/app/branches?per_page=100&page=2>; rel="next", <https://api.github.com/repos/me/app/branches?per_page=100&page=3>; rel="last"' } },
      { body: [{ n: 3 }], headers: { link: '<https://api.github.com/repos/me/app/branches?per_page=100&page=1>; rel="prev"' } },
    ]);
    const all = await http.paginate<{ n: number }>('/repos/me/app/branches');
    expect(all.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(gh.requests.map((r) => r.url)).toEqual([
      'https://api.github.com/repos/me/app/branches?per_page=100',
      'https://api.github.com/repos/me/app/branches?per_page=100&page=2',
    ]);
  });

  it('parses Link headers', () => {
    expect(nextLink(null)).toBeNull();
    expect(nextLink('<https://x/a?page=4>; rel="last"')).toBeNull();
    expect(nextLink('<https://x/a?page=2>; rel="next"')).toBe('https://x/a?page=2');
  });
});

describe('GitHub endpoints', () => {
  it('lists installation repositories 100 per page from the wrapped shape', async () => {
    const gh = fakeGitHub([{ body: { total_count: 1, repositories: [{ full_name: 'o/cfg', private: true, default_branch: 'main', html_url: 'h' }] } }]);
    const api = createGitHubClient({ token, deps: gh.deps });
    const repos = await api.installationRepos(42);
    expect(repos.map((r) => r.full_name)).toEqual(['o/cfg']);
    expect(gh.requests[0].url).toBe('https://api.github.com/user/installations/42/repositories?per_page=100');
  });

  it('resolves a ref to a sha with the sha media type, keeping slashes in branch names', async () => {
    const gh = fakeGitHub([{ body: 'abc123\n' }]);
    const api = createGitHubClient({ token, deps: gh.deps });
    expect(await api.commitSha('o', 'r', 'feature/x')).toBe('abc123');
    expect(gh.requests[0].url).toBe('https://api.github.com/repos/o/r/commits/feature/x');
    expect(gh.requests[0].headers.Accept).toBe('application/vnd.github.sha');
  });

  it('walks a truncated tree level by level', async () => {
    const gh = fakeGitHub((req): Scripted => {
      if (req.url.endsWith('/git/trees/root?recursive=1')) {
        return { body: { truncated: true, tree: [{ path: 'agents', type: 'tree', sha: 'partial', mode: '040000' }] } };
      }
      if (req.url.endsWith('/git/trees/root')) {
        return {
          body: {
            truncated: false,
            tree: [
              { path: 'agents', type: 'tree', sha: 't-agents', mode: '040000' },
              { path: 'README.md', type: 'blob', sha: 'b-readme', mode: '100644' },
            ],
          },
        };
      }
      if (req.url.endsWith('/git/trees/t-agents')) {
        return { body: { truncated: false, tree: [{ path: 'impl.yaml', type: 'blob', sha: 'b-impl', mode: '100644' }] } };
      }
      return new Error(`unexpected ${req.url}`);
    });
    const api = createGitHubClient({ token, deps: gh.deps });
    const entries = await api.tree('o', 'r', 'root');
    expect(entries.map((e) => [e.path, e.type])).toEqual([
      ['agents', 'tree'],
      ['agents/impl.yaml', 'blob'],
      ['README.md', 'blob'],
    ]);
  });

  it('reads a blob raw and creates a draft pull request', async () => {
    const gh = fakeGitHub([
      { body: 'kind: Agent\n' },
      { status: 201, body: { number: 7, html_url: 'https://github.com/o/r/pull/7', state: 'open', draft: true, head: { ref: 'puck/W-1', sha: 's' }, base: { ref: 'main' } } },
    ]);
    const api = createGitHubClient({ token, deps: gh.deps });
    expect(await api.blob('o', 'r', 'b1')).toBe('kind: Agent\n');
    expect(gh.requests[0].headers.Accept).toBe('application/vnd.github.raw+json');
    const pr = await api.createPull('o', 'r', { title: 't', head: 'puck/W-1', base: 'main', draft: true });
    expect(pr.number).toBe(7);
    expect(gh.requests[1].method).toBe('POST');
    expect(JSON.parse(gh.requests[1].body ?? '{}')).toEqual({ title: 't', head: 'puck/W-1', base: 'main', draft: true });
  });
});
