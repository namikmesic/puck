/**
 * A fake GitHub for the Puck server tests, plus a harness that runs the real
 * server (in-memory store, fake clock, captured log) against it.
 *
 * The fake verifies what the real GitHub would: the client secret on code
 * exchange and refresh, user tokens and their expiry, and App JWTs by their
 * RS256 signature against a key pair generated per test run (no key is ever
 * committed). It records every installation-token request.
 */

import { createHash, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import WebSocket from 'ws';
import { FakeClock } from '../../src/server/clock';
import { loadConfig, type ServerConfig } from '../../src/server/config';
import { createServerLog } from '../../src/server/log';
import { createPuckServer, type PuckServer } from '../../src/server/server';
import { SqliteStore } from '../../src/server/store';

export const API = 'https://api.github.test';
export const WEB = 'https://github.test';
export const CLIENT_ID = 'Iv1.fakeclient';
export const CLIENT_SECRET = 'fake-client-secret';
export const APP_ID = '424242';

interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  installationId: number | null;
  pushers: Set<string>;
  readers: Set<string>;
}

export interface MintRequest {
  installationId: number;
  repositoryIds: number[];
  permissions: Record<string, string>;
}

export class FakeGitHub {
  readonly privateKeyPem: string;
  private publicKey: KeyObject;
  private users = new Map<string, number>();
  private codes = new Map<string, string>();
  private access = new Map<string, { login: string; expiresAt: number }>();
  private refreshTokens = new Map<string, string>();
  private repos = new Map<string, FakeRepo>();
  private nextId = 1000;
  readonly mints: MintRequest[] = [];
  readonly calls: string[] = [];
  refreshCount = 0;
  /** App JWT calls answer 401. User tokens are left alone. */
  rejectAppJwt = false;
  private repoPause: { need: number; seen: number; arrive: () => void; gate: Promise<void> } | null = null;
  /** Access-token life GitHub hands out (8 h, like user-to-server tokens). */
  tokenLifeMs = 8 * 60 * 60_000;

  constructor(private clock: { now(): number }) {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    this.publicKey = pair.publicKey;
  }

  addUser(login: string): number {
    const id = this.nextId++;
    this.users.set(login, id);
    return id;
  }

  addRepo(full: string, opts: { installationId?: number | null; pushers?: string[]; readers?: string[] } = {}): number {
    const [owner, name] = full.split('/');
    const id = this.nextId++;
    this.repos.set(full.toLowerCase(), {
      id,
      owner,
      name,
      installationId: opts.installationId === undefined ? 1 : opts.installationId,
      pushers: new Set(opts.pushers ?? []),
      readers: new Set(opts.readers ?? []),
    });
    return id;
  }

  /** The user revoked the App's authorization: every refresh token stops working. */
  revokeAuthorizations(): void {
    this.refreshTokens.clear();
  }

  /** GitHub rejects current user access tokens while the server still treats them as unexpired. */
  rejectUserAccess(): void {
    this.access.clear();
  }

  /** Holds the next `need` repository reads until `release`. */
  pauseRepoReads(need: number): { arrived: Promise<void>; release: () => void } {
    let arrive!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.repoPause = { need, seen: 0, arrive, gate };
    return {
      arrived,
      release: () => {
        this.repoPause = null;
        release();
      },
    };
  }

  revokePush(full: string, login: string): void {
    this.repos.get(full.toLowerCase())?.pushers.delete(login);
  }

  /** What the browser does at GitHub: the user approves, GitHub redirects with a code. */
  approve(authorizeUrl: string, login: string): string {
    const url = new URL(authorizeUrl);
    if (url.origin !== WEB || url.pathname !== '/login/oauth/authorize') throw new Error(`not an authorize URL: ${authorizeUrl}`);
    if (url.searchParams.get('client_id') !== CLIENT_ID) throw new Error('wrong client id');
    const code = randomBytes(10).toString('hex');
    this.codes.set(code, login);
    const back = new URL(url.searchParams.get('redirect_uri') as string);
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') as string);
    return back.toString();
  }

