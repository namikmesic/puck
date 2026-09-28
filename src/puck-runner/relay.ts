/**
 * The runner's one outbound connection: `WSS /v1/runners/connect` with its
 * runner access token. There are no inbound ports. Over it the runner
 *
 * - reports status: `hello` on connect and `status` every 20 s, carrying
 *   Docker health, the Docker server version, CPUs and memory, the
 *   configured maximum, and every `puck=instance` container with its state;
 * - answers channels the app opens through the server. Each channel's
 *   handshake is signed with the runner key (src/channel/e2e.ts), so the
 *   server relays ciphertext it cannot read. A `control` channel carries the
 *   runner control protocol (control.ts). An `attach` channel is a byte pipe
 *   to `docker exec -i puck-<envId> node /opt/puck/puckd.js attach`; when
 *   the app stops returning credit, the exec's stdout is paused, so a slow
 *   client never makes the runner buffer without bound.
 *
 * A dropped connection closes every channel and reconnects with backoff (1,
 * 2, 5, 10, then 30 s), exchanging a fresh access token each time. Nothing
 * here touches a container's lifecycle: an attach channel closing, or the
 * whole runner exiting, only ends `docker exec` clients, and every daemon
 * keeps running (its event log lets the app replay what it missed).
 *
 * Close codes from the server: 4403 the runner was removed (stop for good),
 * 4426 this version is too old (update), 4401 the token expired (exchange
 * again), 4409 another process connected as this runner (back off).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { KeyObject } from 'node:crypto';
import WebSocket from 'ws';
import { acceptRunnerHandshake, ChannelCryptoError } from '../channel/e2e';
import { ChannelStream } from '../channel/stream';
import {
  DATA_HEADER_BYTES,
  decodeData,
  isChannelId,
  MAX_CIPHERTEXT_BYTES,
  rawKey,
  STATUS_EVERY_MS,
  type ChannelKind,
  type RunnerStatus,
  type RunnerToServer,
} from '../channel/wire';
import { ENV_ID_RE, RUNNER_LIMITS, type ControlEvent, type ControlRunnerFrame } from '../harness/runner-protocol';
import { RunnerOutdatedError, RunnerRemovedError, type RunnerSession } from './api';
import { welcomeFrame, type Control } from './control';
import { attachArgs } from './daemon-link';
import type { DockerSpawner } from './docker/client';
import type { Logger } from './log';

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const REPLACED_BACKOFF_MS = 30_000;

export const CLOSE_CODES = { unauthorized: 4401, removed: 4403, replaced: 4409, outdated: 4426 } as const;

export interface RelayDeps {
  runnerId: string;
  version: string;
  serverUrl: string;
  session: RunnerSession;
  key: KeyObject;
  log: Logger;
  control: Control;
  spawner: DockerSpawner;
  /** The heartbeat payload (Docker health and capacity, hosted instances). */
  status(): Promise<RunnerStatus>;
  /** The container's state, or null when it does not exist. */
  instanceState(envId: string): Promise<string | null>;
  onRemoved(err: RunnerRemovedError): void;
  onOutdated(err: RunnerOutdatedError): void;
  /** Connected (again): a good time to check for updates and reconcile. */
  onConnected?(): void;
}

interface Channel {
  ch: number;
  kind: ChannelKind;
  envId: string | null;
  stream: ChannelStream;
  /** Tears the channel down locally; `tell` also sends `close` to the server. */
  close(reason: string, tell: boolean): void;
}

interface PendingOpen {
  socket: WebSocket;
  cancelled: boolean;
}

export class RelayConnection {
  private ws: WebSocket | null = null;
  private readonly channels = new Map<number, Channel>();
  private readonly pending = new Map<number, PendingOpen>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private stopped = false;
  private connectedOnce = false;

