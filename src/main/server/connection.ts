/**
 * The app's one WebSocket to the Puck server (`/v1/app/connect`, wire
 * contract in src/channel/wire.ts): push events about the user's runners
 * and environments, and the relay channels to runners.
 *
 * - Auth: the session's access token at upgrade, extended on the same
 *   socket with `{ type: 'auth' }` a minute before it expires, so channels
 *   survive a token refresh. A 4401 `signed-out` stops for good until the
 *   next sign-in; `token-expired` reconnects with a fresh token.
 * - Reconnect: backoff 1, 2, 5, 10, then 30 s. Push events arrive only
 *   while connected, so every (re)connect calls `onConnected`, and the
 *   owner re-reads the runner and environment lists.
 * - Liveness: a ping every 20 s; no frame for 60 s terminates the socket.
 * - Channels: `open` sends the app's ephemeral key, and the runner's
 *   `accept` must carry a signature by the runner key the server listed
 *   (pinned per install by the caller). The channel is installed in the
 *   same tick the accept arrives, because the runner's first data frame can
 *   follow in the same socket read. A dropped socket closes every channel
 *   with `relay-lost`; the daemon's event log covers what a reattach missed.
 */

import WebSocket from 'ws';
import { ChannelCryptoError, startAppHandshake } from '../../channel/e2e';
import { ChannelStream } from '../../channel/stream';
import { DATA_HEADER_BYTES, decodeData, MAX_CHANNEL_ID, MAX_CIPHERTEXT_BYTES, OPEN_TIMEOUT_MS } from '../../channel/wire';
import { readPush, type ServerPush } from '../../harness/server-api';
import { BaseChannel, ChannelOpenError, openErrorFor, type ByteChannel, type ChannelKind } from '../runners/channel';

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const PING_EVERY_MS = 20_000;
const DEAD_AFTER_MS = 60_000;
const AUTH_MARGIN_MS = 60_000;
/** How long `openChannel` waits for the socket to come up. */
const CONNECT_WAIT_MS = 15_000;

export type SocketState = 'idle' | 'connecting' | 'connected' | 'offline';

export interface ConnectionDeps {
  url(): string;
  /** A fresh access token and its expiry; rejects when signed out. */
  session(): Promise<{ accessToken: string; accessExpiresAt: number }>;
  onPush(push: ServerPush): void;
  /** The socket (re)connected: re-read what push events may have missed. */
  onConnected(): void;
  onState?(state: SocketState, detail: string): void;
  /** The server ended the session (`signed-out`). */
  onSignedOut?(): void;
  log: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
  now?(): number;
}

class RelayChannel extends BaseChannel {
  stream!: ChannelStream;
  constructor(
    private readonly conn: ServerConnection,
    readonly ch: number,
  ) {
    super();
  }
  protected send(data: Uint8Array): boolean {
    return this.stream.write(data);
  }
  protected teardown(reason: string, tell: boolean): void {
    this.stream?.close();
    this.conn.forget(this.ch, tell ? reason : null);
  }
  /** Transport hooks. */
  in(chunk: Buffer, done: () => void): void {
    this.deliver(chunk, done);
  }
  drainedOut(): void {
    this.drained();
  }
  end(reason: string): void {
    this.ended(reason, false);
  }
}

interface PendingOpen {
  resolve(ch: RelayChannel): void;
  reject(err: Error): void;
  finish(accept: { runnerEphemeralPub: string; sig: string }): RelayChannel;
  timer: ReturnType<typeof setTimeout>;
}

export class ServerConnection {
  private ws: WebSocket | null = null;
  private state: SocketState = 'idle';
  private running = false;
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFrameAt = 0;
  private nextCh = 1;
  private readonly channels = new Map<number, RelayChannel>();
  private readonly opening = new Map<number, PendingOpen>();
  private waiters: { resolve(): void; reject(err: Error): void }[] = [];

