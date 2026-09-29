/**
 * The daemon's GitHub reads and writes for the GitHub workflow: issues and
 * their comments, pull requests with their reviews and review comments,
 * check runs, commit statuses, workflow runs, jobs and job logs, and
 * re-running a workflow run's failed jobs.
 *
 * Every poll is a conditional request on its first page. The ETag of that
 * URL's last 200 answer is kept with the body, so an unchanged resource
 * costs a 304 (which GitHub does not count against the rate limit) and the
 * caller still gets the body it had. A list keeps every page: the first
 * page is the conditional request, and Link rel="next" is followed for the
 * rest. After a 304 the tail is read again when that response's Link has
 * rel="next", a next link was already stored, or the cached first page is
 * full, because a new row past a full page does not change that page's ETag.
 * Polled URLs are stable per resource (a fixed `since`, never the time of
 * the last poll), or the ETags would never hit. A check or status list that
 * is still short of the full set is incomplete and is never reported as
 * success. Search stops at 1,000 hits, which is all GitHub will serve.
 *
 * Each request uses the installation token the runner supplied for the
 * repository's owner. Everything that comes back is untrusted input: it is
 * stored and shown to agents only through the rules in github-sync.ts, and
 * never logged.
 */

import { createHttpClient, GitHubApiError, nextLink, type GitHubDeps, type HttpClient } from '../harness/github';
import type { GithubGrant } from '../harness/daemon-protocol';

export interface GhUserRef {
  login: string;
  type?: string;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
  updated_at: string;
  labels: Array<{ name?: string } | string>;
  /** Present when the "issue" is a pull request (the issues API lists both). */
  pull_request?: unknown;
  user: GhUserRef | null;
}

export interface GhComment {
  id: number;
  body: string | null;
  user: GhUserRef | null;
  author_association: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface GhReview {
  id: number;
  body: string | null;
  user: GhUserRef | null;
  author_association: string;
  state: string;
  submitted_at?: string | null;
  html_url: string;
}

export interface GhReviewComment extends GhComment {
  path: string;
  line: number | null;
  original_line?: number | null;
  diff_hunk: string;
  in_reply_to_id?: number;
  pull_request_review_id: number | null;
}

export interface GhPullState {
  number: number;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at: string | null;
  draft?: boolean;
  html_url: string;
  head: { sha: string; ref: string };
}

export interface GhCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  details_url?: string | null;
  output?: { title?: string | null; summary?: string | null };
  started_at?: string | null;
}

export interface GhCombinedStatus {
  state: string;
  total_count: number;
  statuses: Array<{ context: string; state: string; target_url: string | null; description: string | null }>;
}

export interface GhRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
}

export interface GhJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
}

/** The body of a GET and whether it changed since the last answer for the same URL. */
export interface Polled<T> {
  data: T;
  changed: boolean;
  /** A list that stopped short of the full set. Callers must not treat it as complete. */
  incomplete?: boolean;
}

/** A repository's installation token is missing, expired, or does not cover it. */
export class NoGrantError extends Error {}

const CACHE_MAX = 1_000;
const LIST_PAGE = 100;
/** GitHub search serves at most 1,000 hits; the next page is a 422. */
const SEARCH_PAGES = 10;
/** No single GitHub request may hold up a poll pass or a dispatch for longer. */
export const REQUEST_TIMEOUT_MS = 30_000;
const deadline = (): AbortSignal => AbortSignal.timeout(REQUEST_TIMEOUT_MS);
const seg = (s: string): string => encodeURIComponent(s);

export function repoPath(repo: string): string {
  const [owner, name] = repo.split('/');
  return `/repos/${seg(owner)}/${seg(name)}`;
}

export interface GitHubApiDeps {
  grantFor(owner: string): GithubGrant | null;
  apiBase?: string;
  fetch?: GitHubDeps['fetch'];
  now?: () => number;
}

interface CacheEntry {
  etag: string;
  data: unknown;
  /** First page of a list, so a 304 can be combined with a fresh tail. */
  head?: unknown;
  next?: string | null;
  total?: number | null;
  incomplete?: boolean;
}

const asArray = <T>(page: unknown): T[] => (Array.isArray(page) ? (page as T[]) : []);

function followingPage(path: string): string {
  const q = path.indexOf('?');
  const params = new URLSearchParams(q === -1 ? '' : path.slice(q + 1));
  const current = Number(params.get('page') ?? '1');
  params.set('page', String(Number.isFinite(current) && current >= 1 ? current + 1 : 2));
  return `${q === -1 ? path : path.slice(0, q)}?${params.toString()}`;
}
const totalCount = (page: unknown): number | null => {
  const n = (page as { total_count?: unknown } | null)?.total_count;
  return typeof n === 'number' ? n : null;
};
const shortOf = (total: number | null | undefined, length: number): boolean => typeof total === 'number' && length < total;

export class GitHubApi {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly now: () => number;

