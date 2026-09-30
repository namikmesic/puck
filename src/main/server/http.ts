/**
 * Talking to the Puck server over HTTP: where it is, and one request helper
 * with the server's error shape (`{ error, message }`).
 *
 * The server URL is `PUCK_SERVER_URL`, else the local Compose server
 * (`docker compose up` in the repository publishes it on port 8765). The
 * hosted server's address replaces that default once it exists.
 *
 * Bodies and answers never reach the log: most of them carry a secret.
 *
 * An isolated launch (PUCK_ISOLATED=1) started with PUCK_ISOLATED_BROWSER=off
 * does not open the sign-in page in the system browser: the page's URL is
 * only returned to the caller, so an automated check completes the sign-in
 * itself and the person at the desk sees no browser tab.
 */

import { shell } from 'electron';
import { readBoundedBody } from '../../runner-release/download';

export const SERVER_URL_ENV = 'PUCK_SERVER_URL';
export const DEFAULT_SERVER_URL = 'http://localhost:8765';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ServerDeps {
  fetch: Fetch;
  now(): number;
  openExternal(url: string): Promise<void>;
}

const noBrowser = (env: NodeJS.ProcessEnv = process.env): boolean => env.PUCK_ISOLATED === '1' && env.PUCK_ISOLATED_BROWSER === 'off';

const realDeps: ServerDeps = {
  fetch: (url, init) => fetch(url, init),
  now: Date.now,
  openExternal: async (url) => {
    if (!noBrowser()) await shell.openExternal(url);
  },
};

let deps: ServerDeps = realDeps;
let urlOverride: string | null = null;

/** Test seam: drive fetch, time and the browser for every server module. */
export function useServerDeps(next: Partial<ServerDeps> | null, serverUrl?: string): void {
  deps = next ? { ...realDeps, ...next } : realDeps;
  urlOverride = serverUrl ?? null;
}

export function serverDeps(): ServerDeps {
  return deps;
}

/** The Puck server's base URL, without a trailing slash. */
export function serverUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = urlOverride ?? (env[SERVER_URL_ENV]?.trim() || DEFAULT_SERVER_URL);
  return raw.replace(/\/+$/, '');
}

export class ServerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ServerApiError';
  }
}

/** The server could not be reached at all. */
export class ServerUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    super(`Can't reach the Puck server at ${url} (${cause instanceof Error ? cause.message : String(cause)}).`);
    this.name = 'ServerUnreachableError';
  }
}

export interface RequestOptions {
  body?: unknown;
  token?: string;
  timeoutMs?: number;
  /**
   * Bounds the answer through the runner-release transport: a longer body
   * is refused before parsing. Release listings set it; other requests
   * read as before.
   */
  maxBodyBytes?: number;
  /** With maxBodyBytes. Listings pass false and keep a content encoding. */
  refuseContentEncoding?: boolean;
}

/**
 * One JSON request; resolves with the parsed body (null for 204).
 * A non-2xx answer is ServerApiError, and an unreachable server is
 * ServerUnreachableError. A bounded body (`maxBodyBytes`) throws
 * RunnerDownloadError from the runner-release transport before parsing.
 */
export async function serverRequest<T = Record<string, unknown>>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const base = serverUrl();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await deps.fetch(base + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new ServerUnreachableError(base, err);
  }
  const text =
    opts.maxBodyBytes === undefined
      ? await res.text().catch(() => '')
      : new TextDecoder().decode(await readBoundedBody(res, opts.maxBodyBytes, { refuseContentEncoding: opts.refuseContentEncoding }));
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const o = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const { error, message, ...extra } = o;
    throw new ServerApiError(
      res.status,
      typeof error === 'string' ? error : `http-${res.status}`,
      typeof message === 'string' ? message : `The Puck server answered ${res.status}.`,
      extra,
    );
  }
  return parsed as T;
}
