/**
 * The GitHub REST transport: global fetch only (no node:* imports), so the
 * app and the code running inside environments share it. It honors GitHub's
 * rate limits - `retry-after` and `x-ratelimit-*` - by waiting when the wait
 * is short and failing with GitHubRateLimitError (carrying the reset time)
 * when it is not, so a UI call never hangs for the rest of the hour. The
 * primary limit (5,000 requests per hour) is shared by all of a user's
 * tokens, so the last-seen budget is remembered per client and an exhausted
 * budget fails fast without spending a request.
 *
 * Conditional GETs: with `ifNoneMatch` a 304 answer comes back as a result
 * with `status: 304` and no data (GitHub does not count it against the
 * primary limit), so a poller can keep the body it already has.
 */

export const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** Injectable effects: tests drive fetch, time and waiting. */
export interface GitHubDeps {
  fetch: typeof fetch;
  /** Resolves after `ms`, or rejects with an AbortError once `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
}

export function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

export const defaultDeps: GitHubDeps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  now: () => Date.now(),
};

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

/** Rate limited beyond what is worth waiting for; retry after `resetAt` (epoch ms). */
export class GitHubRateLimitError extends GitHubApiError {
  constructor(
    readonly resetAt: number,
    path: string,
    status = 429,
  ) {
    super(`GitHub rate limit reached; try again after ${new Date(resetAt).toLocaleTimeString()}.`, status, path);
    this.name = 'GitHubRateLimitError';
  }
}

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  /** Epoch ms when the window resets. */
  resetAt: number | null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  /** Accept header; JSON by default. A non-JSON media type returns the body text. */
  accept?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** An ETag from an earlier answer: a 304 then returns `status: 304` and null data. */
  ifNoneMatch?: string;
  /** Return the body as text whatever its media type (job logs are plain text). */
  text?: boolean;
}

export interface GitHubResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export interface HttpClientOptions {
  /** The bearer token for each request (refreshed by the caller when stale). */
  token(): Promise<string>;
  deps?: Partial<GitHubDeps>;
  apiBase?: string;
  /** Longest total rate-limit wait per request before failing instead (default 60 s). */
  maxWaitMs?: number;
  /** Rate-limit retries per request (default 3). */
  maxRetries?: number;
}

export interface HttpClient {
  request<T>(path: string, opts?: RequestOptions): Promise<GitHubResponse<T>>;
  /** Every page of a list endpoint (per_page=100, following Link rel="next"). */
  paginate<T>(path: string, pick?: (page: unknown) => T[], opts?: PaginateOptions): Promise<T[]>;
  rateLimit(): RateLimitState;
}

const JSON_MEDIA = 'application/vnd.github+json';
const LIST_PAGE = 100;

export interface PaginateOptions {
  maxPages?: number;
  signal?: AbortSignal;
  /** Set when the page cap stops the walk while GitHub still offers another page. */
  truncated?: { value: boolean };
}

function withPerPage(path: string): string {
  if (/[?&]per_page=/.test(path)) return path;
  return `${path}${path.includes('?') ? '&' : '?'}per_page=${LIST_PAGE}`;
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** `<https://api.github.com/...?page=2>; rel="next", ...` → the next URL. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

function errorMessage(body: unknown, text: string): string {
  if (typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string') {
    return (body as { message: string }).message;
  }
  return text.slice(0, 200);
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const deps: GitHubDeps = { ...defaultDeps, ...opts.deps };
  const base = opts.apiBase ?? API_BASE;
  const maxWaitMs = opts.maxWaitMs ?? 60_000;
  const maxRetries = opts.maxRetries ?? 3;
  const rate: RateLimitState = { limit: null, remaining: null, resetAt: null };

  function record(headers: Headers): void {
    const limit = headerNumber(headers, 'x-ratelimit-limit');
    const remaining = headerNumber(headers, 'x-ratelimit-remaining');
    const reset = headerNumber(headers, 'x-ratelimit-reset');
    if (limit !== null) rate.limit = limit;
    if (remaining !== null) rate.remaining = remaining;
    if (reset !== null) rate.resetAt = reset * 1000;
  }

  /** Wait (ms) a rate-limited response asks for, or null when it is not a rate limit. */
  function rateLimitWait(status: number, headers: Headers, message: string): number | null {
    const retryAfter = headerNumber(headers, 'retry-after');
    const exhausted = headerNumber(headers, 'x-ratelimit-remaining') === 0;
    const limited = status === 429 || (status === 403 && (retryAfter !== null || exhausted || /rate limit/i.test(message)));
    if (!limited) return null;
    if (retryAfter !== null) return retryAfter * 1000;
    const reset = headerNumber(headers, 'x-ratelimit-reset');
    if (exhausted && reset !== null) return Math.max(0, reset * 1000 - deps.now());
    // A secondary limit without guidance: GitHub asks for at least a minute.
    return 60_000;
  }

  async function request<T>(path: string, ro: RequestOptions = {}): Promise<GitHubResponse<T>> {
    const url = path.startsWith('https://') ? path : `${base}${path}`;
    const accept = ro.accept ?? JSON_MEDIA;
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      // A budget known to be spent fails (or waits) without another request.
      if (rate.remaining === 0 && rate.resetAt !== null && rate.resetAt > deps.now()) {
        const wait = rate.resetAt - deps.now();
        if (waited + wait > maxWaitMs) throw new GitHubRateLimitError(rate.resetAt, path);
        await deps.sleep(wait, ro.signal);
        waited += wait;
        rate.remaining = null;
      }
      const token = await opts.token();
      const res = await deps.fetch(url, {
        method: ro.method ?? 'GET',
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'Puck',
          ...(ro.ifNoneMatch ? { 'If-None-Match': ro.ifNoneMatch } : {}),
          ...(ro.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: ro.body !== undefined ? JSON.stringify(ro.body) : undefined,
        signal: ro.signal,
      });
      record(res.headers);
      const text = await res.text();
      if (res.status === 304 && ro.ifNoneMatch) return { status: 304, headers: res.headers, data: null as T };
      // The raw and sha media types answer with the bare content, not JSON.
      const isJson = !ro.text && !/\.(raw|sha)\b/.test(accept);
      if (res.ok) {
        const data = (isJson ? parseBody(text) : text) as T;
        return { status: res.status, headers: res.headers, data };
      }
      const message = errorMessage(parseBody(text), text);
      const wait = rateLimitWait(res.status, res.headers, message);
      if (wait !== null) {
        if (attempt >= maxRetries || waited + wait > maxWaitMs) {
          throw new GitHubRateLimitError(deps.now() + wait, path, res.status);
        }
        await deps.sleep(wait, ro.signal);
        waited += wait;
        continue;
      }
      throw new GitHubApiError(`GitHub ${res.status} on ${path}: ${message || res.statusText}`, res.status, path);
    }
  }

  async function paginate<T>(
    path: string,
    pick: (page: unknown) => T[] = (page) => (Array.isArray(page) ? (page as T[]) : []),
    po: PaginateOptions = {},
  ): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = withPerPage(path);
    if (po.truncated) po.truncated.value = false;
    const max = po.maxPages ?? 20;
    for (let page = 0; next && page < max; page++) {
      const res: GitHubResponse<unknown> = await request<unknown>(next, { signal: po.signal });
      out.push(...pick(res.data));
      next = nextLink(res.headers.get('link'));
    }
    if (po.truncated && next) po.truncated.value = true;
    return out;
  }

  return { request, paginate, rateLimit: () => ({ ...rate }) };
}