  constructor(private readonly deps: RelayDeps) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get openChannels(): number {
    return this.channels.size;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  /** Closes every channel and the socket; containers are untouched. */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.stopHeartbeat();
    this.cancelPending(null);
    for (const c of [...this.channels.values()]) c.close('runner-stopping', true);
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      const done = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 2_000);
      ws.once('close', () => {
        clearTimeout(done);
        resolve();
      });
      ws.close(1001, 'runner-stopping');
    });
  }

  private scheduleReconnect(ms?: number): void {
    if (this.stopped) return;
    const wait = ms ?? BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
    this.failures++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), wait);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let token: string;
    try {
      token = await this.deps.session.accessToken();
    } catch (err) {
      if (err instanceof RunnerRemovedError) return this.deps.onRemoved(err);
      if (err instanceof RunnerOutdatedError) return this.deps.onOutdated(err);
      this.deps.log.warn('relay.token-failed', { error: (err as Error).message.slice(0, 300) });
      return this.scheduleReconnect();
    }
    if (this.stopped) return;
    const url = this.deps.serverUrl.replace(/^http/, 'ws') + '/v1/runners/connect';
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      maxPayload: DATA_HEADER_BYTES + MAX_CIPHERTEXT_BYTES,
      handshakeTimeout: 30_000,
    });
    this.ws = ws;
    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) this.deps.session.invalidate();
      this.deps.log.warn('relay.refused', { status: res.statusCode });
      ws.terminate();
    });
    ws.on('error', (err) => this.deps.log.warn('relay.error', { error: err.message.slice(0, 200) }));
    ws.on('open', () => {
      this.failures = 0;
      this.deps.log.info(this.connectedOnce ? 'relay.reconnected' : 'relay.connected', { runnerId: this.deps.runnerId });
      this.connectedOnce = true;
      void this.sendStatus('hello');
      this.heartbeat = setInterval(() => void this.sendStatus('status'), STATUS_EVERY_MS);
      this.deps.onConnected?.();
    });
    ws.on('message', (data, isBinary) => {
      if (this.ws !== ws) return;
      if (isBinary) return this.onData(data as Buffer);
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.onControl(frame);
    });
    ws.on('close', (code, reason) => {
      if (this.ws === ws) this.ws = null;
      this.stopHeartbeat();
      this.cancelPending(ws);
      for (const c of [...this.channels.values()]) c.close('relay-lost', false);
      if (this.stopped) return;
      const why = reason.toString();
      this.deps.log.info('relay.closed', { code, reason: why.slice(0, 64) });
      if (code === CLOSE_CODES.removed) return this.deps.onRemoved(new RunnerRemovedError());
      if (code === CLOSE_CODES.outdated) return this.deps.onOutdated(new RunnerOutdatedError(null));
      if (code === CLOSE_CODES.unauthorized) this.deps.session.invalidate();
      this.scheduleReconnect(code === CLOSE_CODES.replaced ? REPLACED_BACKOFF_MS : undefined);
    });
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private send(frame: RunnerToServer): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  private async sendStatus(type: 'hello' | 'status'): Promise<void> {
    let status: RunnerStatus;
    try {
      status = await this.deps.status();
    } catch (err) {
      this.deps.log.warn('relay.status-failed', { error: (err as Error).message.slice(0, 200) });
      return;
    }
    this.send({ type, ...status });
  }

  /** Sends a status frame now (after an environment starts or stops). */
  announce(): void {
    if (this.connected) void this.sendStatus('status');
  }

  private onData(buf: Buffer): void {
    const frame = decodeData(buf);
    if (!frame) return;
    this.channels.get(frame.ch)?.stream.receive(frame);
  }

  private onControl(frame: Record<string, unknown>): void {
    switch (frame.type) {
      case 'open':
        void this.open(frame);
        return;
      case 'close': {
        if (!isChannelId(frame.ch)) return;
        const pending = this.pending.get(frame.ch);
        if (pending) pending.cancelled = true;
        this.channels.get(frame.ch)?.close(typeof frame.reason === 'string' ? frame.reason : 'closed', false);
        return;
      }
      case 'window': {
        const c = isChannelId(frame.ch) ? this.channels.get(frame.ch) : undefined;
        if (c && typeof frame.credit === 'number') c.stream.credit(frame.credit);
        return;
      }
      default:
        return;
    }
  }

  private refuse(ch: number, reason: string): void {
    this.send({ type: 'close', ch, reason });
  }

  private cancelPending(socket: WebSocket | null): void {
    for (const [ch, pending] of this.pending) {
      if (socket !== null && pending.socket !== socket) continue;
      pending.cancelled = true;
      this.pending.delete(ch);
    }
  }

  private async open(frame: Record<string, unknown>): Promise<void> {
    // Bound to the socket that received this open. Docker inspect can outlive
    // it: a close for this channel, or a reconnect (channels number from 1
    // again), must not accept or exec.
    const socket = this.ws;
    if (!socket) return;
    const same = (): boolean => this.ws === socket && !this.stopped && socket.readyState === WebSocket.OPEN;
    const { ch, appCh, kind } = frame;
    if (!isChannelId(ch)) return;
    if (!isChannelId(appCh) || (kind !== 'control' && kind !== 'attach') || !rawKey((frame.e2e as Record<string, unknown> | undefined)?.appEphemeralPub)) {
      return this.refuse(ch, 'bad-open');
    }
    if (this.channels.has(ch)) return this.refuse(ch, 'channel-in-use');
    if (this.pending.has(ch)) return;
    const envId = kind === 'attach' ? frame.envId : null;
    if (kind === 'attach') {
      if (typeof envId !== 'string' || !ENV_ID_RE.test(envId)) return this.refuse(ch, 'bad-open');
      const pending: PendingOpen = { socket, cancelled: false };
      this.pending.set(ch, pending);
      let state: string | null = null;
      try {
        state = await this.deps.instanceState(envId);
      } catch {
        if (pending.cancelled || !same()) return;
        return this.refuse(ch, 'docker-unavailable');
      } finally {
        if (this.pending.get(ch) === pending) this.pending.delete(ch);
      }
      if (pending.cancelled || !same()) return;
      if (state === null) return this.refuse(ch, 'not-found');
      if (state !== 'running') return this.refuse(ch, 'not-running');
    }
    if (!same()) return;
    let handshake: ReturnType<typeof acceptRunnerHandshake>;
    try {
      const appEphemeralPub = (frame.e2e as { appEphemeralPub: string }).appEphemeralPub;
      handshake = acceptRunnerHandshake({ appCh, kind, envId: envId as string | null }, appEphemeralPub, this.deps.key);
    } catch (err) {
      if (err instanceof ChannelCryptoError) return this.refuse(ch, 'bad-handshake');
      throw err;
    }
    this.send({ type: 'accept', ch, e2e: handshake.reply });
    const channel = kind === 'control' ? this.controlChannel(ch, handshake.cipher) : this.attachChannel(ch, envId as string, handshake.cipher);
    this.channels.set(ch, channel);
    this.deps.log.info('channel.open', { kind, envId });
  }

  private transport(ch: number) {
    return {
      data: (buf: Buffer) => {
        const ws = this.ws;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(buf);
      },
      window: (credit: number) => this.send({ type: 'window', ch, credit }),
    };
  }

  private controlChannel(ch: number, cipher: ReturnType<typeof acceptRunnerHandshake>['cipher']): Channel {
    let buf = '';
    let closed = false;
    const write = (frame: ControlRunnerFrame): void => {
      if (!closed) stream.write(Buffer.from(JSON.stringify(frame) + '\n', 'utf8'));
    };
    const emit = (ev: ControlEvent): void => write({ t: 'event', ev });
    const channel: Channel = {
      ch,
      kind: 'control',
      envId: null,
      stream: null as unknown as ChannelStream,
      close: (reason, tell) => {
        if (closed) return;
        closed = true;
        stream.close();
        this.channels.delete(ch);
        if (tell) this.refuse(ch, reason);
        this.deps.log.info('channel.closed', { kind: 'control', reason });
      },
    };
    const stream = new ChannelStream({
      ch,
      cipher,
      transport: this.transport(ch),
      onError: (reason) => channel.close(reason, true),
      onData: (plaintext, done) => {
        buf += plaintext.toString('utf8');
        done();
        if (buf.length > RUNNER_LIMITS.maxFrameBytes * 2) return channel.close('frame-too-large', true);
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            write({ t: 'error', code: 'bad-frame', message: 'Each line must be one JSON frame.' });
            continue;
          }
          void this.deps.control.handle(parsed, emit).then(write);
        }
      },
    });
    channel.stream = stream;
    write(welcomeFrame(this.deps.runnerId, this.deps.version));
    return channel;
  }

  private attachChannel(ch: number, envId: string, cipher: ReturnType<typeof acceptRunnerHandshake>['cipher']): Channel {
    const child: ChildProcessWithoutNullStreams = this.deps.spawner(attachArgs(envId));
    let closed = false;
    let bytesIn = 0;
    let bytesOut = 0;
    const channel: Channel = {
      ch,
      kind: 'attach',
      envId,
      stream: null as unknown as ChannelStream,
      close: (reason, tell) => {
        if (closed) return;
        closed = true;
        stream.close();
        this.channels.delete(ch);
        child.stdin.end();
        child.kill();
        if (tell) this.refuse(ch, reason);
        this.deps.log.info('channel.closed', { kind: 'attach', envId, reason, bytesIn, bytesOut });
      },
    };
    const stream = new ChannelStream({
      ch,
      cipher,
      transport: this.transport(ch),
      onError: (reason) => channel.close(reason, true),
      onDrain: () => child.stdout.resume(),
      onData: (plaintext, done) => {
        bytesIn += plaintext.length;
        if (child.stdin.write(plaintext)) done();
        else child.stdin.once('drain', done);
      },
    });
    channel.stream = stream;
    child.stdout.on('data', (chunk: Buffer) => {
      bytesOut += chunk.length;
      if (!stream.write(chunk)) child.stdout.pause();
    });
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', () => undefined);
    child.on('error', () => channel.close('daemon-unavailable', true));
    child.on('close', () => {
      // Let queued output reach the app before the close does.
      const finish = (): void => channel.close('daemon-closed', true);
      if (stream.pending === 0) finish();
      else setTimeout(finish, 1_000);
    });
    return channel;
  }
}