  constructor(private readonly deps: GitHubApiDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The usable grant for `owner/name`, or NoGrantError saying why not. */
  grant(repo: string): GithubGrant {
    const owner = repo.split('/')[0];
    const grant = this.deps.grantFor(owner);
    if (!grant) throw new NoGrantError(`This environment has no GitHub access for ${owner} yet; its runner supplies it.`);
    if (grant.expiresAt <= this.now()) throw new NoGrantError(`The GitHub access for ${owner} expired; the runner supplies a new token.`);
    if (grant.repos.length && !grant.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) {
      throw new NoGrantError(`The GitHub access for ${owner} does not include ${repo}.`);
    }
    return grant;
  }

  private client(repo: string) {
    const grant = this.grant(repo);
    return createHttpClient({
      token: async () => grant.token,
      apiBase: this.deps.apiBase,
      maxWaitMs: 5_000,
      ...(this.deps.fetch ? { deps: { fetch: this.deps.fetch } } : {}),
    });
  }

  /** Most recently used last, so the oldest entries go first. */
  private remember(path: string, entry: CacheEntry): void {
    this.cache.delete(path);
    this.cache.set(path, entry);
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
  }

  /** A conditional GET (If-None-Match with the ETag of the last answer). */
  async poll<T>(repo: string, path: string): Promise<Polled<T>> {
    const cached = this.cache.get(path);
    const res = await this.client(repo).request<T>(path, { signal: deadline(), ...(cached ? { ifNoneMatch: cached.etag } : {}) });
    if (res.status === 304 && cached) {
      this.remember(path, cached);
      return { data: cached.data as T, changed: false };
    }
    const etag = res.headers.get('etag');
    if (etag) this.remember(path, { etag, data: res.data });
    else this.cache.delete(path);
    return { data: res.data, changed: true };
  }

  /**
   * A list. The first page is a conditional GET; further pages follow Link.
   * After a 304 the tail is read again when a next link is present or the
   * cached first page is full.
   */
  private async pollList<T>(
    repo: string,
    path: string,
    pick: (page: unknown) => T[] = asArray,
    totalOf: (page: unknown) => number | null = () => null,
  ): Promise<Polled<T[]>> {
    const client = this.client(repo);
    const signal = deadline();
    const sep = path.includes('?') ? '&' : '?';
    const firstPath = /[?&]per_page=/.test(path) ? path : `${path}${sep}per_page=${LIST_PAGE}`;
    const cached = this.cache.get(firstPath);
    const res = await client.request<unknown>(firstPath, { signal, ...(cached ? { ifNoneMatch: cached.etag } : {}) });
    if (res.status === 304 && cached) {
      this.remember(firstPath, cached);
      const from304 = nextLink(res.headers.get('link'));
      const head = Array.isArray(cached.head) ? (cached.head as T[]) : [];
      const full = head.length === LIST_PAGE;
      const follow = from304 ?? cached.next ?? (full ? followingPage(firstPath) : null);
      if (!follow) return { data: cached.data as T[], changed: false, incomplete: cached.incomplete };
      const tail = await this.rest<T>(client, follow, pick, signal);
      if (tail.items.length === 0 && !from304 && !cached.next) {
        return { data: cached.data as T[], changed: false, incomplete: cached.incomplete };
      }
      const items = [...head, ...tail.items];
      const incomplete = tail.truncated || shortOf(cached.total, items.length);
      cached.data = items;
      cached.incomplete = incomplete;
      if (from304) cached.next = from304;
      else if (!cached.next && tail.items.length > 0) cached.next = follow;
      return { data: items, changed: true, incomplete };
    }
    const head = pick(res.data);
    const total = totalOf(res.data);
    const next = nextLink(res.headers.get('link'));
    const tail = next ? await this.rest<T>(client, next, pick, signal) : { items: [] as T[], truncated: false };
    const items = [...head, ...tail.items];
    const incomplete = tail.truncated || shortOf(total, items.length);
    const etag = res.headers.get('etag');
    if (etag) this.remember(firstPath, { etag, data: items, head, next, total, incomplete });
    else this.cache.delete(firstPath);
    return { data: items, changed: true, incomplete };
  }

  private async rest<T>(
    client: HttpClient,
    next: string,
    pick: (page: unknown) => T[],
    signal: AbortSignal,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const truncated = { value: false };
    const items = await client.paginate<T>(next, pick, { maxPages: 19, signal, truncated });
    return { items, truncated: truncated.value };
  }

  async get<T>(repo: string, path: string, opts: { text?: boolean } = {}): Promise<T> {
    return (await this.client(repo).request<T>(path, { signal: deadline(), ...(opts.text ? { text: true } : {}) })).data;
  }

  async post<T>(repo: string, path: string, body: unknown): Promise<T> {
    return (await this.client(repo).request<T>(path, { method: 'POST', body, signal: deadline() })).data;
  }

  async patch<T>(repo: string, path: string, body: unknown): Promise<T> {
    return (await this.client(repo).request<T>(path, { method: 'PATCH', body, signal: deadline() })).data;
  }

  /* ---------- Endpoints ---------- */

  openIssuesLabelled(repo: string, label: string): Promise<Polled<GhIssue[]>> {
    return this.pollList(repo, `${repoPath(repo)}/issues?state=open&labels=${seg(label)}&sort=created&direction=asc`);
  }

  issue(repo: string, number: number): Promise<Polled<GhIssue>> {
    return this.poll(repo, `${repoPath(repo)}/issues/${number}`);
  }

  /** Comments updated since `since` (fixed per item, so the URL and its ETag stay stable). */
  issueComments(repo: string, number: number, since: number): Promise<Polled<GhComment[]>> {
    return this.pollList(repo, `${repoPath(repo)}/issues/${number}/comments?since=${seg(new Date(since).toISOString())}`);
  }

  createIssueComment(repo: string, number: number, body: string): Promise<GhComment> {
    return this.post(repo, `${repoPath(repo)}/issues/${number}/comments`, { body });
  }

  updateIssueComment(repo: string, id: number, body: string): Promise<GhComment> {
    return this.patch(repo, `${repoPath(repo)}/issues/comments/${id}`, { body });
  }

  pull(repo: string, number: number): Promise<Polled<GhPullState>> {
    return this.poll(repo, `${repoPath(repo)}/pulls/${number}`);
  }

  reviews(repo: string, number: number): Promise<Polled<GhReview[]>> {
    return this.pollList(repo, `${repoPath(repo)}/pulls/${number}/reviews`);
  }

  reviewComments(repo: string, number: number): Promise<Polled<GhReviewComment[]>> {
    return this.pollList(repo, `${repoPath(repo)}/pulls/${number}/comments`);
  }

  /** Repository permission for `login`: `admin`, `maintain`, `write`, `triage`, `read` or `none`. */
  collaboratorPermission(repo: string, login: string): Promise<{ permission?: string }> {
    return this.get(repo, `${repoPath(repo)}/collaborators/${seg(login)}/permission`);
  }

  checkRuns(repo: string, sha: string): Promise<Polled<GhCheckRun[]>> {
    return this.pollList(
      repo,
      `${repoPath(repo)}/commits/${seg(sha)}/check-runs`,
      (page) => asArray<GhCheckRun>((page as { check_runs?: GhCheckRun[] } | null)?.check_runs),
      totalCount,
    );
  }

  async combinedStatus(repo: string, sha: string): Promise<Polled<GhCombinedStatus>> {
    const polled = await this.pollList(
      repo,
      `${repoPath(repo)}/commits/${seg(sha)}/status`,
      (page) => asArray<GhCombinedStatus['statuses'][number]>((page as GhCombinedStatus | null)?.statuses),
      totalCount,
    );
    const statuses = polled.data;
    const state = statuses.some((s) => s.state === 'failure' || s.state === 'error')
      ? 'failure'
      : statuses.some((s) => s.state === 'pending')
        ? 'pending'
        : statuses.length
          ? 'success'
          : 'pending';
    return { ...polled, data: { state, total_count: statuses.length, statuses } };
  }

  runs(repo: string, sha: string): Promise<GhRun[]> {
    return this.list(repo, `${repoPath(repo)}/actions/runs?head_sha=${seg(sha)}`, (page) =>
      asArray<GhRun>((page as { workflow_runs?: GhRun[] } | null)?.workflow_runs),
    );
  }

  jobs(repo: string, runId: number): Promise<GhJob[]> {
    return this.list(repo, `${repoPath(repo)}/actions/runs/${runId}/jobs?filter=latest`, (page) =>
      asArray<GhJob>((page as { jobs?: GhJob[] } | null)?.jobs),
    );
  }

  /** A job's plain-text log (GitHub answers with a short-lived redirect to it). */
  jobLog(repo: string, jobId: number): Promise<string> {
    return this.get<string>(repo, `${repoPath(repo)}/actions/jobs/${jobId}/logs`, { text: true });
  }

  /** Re-run a completed workflow run's failed jobs and the jobs that depend on them (Actions write). */
  async rerunFailedJobs(repo: string, runId: number): Promise<void> {
    await this.post(repo, `${repoPath(repo)}/actions/runs/${runId}/rerun-failed-jobs`, {});
  }

  searchIssues(repo: string, q: string): Promise<GhIssue[]> {
    return this.client(repo).paginate(`/search/issues?q=${seg(q)}&per_page=${LIST_PAGE}`, (page) => asArray<GhIssue>((page as { items?: GhIssue[] } | null)?.items), {
      maxPages: SEARCH_PAGES,
      signal: deadline(),
    });
  }

  private list<T>(repo: string, path: string, pick: (page: unknown) => T[]): Promise<T[]> {
    return this.client(repo).paginate(path, pick, { signal: deadline() });
  }
}

/** True for a GitHub answer that says the resource is gone (deleted comment, transferred issue). */
export function isGone(err: unknown): boolean {
  return err instanceof GitHubApiError && (err.status === 404 || err.status === 410);
}

/** `owner/name#n`, the reference GitHub links across repositories. */
export function issueRef(repo: string, number: number): string {
  return `${repo}#${number}`;
}