  constructor(private readonly deps: ConnectionDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get socketState(): SocketState {
    return this.state;
  }

  /** Connects (and keeps reconnecting) until `stop`. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    void this.connect();
  }

  /** Closes the socket and every channel; nothing reconnects. */
  stop(reason = 'app-stopping'): void {
    this.running = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.teardown(reason);
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.close(1000, reason);
      setTimeout(() => ws.terminate(), 2_000).unref();
    }
    this.setState('idle', '');
    for (const w of this.waiters.splice(0)) w.reject(new Error('Not connected to the Puck server.'));
  }

  private setState(state: SocketState, detail: string): void {
    if (this.state === state) return;
    this.state = state;
    this.deps.onState?.(state, detail);
  }

  private teardown(reason: string): void {
    if (this.ping) clearInterval(this.ping);
    if (this.authTimer) clearTimeout(this.authTimer);
    this.ping = null;
    this.authTimer = null;
    for (const [ch, p] of [...this.opening]) {
      clearTimeout(p.timer);
      this.opening.delete(ch);
      p.reject(openErrorFor('relay-lost'));
    }
    for (const c of [...this.channels.values()]) c.end(reason);
    this.channels.clear();
  }

  private schedule(): void {
    if (!this.running) return;
    const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
    this.failures++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), wait);
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    this.setState('connecting', '');
    let session: { accessToken: string; accessExpiresAt: number };
    try {
      session = await this.deps.session();
    } catch (err) {
      this.deps.log.warn('server.socket-no-session', { error: (err as Error).message.slice(0, 200) });
      this.setState('offline', (err as Error).message);
      return this.schedule();
    }
    if (!this.running) return;
    const url = this.deps.url().replace(/^http/, 'ws') + '/v1/app/connect';
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      maxPayload: DATA_HEADER_BYTES + MAX_CIPHERTEXT_BYTES + 1024 * 1024,
      handshakeTimeout: 20_000,
    });
    this.ws = ws;
    ws.on('unexpected-response', (_req, res) => {
      this.deps.log.warn('server.socket-refused', { status: res.statusCode });
      ws.terminate();
    });
    ws.on('error', (err) => this.deps.log.warn('server.socket-error', { error: err.message.slice(0, 200) }));
    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.failures = 0;
      this.nextCh = 1;
      this.lastFrameAt = this.now();
      this.deps.log.info('server.socket-open');
      this.setState('connected', '');
      this.ping = setInterval(() => {
        if (this.now() - this.lastFrameAt > DEAD_AFTER_MS) return ws.terminate();
        this.sendJson({ type: 'ping', t: this.now() });
      }, PING_EVERY_MS);
      this.scheduleAuth(session.accessExpiresAt);
      for (const w of this.waiters.splice(0)) w.resolve();
      this.deps.onConnected();
    });
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      this.lastFrameAt = this.now();
      if (isBinary) {
        const frame = decodeData(data as Buffer);
        if (frame) this.channels.get(frame.ch)?.stream.receive(frame);
        return;
      }
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.onControl(frame);
    });
    ws.on('close', (code, reasonBuf) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const reason = reasonBuf.toString();
      this.teardown('relay-lost');
      if (!this.running) return;
      this.deps.log.info('server.socket-closed', { code, reason: reason.slice(0, 64) });
      if (code === 4401 && reason === 'signed-out') {
        this.running = false;
        this.setState('idle', 'signed out');
        this.deps.onSignedOut?.();
        return;
      }
      this.setState('offline', reason || `closed (${code})`);
      this.schedule();
    });
  }

  private scheduleAuth(expiresAt: number): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    const wait = Math.max(5_000, expiresAt - AUTH_MARGIN_MS - this.now());
    this.authTimer = setTimeout(async () => {
      try {
        const s = await this.deps.session();
        this.sendJson({ type: 'auth', token: s.accessToken });
        this.scheduleAuth(s.accessExpiresAt);
      } catch (err) {
        this.deps.log.warn('server.socket-auth-failed', { error: (err as Error).message.slice(0, 200) });
      }
    }, wait);
  }

  private sendJson(frame: object): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private onControl(frame: Record<string, unknown>): void {
    const ch = typeof frame.ch === 'number' ? frame.ch : -1;
    switch (frame.type) {
      case 'event': {
        const push = readPush(frame.event);
        if (push) this.deps.onPush(push);
        return;
      }
      case 'accept': {
        const p = this.opening.get(ch);
        if (!p) return;
        this.opening.delete(ch);
        clearTimeout(p.timer);
        try {
          p.resolve(p.finish(frame.e2e as { runnerEphemeralPub: string; sig: string }));
        } catch (err) {
          // A runner that cannot prove its key gets no channel.
          this.sendJson({ type: 'close', ch, reason: 'bad-handshake' });
          p.reject(
            err instanceof ChannelCryptoError
              ? new ChannelOpenError('bad-handshake', 'The runner did not prove the key Puck knows for it; the channel was refused.')
              : (err as Error),
          );
        }
        return;
      }
      case 'close': {
        const reason = typeof frame.reason === 'string' ? frame.reason : 'closed';
        const p = this.opening.get(ch);
        if (p) {
          this.opening.delete(ch);
          clearTimeout(p.timer);
          p.reject(openErrorFor(reason));
          return;
        }
        this.channels.get(ch)?.end(reason);
        return;
      }
      case 'window': {
        const c = this.channels.get(ch);
        if (c && typeof frame.credit === 'number') c.stream.credit(frame.credit);
        return;
      }
      default:
        return;
    }
  }

  private waitConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (!this.running) return Promise.reject(new ChannelOpenError('offline', 'Not connected to the Puck server. Sign in first.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== ok);
        reject(new ChannelOpenError('offline', "Can't reach the Puck server; Puck keeps trying."));
      }, CONNECT_WAIT_MS);
      const ok = (): void => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push({
        resolve: ok,
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /** Opens an end-to-end encrypted channel to a runner whose key is `runnerPublicKey`. */
  async openChannel(runnerId: string, runnerPublicKey: string, kind: ChannelKind, envId?: string): Promise<ByteChannel> {
    await this.waitConnected();
    const ws = this.ws;
    if (!ws) throw new ChannelOpenError('offline', 'Not connected to the Puck server.');
    let ch = this.nextCh;
    while (this.channels.has(ch) || this.opening.has(ch)) ch = ch >= MAX_CHANNEL_ID ? 1 : ch + 1;
    this.nextCh = ch >= MAX_CHANNEL_ID ? 1 : ch + 1;
    const hs = startAppHandshake();
    const binding = { appCh: ch, kind, envId: envId ?? null };
    return new Promise<ByteChannel>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.opening.delete(ch)) return;
        this.sendJson({ type: 'close', ch, reason: 'timeout' });
        reject(openErrorFor('timeout'));
      }, OPEN_TIMEOUT_MS + 5_000);
      this.opening.set(ch, {
        resolve,
        reject,
        timer,
        finish: (accept) => {
          const cipher = hs.finish(binding, accept, runnerPublicKey);
          const channel = new RelayChannel(this, ch);
          channel.stream = new ChannelStream({
            ch,
            cipher,
            transport: {
              data: (buf) => {
                if (this.ws === ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
              },
              window: (credit) => {
                if (this.ws === ws) this.sendJson({ type: 'window', ch, credit });
              },
            },
            onData: (plaintext, done) => channel.in(plaintext, done),
            onDrain: () => channel.drainedOut(),
            onError: (reason) => channel.close(reason),
          });
          this.channels.set(ch, channel);
          return channel;
        },
      });
      this.sendJson({ type: 'open', ch, runnerId, kind, ...(envId ? { envId } : {}), e2e: { appEphemeralPub: hs.appEphemeralPub } });
    });
  }

  /** A channel ended locally; `tell` names the reason to send, or null when the peer closed it. */
  forget(ch: number, tell: string | null): void {
    this.channels.delete(ch);
    if (tell !== null) this.sendJson({ type: 'close', ch, reason: tell });
  }

  get openChannels(): number {
    return this.channels.size;
  }
}