  private issue(login: string): Record<string, unknown> {
    const accessToken = `ghu_${randomBytes(16).toString('hex')}`;
    const refreshToken = `ghr_${randomBytes(16).toString('hex')}`;
    this.access.set(accessToken, { login, expiresAt: this.clock.now() + this.tokenLifeMs });
    this.refreshTokens.set(refreshToken, login);
    return {
      access_token: accessToken,
      expires_in: this.tokenLifeMs / 1000,
      refresh_token: refreshToken,
      refresh_token_expires_in: 15_897_600,
      token_type: 'bearer',
    };
  }

  private userFor(auth: string | null): string | null {
    const token = auth?.replace(/^Bearer /, '') ?? '';
    const found = this.access.get(token);
    return found && found.expiresAt > this.clock.now() ? found.login : null;
  }

  private appJwtOk(auth: string | null): boolean {
    if (this.rejectAppJwt) return false;
    const parts = (auth?.replace(/^Bearer /, '') ?? '').split('.');
    if (parts.length !== 3) return false;
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), this.publicKey, Buffer.from(parts[2], 'base64url'))) return false;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const now = this.clock.now() / 1000;
    return claims.iss === APP_ID && claims.exp > now && claims.iat <= now && claims.exp - claims.iat <= 600;
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization');
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    this.calls.push(`${method} ${url.origin}${url.pathname}`);

    if (url.origin === WEB && url.pathname === '/login/oauth/access_token' && method === 'POST') {
      const form = new URLSearchParams(String(init?.body ?? ''));
      if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
        return json(200, { error: 'incorrect_client_credentials' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        this.refreshCount++;
        const login = this.refreshTokens.get(form.get('refresh_token') ?? '');
        if (!login) return json(200, { error: 'bad_refresh_token' });
        this.refreshTokens.delete(form.get('refresh_token') ?? '');
        return json(200, this.issue(login));
      }
      const login = this.codes.get(form.get('code') ?? '');
      if (!login) return json(200, { error: 'bad_verification_code' });
      this.codes.delete(form.get('code') ?? '');
      return json(200, this.issue(login));
    }
    if (url.origin !== API) return json(404, { message: 'Not Found' });

    if (url.pathname === '/user') {
      const login = this.userFor(auth);
      return login ? json(200, { id: this.users.get(login), login }) : json(401, { message: 'Bad credentials' });
    }
    const install = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(url.pathname);
    if (install) {
      if (!this.appJwtOk(auth)) return json(401, { message: 'A JSON web token could not be decoded' });
      const repo = this.repos.get(`${install[1]}/${install[2]}`.toLowerCase());
      return repo?.installationId ? json(200, { id: repo.installationId }) : json(404, { message: 'Not Found' });
    }
    const repoPath = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (repoPath) {
      const pause = this.repoPause;
      if (pause) {
        pause.seen += 1;
        if (pause.seen >= pause.need) pause.arrive();
        await pause.gate;
      }
      const login = this.userFor(auth);
      if (!login) return json(401, { message: 'Bad credentials' });
      const repo = this.repos.get(`${repoPath[1]}/${repoPath[2]}`.toLowerCase());
      const visible = repo && repo.installationId !== null && (repo.pushers.has(login) || repo.readers.has(login));
      if (!repo || !visible) return json(404, { message: 'Not Found' });
      return json(200, { id: repo.id, name: repo.name, owner: { login: repo.owner }, permissions: { pull: true, push: repo.pushers.has(login) } });
    }
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (mint && method === 'POST') {
      if (!this.appJwtOk(auth)) return json(401, { message: 'A JSON web token could not be decoded' });
      const body = JSON.parse(String(init?.body ?? '{}'));
      this.mints.push({ installationId: Number(mint[1]), repositoryIds: body.repository_ids, permissions: body.permissions });
      return json(201, {
        token: `ghs_${randomBytes(16).toString('hex')}`,
        expires_at: new Date(this.clock.now() + 60 * 60_000).toISOString(),
        permissions: body.permissions,
      });
    }
    return json(404, { message: 'Not Found' });
  }) as typeof fetch;
}

