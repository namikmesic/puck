/**
 * The HTTP layer: a small router over node:http, JSON bodies with a size
 * cap, bearer extraction, and one error shape. A handler returns a `Reply`
 * or throws `HttpError`; anything else thrown becomes a 500 whose details
 * stay in the log. Every API answer is JSON `{ error, message }` on failure,
 * carries `Cache-Control: no-store`, and is never cached by a proxy, because
 * most of them carry a secret.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerLog } from './log';

export const MAX_BODY_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** A plain-text body instead of JSON (pages a browser lands on). */
  text?: string;
  /** A 302 to this URL instead of a JSON body. */
  redirect?: string;
  /** Hand the response to the handler, which writes it itself. */
  streamed?: boolean;
}

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  raw: IncomingMessage;
  res: ServerResponse;
  /** The parsed JSON body (an object); 400 when it is not one. */
  json(): Promise<Record<string, unknown>>;
  bearer(): string | null;
}

export type Handler = (req: Req) => Promise<Reply>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  /** The handler and path parameters for a request, or why there is none. */
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | 'not-found' | 'method' {
    const parts = path.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length && ok; i++) {
        const want = route.parts[i];
        if (want.startsWith(':')) {
          try {
            params[want.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            ok = false;
          }
        } else ok = want === parts[i];
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { handler: route.handler, params };
    }
    return pathMatched ? 'method' : 'not-found';
  }
}

export function bearerFrom(headers: IncomingMessage['headers']): string | null {
  const auth = headers.authorization;
  if (typeof auth !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  return m ? m[1] : null;
}

function readBody(raw: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    raw.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        raw.pause();
        reject(new HttpError(413, 'body-too-large', 'The request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    raw.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    raw.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

export function createRequestHandler(router: Router, log: ServerLog) {
  return async (raw: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now();
    const url = new URL(raw.url ?? '/', 'http://server.invalid');
    const method = raw.method ?? 'GET';
    let status = 500;
    try {
      const found = router.match(method, url.pathname);
      if (found === 'not-found') throw new HttpError(404, 'not-found', 'No such endpoint.');
      if (found === 'method') throw new HttpError(405, 'method-not-allowed', 'Method not allowed.');
      let parsed: Record<string, unknown> | null = null;
      const req: Req = {
        method,
        path: url.pathname,
        query: url.searchParams,
        params: found.params,
        headers: raw.headers,
        raw,
        res,
        json: async () => {
          if (parsed) return parsed;
          const type = String(raw.headers['content-type'] ?? '');
          if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'unsupported-media-type', 'Send JSON.');
          let value: unknown;
          try {
            value = JSON.parse(await readBody(raw));
          } catch (err) {
            if (err instanceof HttpError) throw err;
            throw new HttpError(400, 'invalid-json', 'The body is not valid JSON.');
          }
          if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            throw new HttpError(400, 'invalid-body', 'The body must be a JSON object.');
          }
          parsed = value as Record<string, unknown>;
          return parsed;
        },
        bearer: () => bearerFrom(raw.headers),
      };
      const reply = await found.handler(req);
      status = reply.redirect ? 302 : (reply.status ?? 200);
      if (reply.streamed) return;
      if (reply.redirect) {
        res.writeHead(302, { Location: reply.redirect, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end();
      } else if (reply.text !== undefined) {
        res.writeHead(status, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(reply.text);
      } else if (status === 204) {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
      } else {
        send(res, status, reply.body, reply.headers);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        send(res, err.status, { error: err.code, message: err.message, ...err.extra });
      } else if (err instanceof Error && (err.name === 'GitHubApiError' || err.name === 'GitHubRateLimitError')) {
        // GitHub failed or rate-limited us: a gateway problem, not the caller's.
        status = 502;
        log.warn('github request failed', { method, path: url.pathname, error: err.name });
        send(res, 502, { error: 'github-unavailable', message: 'GitHub did not answer as expected. Try again shortly.' });
      } else {
        status = 500;
        log.error('request failed', { method, path: url.pathname, error: err instanceof Error ? err.name : 'unknown' });
        if (!res.headersSent) send(res, 500, { error: 'internal', message: 'Something went wrong on the Puck server.' });
        else res.destroy();
      }
    } finally {
      log.info('request', { method, path: url.pathname, status, ms: Date.now() - started });
    }
  };
}

/* ---------- Validation helpers for handlers ---------- */

export function str(body: Record<string, unknown>, key: string, opts?: { max?: number; optional?: false }): string;
export function str(body: Record<string, unknown>, key: string, opts: { max?: number; optional: true }): string | null;
export function str(body: Record<string, unknown>, key: string, opts: { max?: number; optional?: boolean } = {}): string | null {
  const v = body[key];
  if (v === undefined || v === null) {
    if (opts.optional) return null;
    throw new HttpError(400, 'invalid-body', `\`${key}\` is required.`);
  }
  if (typeof v !== 'string' || !v.trim() || v.length > (opts.max ?? 256)) {
    throw new HttpError(400, 'invalid-body', `\`${key}\` must be a non-empty string of at most ${opts.max ?? 256} characters.`);
  }
  return v;
}

export function strList(body: Record<string, unknown>, key: string, max: number, itemMax = 64): string[] {
  const v = body[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > itemMax)) {
    throw new HttpError(400, 'invalid-body', `\`${key}\` must be a list of at most ${max} short strings.`);
  }
  return v as string[];
}

export function intOrNull(body: Record<string, unknown>, key: string, min: number, max: number): number | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new HttpError(400, 'invalid-body', `\`${key}\` must be an integer from ${min} to ${max}.`);
  }
  return v;
}
