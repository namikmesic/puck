/**
 * The runner's HTTP calls to the Puck server, and its access token.
 *
 *   POST /v1/runners/register                     registration token + public key → runnerId
 *   POST /v1/runners/token                        signed assertion → one-hour runner access token
 *   POST /v1/runners/remove                       removal token or signed assertion → deregistered
 *   POST /v1/runners/instances/:envId/github-token  runner token → installation token grants
 *   GET  /v1/runner/releases                      the latest runner version and its tarballs
 *
 * Errors carry the server's status and code. Two codes mean "stop and act":
 * `runner-removed` (403: the runner was removed; exit for good) and
 * `runner-outdated` (426: update first).
 */

import { Readable } from 'node:stream';
import type { GithubGrant } from '../harness/daemon-protocol';
import { signAssertion, type RunnerKey } from './identity';

const REQUEST_TIMEOUT_MS = 30_000;
/** Refresh the runner access token this long before it expires. */
const TOKEN_EARLY_MS = 5 * 60_000;

export type Fetch = typeof fetch;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class RunnerRemovedError extends Error {
  constructor() {
    super('This runner was removed from Puck. Run ./config.sh remove to clean up.');
    this.name = 'RunnerRemovedError';
  }
}

export class RunnerOutdatedError extends Error {
  constructor(readonly minVersion: string | null) {
    super(`This Puck server needs a newer runner${minVersion ? ` (${minVersion} or newer)` : ''}.`);
    this.name = 'RunnerOutdatedError';
  }
}

export interface RegisterRequest {
  registrationToken: string;
  name: string;
  labels: string[];
  os: 'linux' | 'macos';
  arch: 'x64' | 'arm64';
  publicKey: string;
  runnerVersion: string;
  docker: { version: string | null; ncpu: number | null; memTotal: number | null };
  maxEnvironments: number | null;
  replace: boolean;
}

export interface RegisterResponse {
  runnerId: string;
  name: string;
  labels: string[];
  fingerprint: string;
  owner: { login: string };
  serverUrl: string;
}

export interface ReleaseAsset {
  os: string;
  arch: string;
  version: string;
  file: string;
  url: string;
  sha256: string;
  size: number;
}

export interface Releases {
  latest: string | null;
  minVersion: string | null;
  assets: ReleaseAsset[];
}

export class ServerApi {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, opts: { body?: unknown; token?: string } = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: {
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ApiError(0, 'unreachable', `Cannot reach the Puck server at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (!res.ok) {
      const code = typeof body.error === 'string' ? body.error : `http-${res.status}`;
      if (code === 'runner-removed') throw new RunnerRemovedError();
      if (res.status === 426 || code === 'runner-outdated') {
        throw new RunnerOutdatedError(typeof body.minVersion === 'string' ? body.minVersion : null);
      }
      const message = typeof body.message === 'string' ? body.message : `The Puck server answered ${res.status}.`;
      throw new ApiError(res.status, code, message, body);
    }
    return body as T;
  }

  register(req: RegisterRequest): Promise<RegisterResponse> {
    return this.call('POST', '/v1/runners/register', { body: req });
  }

  exchange(assertion: string): Promise<{ accessToken: string; expiresAt: number }> {
    return this.call('POST', '/v1/runners/token', { body: { assertion } });
  }

  async remove(req: { runnerId: string; environments: 'keep' | 'delete'; removalToken?: string; assertion?: string }): Promise<void> {
    await this.call('POST', '/v1/runners/remove', { body: req });
  }

  async githubToken(envId: string, accessToken: string): Promise<GithubGrant[]> {
    const body = await this.call<{ grants?: unknown }>('POST', `/v1/runners/instances/${encodeURIComponent(envId)}/github-token`, {
      token: accessToken,
    });
    if (!Array.isArray(body.grants)) throw new ApiError(502, 'bad-response', 'The Puck server sent no GitHub grants.');
    return body.grants as GithubGrant[];
  }

  releases(): Promise<Releases> {
    return this.call('GET', '/v1/runner/releases');
  }

  /** Streams a download; only URLs on this server are fetched. */
  async download(url: string): Promise<Readable> {
    if (new URL(url).origin !== new URL(this.baseUrl).origin) throw new ApiError(0, 'bad-url', 'Runner downloads come only from the Puck server.');
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new ApiError(res.status, `http-${res.status}`, `The download failed (${res.status}).`);
    return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  }
}

/**
 * The runner access token: exchanged for a fresh signed assertion when
 * missing or near expiry, single-flight. `invalidate` after a 401 forces the
 * next call to exchange again.
 */
export class RunnerSession {
  private token: { value: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly api: ServerApi,
    private readonly runnerId: string,
    private readonly key: RunnerKey,
    /** The server's public URL; assertion audiences are built from it. */
    private readonly serverUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - this.now() > TOKEN_EARLY_MS) return Promise.resolve(this.token.value);
    if (!this.inflight) {
      this.inflight = (async () => {
        try {
          const assertion = signAssertion(this.runnerId, this.key.privateKey, `${this.serverUrl}/v1/runners/token`, this.now());
          const res = await this.api.exchange(assertion);
          this.token = { value: res.accessToken, expiresAt: res.expiresAt };
          return res.accessToken;
        } finally {
          this.inflight = null;
        }
      })();
    }
    return this.inflight;
  }

  invalidate(): void {
    this.token = null;
  }

  /** Runs `fn` with the token, exchanging once more if the server says it is no longer valid. */
  async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.accessToken());
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
      this.invalidate();
      return fn(await this.accessToken());
    }
  }
}