/* ---------- Harness ---------- */

export interface Harness {
  server: PuckServer;
  clock: FakeClock;
  github: FakeGitHub;
  base: string;
  logs: string[];
  close(): Promise<void>;
}

export async function startServer(overrides: Record<string, string> = {}, opts: { github?: boolean } = {}): Promise<Harness> {
  const clock = new FakeClock();
  const github = new FakeGitHub(clock);
  const env: Record<string, string> = {
    PUCK_SERVER_URL: 'http://puck.test',
    PUCK_SERVER_PORT: '0',
    PUCK_SERVER_DB: ':memory:',
    ...(opts.github === false
      ? {}
      : {
          PUCK_SERVER_TOKEN_KEY: randomBytes(32).toString('base64'),
          PUCK_GITHUB_APP_ID: APP_ID,
          PUCK_GITHUB_CLIENT_ID: CLIENT_ID,
          PUCK_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
          PUCK_GITHUB_PRIVATE_KEY: github.privateKeyPem,
          PUCK_GITHUB_APP_SLUG: 'puck-test',
          PUCK_GITHUB_API_URL: API,
          PUCK_GITHUB_WEB_URL: WEB,
        }),
    ...overrides,
  };
  const config: ServerConfig = loadConfig(env);
  const logs: string[] = [];
  const store = new SqliteStore(config.dbPath);
  const server = createPuckServer({
    config,
    store,
    clock,
    log: createServerLog((line) => logs.push(line), () => clock.now()),
    githubDeps: { fetch: github.fetch, now: () => clock.now() },
  });
  const { url } = await server.listen();
  return {
    server,
    clock,
    github,
    base: url,
    logs,
    close: async () => {
      await server.close();
      await store.close();
    },
  };
}

export async function call(
  h: Harness,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(h.base + path, {
    method,
    redirect: 'manual',
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { text };
  }
  return { status: res.status, body, headers: res.headers };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export interface SignedIn {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

/** The whole web-flow sign-in, as the app and the browser would do it. */
export async function signIn(h: Harness, login: string): Promise<SignedIn> {
  const { verifier, challenge } = pkcePair();
  const start = await call(h, 'POST', '/v1/auth/github/start', {
    body: { redirectUri: 'http://127.0.0.1:53123/callback', codeChallenge: challenge, state: 'app-state' },
  });
  if (start.status !== 200) throw new Error(`start failed: ${JSON.stringify(start.body)}`);
  const githubRedirect = h.github.approve(String(start.body.authorizeUrl), login);
  const callbackUrl = new URL(githubRedirect);
  const cb = await fetch(h.base + callbackUrl.pathname + callbackUrl.search, { redirect: 'manual' });
  const loopback = new URL(cb.headers.get('location') as string);
  const code = loopback.searchParams.get('code');
  if (!code) throw new Error(`callback failed: ${loopback}`);
  const token = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'authorization_code', code, code_verifier: verifier } });
  if (token.status !== 200) throw new Error(`token failed: ${JSON.stringify(token.body)}`);
  return {
    userId: String((token.body.user as { id: string }).id),
    accessToken: String(token.body.accessToken),
    refreshToken: String(token.body.refreshToken),
  };
}

export interface ScriptedRunnerIdentity {
  runnerId: string;
  privateKey: KeyObject;
  publicKey: string;
}

export function runnerKeyPair(): { privateKey: KeyObject; publicKey: string } {
  const pair = generateKeyPairSync('ed25519');
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return { privateKey: pair.privateKey, publicKey: String(jwk.x) };
}

export function assertion(
  runnerId: string,
  key: KeyObject,
  aud: string,
  nowMs: number,
  overrides: Record<string, unknown> = {},
): string {
  const iat = Math.floor(nowMs / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({ iss: runnerId, sub: runnerId, aud, iat, exp: iat + 300, jti: randomBytes(8).toString('hex'), ...overrides }),
  ).toString('base64url');
  const sig = sign(null, Buffer.from(`${header}.${claims}`), key).toString('base64url');
  return `${header}.${claims}.${sig}`;
}

