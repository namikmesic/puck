/**
 * The daemon's GitHub reads and writes for the GitHub workflow: issues and
 * their comments, pull requests with their reviews and review comments,
 * check runs, commit statuses, workflow runs, jobs and job logs.
 *
 * Every poll is a conditional request. The ETag of each URL's last 200
 * answer is kept with its body, so an unchanged resource costs a 304
 * (which GitHub does not count against the rate limit) and the caller
 * still gets the body it had. Polled URLs are stable per resource (a fixed
 * `since`, never the time of the last poll), or the ETags would never hit.
 *
 * Each request uses the installation token the runner supplied for the
 * repository's owner. Everything that comes back is untrusted input: it is
 * stored and shown to agents only through the rules in github-sync.ts, and
 * never logged.
 */

import { createHttpClient, GitHubApiError, type GitHubDeps } from '../harness/github';
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
}

/** A repository's installation token is missing, expired, or does not cover it. */
export class NoGrantError extends Error {}

const CACHE_MAX = 1_000;
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

export class GitHubApi {
  private readonly cache = new Map<string, { etag: string; data: unknown }>();
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

  /** A conditional GET (If-None-Match with the ETag of the last answer). */
  async poll<T>(repo: string, path: string): Promise<Polled<T>> {
    const cached = this.cache.get(path);
    const res = await this.client(repo).request<T>(path, { signal: deadline(), ...(cached ? { ifNoneMatch: cached.etag } : {}) });
    if (res.status === 304 && cached) {
      // Most recently used last, so the oldest entries go first.
      this.cache.delete(path);
      this.cache.set(path, cached);
      return { data: cached.data as T, changed: false };
    }
    const etag = res.headers.get('etag');
    this.cache.delete(path);
    if (etag) {
      this.cache.set(path, { etag, data: res.data });
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
    }
    return { data: res.data, changed: true };
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
    return this.poll(repo, `${repoPath(repo)}/issues?state=open&labels=${seg(label)}&sort=created&direction=asc&per_page=100`);
  }

  issue(repo: string, number: number): Promise<Polled<GhIssue>> {
    return this.poll(repo, `${repoPath(repo)}/issues/${number}`);
  }

  /** Comments updated since `since` (fixed per item, so the URL and its ETag stay stable). */
  issueComments(repo: string, number: number, since: number): Promise<Polled<GhComment[]>> {
    return this.poll(repo, `${repoPath(repo)}/issues/${number}/comments?since=${seg(new Date(since).toISOString())}&per_page=100`);
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
    return this.poll(repo, `${repoPath(repo)}/pulls/${number}/reviews?per_page=100`);
  }

  reviewComments(repo: string, number: number): Promise<Polled<GhReviewComment[]>> {
    return this.poll(repo, `${repoPath(repo)}/pulls/${number}/comments?per_page=100`);
  }

  /** Repository permission for `login`: `admin`, `maintain`, `write`, `triage`, `read` or `none`. */
  collaboratorPermission(repo: string, login: string): Promise<{ permission?: string }> {
    return this.get(repo, `${repoPath(repo)}/collaborators/${seg(login)}/permission`);
  }

  checkRuns(repo: string, sha: string): Promise<Polled<{ check_runs: GhCheckRun[] }>> {
    return this.poll(repo, `${repoPath(repo)}/commits/${seg(sha)}/check-runs?per_page=100`);
  }

  combinedStatus(repo: string, sha: string): Promise<Polled<GhCombinedStatus>> {
    return this.poll(repo, `${repoPath(repo)}/commits/${seg(sha)}/status?per_page=100`);
  }

  async runs(repo: string, sha: string): Promise<GhRun[]> {
    const page = await this.get<{ workflow_runs?: GhRun[] }>(repo, `${repoPath(repo)}/actions/runs?head_sha=${seg(sha)}&per_page=100`);
    return page?.workflow_runs ?? [];
  }

  async jobs(repo: string, runId: number): Promise<GhJob[]> {
    const page = await this.get<{ jobs?: GhJob[] }>(repo, `${repoPath(repo)}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
    return page?.jobs ?? [];
  }

  /** A job's plain-text log (GitHub answers with a short-lived redirect to it). */
  jobLog(repo: string, jobId: number): Promise<string> {
    return this.get<string>(repo, `${repoPath(repo)}/actions/jobs/${jobId}/logs`, { text: true });
  }

  rerunFailedJobs(repo: string, runId: number): Promise<unknown> {
    return this.post(repo, `${repoPath(repo)}/actions/runs/${runId}/rerun-failed-jobs`, {});
  }

  async defaultBranch(repo: string): Promise<string> {
    const r = await this.poll<{ default_branch?: string }>(repo, repoPath(repo));
    return r.data?.default_branch ?? '';
  }

  async searchIssues(repo: string, q: string): Promise<GhIssue[]> {
    const page = await this.get<{ items?: GhIssue[] }>(repo, `/search/issues?q=${seg(q)}&per_page=20`);
    return page?.items ?? [];
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