export async function registerRunner(
  h: Harness,
  session: SignedIn,
  body: Record<string, unknown> = {},
): Promise<ScriptedRunnerIdentity & { accessToken: string }> {
  const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: session.accessToken });
  const { privateKey, publicKey } = runnerKeyPair();
  const res = await call(h, 'POST', '/v1/runners/register', {
    body: {
      registrationToken: reg.body.token,
      name: 'build-box',
      os: 'linux',
      arch: 'x64',
      publicKey,
      runnerVersion: '0.1.0',
      docker: { version: '27.3.1', ncpu: 16, memTotal: 67_000_000_000 },
      ...body,
    },
  });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  const runnerId = String(res.body.runnerId);
  const tok = await call(h, 'POST', '/v1/runners/token', {
    body: { assertion: assertion(runnerId, privateKey, 'http://puck.test/v1/runners/token', h.clock.now()) },
  });
  if (tok.status !== 200) throw new Error(`token failed: ${JSON.stringify(tok.body)}`);
  return { runnerId, privateKey, publicKey, accessToken: String(tok.body.accessToken) };
}

/** A WebSocket client that queues JSON control frames and binary data frames for `next*`. */
export class Socket {
  readonly ws: WebSocket;
  private texts: Record<string, unknown>[] = [];
  private binaries: Buffer[] = [];
  private waiters: (() => void)[] = [];
  closed: { code: number; reason: string } | null = null;
  private pings = 0;

  constructor(url: string, token: string) {
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) this.binaries.push(data as Buffer);
      else this.texts.push(JSON.parse(String(data)));
      this.wake();
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: String(reason) };
      this.wake();
    });
    this.ws.on('error', () => this.wake());
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    });
  }

  send(frame: object): void {
    this.ws.send(JSON.stringify(frame));
  }

  /**
   * Waits until the server has handled every frame sent so far: frames are
   * handled in order, and the store work behind them settles before the
   * server's next event, so the pong arrives after it.
   */
  async sync(): Promise<void> {
    const t = ++this.pings;
    this.send({ type: 'ping', t });
    for (;;) if ((await this.next('pong')).t === t) return;
  }

  sendBinary(data: Buffer): void {
    this.ws.send(data);
  }

  private async wait<T>(take: () => T | undefined, what: string, ms = 3000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const got = take();
      if (got !== undefined) return got;
      if (this.closed && what !== 'close') throw new Error(`socket closed while waiting for ${what}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  /** The next control frame of `type` (earlier frames of other types stay queued). */
  next(type: string, ms?: number): Promise<Record<string, unknown>> {
    return this.wait(() => {
      const i = this.texts.findIndex((f) => f.type === type);
      return i >= 0 ? this.texts.splice(i, 1)[0] : undefined;
    }, type, ms);
  }

  nextBinary(ms?: number): Promise<Buffer> {
    return this.wait(() => this.binaries.shift(), 'data', ms);
  }

  waitClosed(ms?: number): Promise<{ code: number; reason: string }> {
    return this.wait(() => this.closed ?? undefined, 'close', ms);
  }

  pendingBinaries(): number {
    return this.binaries.length;
  }

  close(): void {
    this.ws.close();
  }
}

export const wsUrl = (h: Harness, path: string): string => h.base.replace(/^http/, 'ws') + path;

export async function connectRunner(
  h: Harness,
  accessToken: string,
  status: Record<string, unknown> = {},
): Promise<Socket> {
  const s = new Socket(wsUrl(h, '/v1/runners/connect'), accessToken);
  await s.opened();
  s.send({
    type: 'hello',
    version: '0.1.0',
    docker: { ok: true, version: '27.3.1', ncpu: 16, memTotal: 67_000_000_000 },
    maxEnvironments: null,
    instances: [],
    ...status,
  });
  if (s.ws.readyState === WebSocket.OPEN) await s.sync().catch(() => undefined);
  return s;
}

export async function connectApp(h: Harness, accessToken: string): Promise<Socket> {
  const s = new Socket(wsUrl(h, '/v1/app/connect'), accessToken);
  await s.opened();
  return s;
}

