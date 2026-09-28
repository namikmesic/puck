/**
 * The relay: runner sockets, app sockets, and the channels between them.
 * The wire contract is `src/channel/wire.ts`.
 *
 * What the relay decides, on metadata only:
 * - who may open what: a channel opens only to a runner the app's user owns,
 *   and an `attach` channel only to an active environment of that user on
 *   that runner;
 * - where frames go: the app's channel number is mapped to one on the
 *   runner's socket and back, and nothing else in a data frame is touched;
 * - how much may be in flight: the credit arithmetic of wire.ts, enforced
 *   per channel and direction, so a slow reader costs at most one window of
 *   memory and a sender that ignores credit loses its channel.
 *
 * What it never does: decrypt, inspect, store or log channel bytes. It logs
 * channel ids, kinds, byte counts and close reasons.
 *
 * Runner liveness is the time of the last frame of any kind. The live
 * record outlives a dropped socket, so a runner that restarts reads Idle or
 * Active throughout; after 60 s without a frame it reads Offline, and the
 * owner's apps get a `runner.upsert` for each change they would render.
 */

import type WebSocket from 'ws';
import {
  decodeData,
  isChannelId,
  MAX_CHANNEL_ID,
  MAX_CHANNELS_PER_APP,
  OFFLINE_AFTER_MS,
  OPEN_TIMEOUT_MS,
  rawKey,
  readdress,
  WINDOW_BYTES,
  type ChannelKind,
  type RunnerStatus,
} from '../channel/wire';
import { compareVersions } from './config';
import type { Hub, LiveRunner, PushEvent, ServerContext } from './context';
import { runnerView } from './runners';
import type { DockerInfo, Runner } from './store';

/** WebSocket close codes the relay uses (4000-4999 are application-defined). */
export const CLOSE = {
  unauthorized: 4401,
  removed: 4403,
  replaced: 4409,
  outdated: 4426,
  protocol: 1008,
  shutdown: 1001,
} as const;

interface RunnerConn {
  ws: WebSocket;
  runnerId: string;
  userId: string;
  channels: Map<number, Channel>;
  nextCh: number;
}

interface AppConn {
  ws: WebSocket;
  sessionId: string;
  userId: string;
  channels: Map<number, Channel>;
  /** Channel numbers whose `open` is still being checked. */
  pending: Set<number>;
}

interface Channel {
  app: AppConn;
  appCh: number;
  runner: RunnerConn;
  rch: number;
  kind: ChannelKind;
  envId: string | null;
  open: boolean;
  openedAt: number;
  /** Bytes forwarded in each direction and not yet credited back by the receiver. */
  toRunnerInFlight: number;
  toAppInFlight: number;
  bytesToRunner: number;
  bytesToApp: number;
}

function reasonText(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[^a-z0-9-]/gi, '').slice(0, 64) || 'closed' : 'closed';
}

function send(ws: WebSocket, frame: object): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function parseStatus(frame: Record<string, unknown>): RunnerStatus | null {
  const d = frame.docker as Record<string, unknown> | undefined;
  if (typeof frame.version !== 'string' || frame.version.length > 64 || typeof d !== 'object' || d === null) return null;
  const instances = Array.isArray(frame.instances) ? frame.instances.slice(0, 1000) : [];
  const numOrNull = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const strOrNull = (x: unknown) => (typeof x === 'string' && x.length <= 64 ? x : null);
  return {
    version: frame.version,
    docker: { ok: d.ok !== false, version: strOrNull(d.version), problem: strOrNull(d.problem), ncpu: numOrNull(d.ncpu), memTotal: numOrNull(d.memTotal) },
    maxEnvironments: numOrNull(frame.maxEnvironments),
    instances: instances
      .filter((i): i is { envId: string; state: string } => typeof i?.envId === 'string' && typeof i?.state === 'string')
      .map((i) => ({ envId: i.envId.slice(0, 64), state: i.state.slice(0, 32) })),
  };
}

export class Relay implements Hub {
  private runners = new Map<string, RunnerConn>();
  private lives = new Map<string, LiveRunner & { shown: string }>();
  private apps = new Set<AppConn>();
  private stopSweep: () => void;
  private ctx!: ServerContext;

  constructor(private clock: ServerContext['clock']) {
    this.stopSweep = clock.every(5_000, () => this.sweep());
  }

  /** The context is created around the relay; it is handed in once both exist. */
  bind(ctx: ServerContext): void {
    this.ctx = ctx;
  }

  close(): void {
    this.stopSweep();
    for (const conn of this.runners.values()) conn.ws.close(CLOSE.shutdown, 'server-shutdown');
    for (const app of this.apps) app.ws.close(CLOSE.shutdown, 'server-shutdown');
  }

  /* ---------- Hub ---------- */

  live(runnerId: string): LiveRunner | null {
    return this.lives.get(runnerId) ?? null;
  }

  push(userId: string, event: PushEvent): void {
    for (const app of this.apps) if (app.userId === userId) send(app.ws, { type: 'event', event });
  }

  dropSession(sessionId: string): void {
    for (const app of [...this.apps]) if (app.sessionId === sessionId) app.ws.close(CLOSE.unauthorized, 'signed-out');
  }

  dropRunner(runnerId: string, reason: string): void {
    const conn = this.runners.get(runnerId);
    this.lives.delete(runnerId);
    if (conn) {
      this.detachRunner(conn, reason);
      conn.ws.close(CLOSE.removed, reason);
    }
  }

  /* ---------- Liveness ---------- */

  private sweep(): void {
    const now = this.clock.now();
    for (const [runnerId, live] of this.lives) {
      if (now - live.lastFrameAt >= OFFLINE_AFTER_MS) {
        this.lives.delete(runnerId);
        const conn = this.runners.get(runnerId);
        if (conn) conn.ws.terminate();
        void this.announce(runnerId);
      }
    }
    for (const app of this.apps) {
      for (const ch of [...app.channels.values()]) {
        if (!ch.open && now - ch.openedAt >= OPEN_TIMEOUT_MS) this.closeChannel(ch, 'open-timeout', true, true);
      }
    }
  }

  /** Pushes `runner.upsert` when what an app would render (status, running count, Docker) changed. */
  private async announce(runnerId: string): Promise<void> {
    const runner = await this.ctx.store.getRunner(runnerId);
    if (!runner || runner.removedAt !== null) return;
    const view = runnerView(this.ctx, runner);
    const shown = JSON.stringify([view.status, view.running, view.docker, view.version]);
    const live = this.lives.get(runnerId);
    if (live) {
      if (live.shown === shown) return;
      live.shown = shown;
    }
    this.push(runner.userId, { type: 'runner.upsert', runner: view });
  }

  private touch(runnerId: string): void {
    const live = this.lives.get(runnerId);
    if (live) live.lastFrameAt = this.clock.now();
  }

  /* ---------- Runner sockets ---------- */

  attachRunner(ws: WebSocket, runner: Runner): void {
    const previous = this.runners.get(runner.id);
    if (previous) {
      this.detachRunner(previous, 'runner-reconnected');
      previous.ws.close(CLOSE.replaced, 'replaced');
    }
    const conn: RunnerConn = { ws, runnerId: runner.id, userId: runner.userId, channels: new Map(), nextCh: 1 };
    this.runners.set(runner.id, conn);
    const now = this.clock.now();
    const kept = this.lives.get(runner.id);
    this.lives.set(runner.id, { connectedAt: now, lastFrameAt: now, instances: kept?.instances ?? [], shown: kept?.shown ?? '' });
    this.ctx.log.info('runner connected', { runnerId: runner.id });

    ws.on('message', (data, isBinary) => {
      if (this.runners.get(runner.id) !== conn) return;
      this.touch(runner.id);
      if (isBinary) return this.fromRunnerData(conn, data as Buffer);
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return ws.close(CLOSE.protocol, 'bad-frame');
      }
      void this.fromRunnerControl(conn, frame).catch((err) => {
        this.ctx.log.error('runner frame failed', { runnerId: runner.id, error: err instanceof Error ? err.name : 'unknown' });
      });
    });
    ws.on('close', () => {
      if (this.runners.get(runner.id) !== conn) return;
      this.detachRunner(conn, 'runner-offline');
      this.ctx.log.info('runner disconnected', { runnerId: runner.id });
      void this.ctx.store.updateRunner(runner.id, { lastSeenAt: this.clock.now() }).catch(() => undefined);
    });
  }

  private detachRunner(conn: RunnerConn, reason: string): void {
    for (const ch of [...conn.channels.values()]) this.closeChannel(ch, reason, true, false);
    if (this.runners.get(conn.runnerId) === conn) this.runners.delete(conn.runnerId);
  }

  private async fromRunnerControl(conn: RunnerConn, frame: Record<string, unknown>): Promise<void> {
    switch (frame.type) {
      case 'hello':
      case 'status': {
        const status = parseStatus(frame);
        if (!status) return conn.ws.close(CLOSE.protocol, 'bad-status');
        const min = this.ctx.config.minRunnerVersion;
        if (min && compareVersions(status.version, min) < 0) return conn.ws.close(CLOSE.outdated, 'runner-outdated');
        const live = this.lives.get(conn.runnerId);
        if (live) live.instances = status.instances;
        const docker: DockerInfo = status.docker;
        await this.ctx.store.updateRunner(conn.runnerId, {
          version: status.version,
          docker,
          maxEnvironments: status.maxEnvironments,
          lastSeenAt: this.clock.now(),
        });
        await this.announce(conn.runnerId);
        return;
      }
      case 'accept': {
        const ch = isChannelId(frame.ch) ? conn.channels.get(frame.ch) : undefined;
        const e2e = frame.e2e as Record<string, unknown> | undefined;
        if (!ch || ch.open) return;
        if (!rawKey(e2e?.runnerEphemeralPub) || typeof e2e?.sig !== 'string' || e2e.sig.length > 128) {
          return this.closeChannel(ch, 'bad-accept', true, true);
        }
        ch.open = true;
        send(ch.app.ws, { type: 'accept', ch: ch.appCh, e2e: { runnerEphemeralPub: e2e.runnerEphemeralPub, sig: e2e.sig } });
        this.ctx.log.info('channel open', { runnerId: conn.runnerId, kind: ch.kind, envId: ch.envId });
        return;
      }
      case 'close': {
        const ch = isChannelId(frame.ch) ? conn.channels.get(frame.ch) : undefined;
        if (ch) this.closeChannel(ch, reasonText(frame.reason), true, false);
        return;
      }
      case 'window': {
        const ch = isChannelId(frame.ch) ? conn.channels.get(frame.ch) : undefined;
        if (!ch) return;
        // The runner consumed data the app sent: credit the app → runner direction.
        if (!this.credit(ch, 'toRunnerInFlight', frame.credit)) return this.closeChannel(ch, 'flow-control', true, true);
        send(ch.app.ws, { type: 'window', ch: ch.appCh, credit: frame.credit });
        return;
      }
      case 'ping':
        send(conn.ws, { type: 'pong', t: frame.t });
        return;
      default:
        return;
    }
  }

  private fromRunnerData(conn: RunnerConn, data: Buffer): void {
    const frame = decodeData(data);
    if (!frame) return conn.ws.close(CLOSE.protocol, 'bad-data');
    const ch = conn.channels.get(frame.ch);
    if (!ch || !ch.open) return;
    if (ch.toAppInFlight + frame.payload.length > WINDOW_BYTES) return this.closeChannel(ch, 'flow-control', true, true);
    ch.toAppInFlight += frame.payload.length;
    ch.bytesToApp += frame.payload.length;
    if (ch.app.ws.readyState === ch.app.ws.OPEN) ch.app.ws.send(readdress(data, ch.appCh));
  }

  /* ---------- App sockets ---------- */

  attachApp(ws: WebSocket, sessionId: string, userId: string): void {
    const app: AppConn = { ws, sessionId, userId, channels: new Map(), pending: new Set() };
    this.apps.add(app);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.fromAppData(app, data as Buffer);
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return ws.close(CLOSE.protocol, 'bad-frame');
      }
      void this.fromAppControl(app, frame).catch((err) => {
        this.ctx.log.error('app frame failed', { error: err instanceof Error ? err.name : 'unknown' });
      });
    });
    ws.on('close', () => {
      this.apps.delete(app);
      for (const ch of [...app.channels.values()]) this.closeChannel(ch, 'app-gone', false, true);
    });
  }

  private async fromAppControl(app: AppConn, frame: Record<string, unknown>): Promise<void> {
    switch (frame.type) {
      case 'open':
        return this.openChannel(app, frame);
      case 'close': {
        const ch = isChannelId(frame.ch) ? app.channels.get(frame.ch) : undefined;
        if (ch) this.closeChannel(ch, reasonText(frame.reason), false, true);
        return;
      }
      case 'window': {
        const ch = isChannelId(frame.ch) ? app.channels.get(frame.ch) : undefined;
        if (!ch) return;
        // The app consumed data the runner sent: credit the runner → app direction.
        if (!this.credit(ch, 'toAppInFlight', frame.credit)) return this.closeChannel(ch, 'flow-control', true, true);
        send(ch.runner.ws, { type: 'window', ch: ch.rch, credit: frame.credit });
        return;
      }
      case 'ping':
        send(app.ws, { type: 'pong', t: frame.t });
        return;
      default:
        return;
    }
  }

  private async openChannel(app: AppConn, frame: Record<string, unknown>): Promise<void> {
    const appCh = frame.ch;
    if (!isChannelId(appCh)) return app.ws.close(CLOSE.protocol, 'bad-channel');
    const refuse = (reason: string) => send(app.ws, { type: 'close', ch: appCh, reason });
    if (app.channels.has(appCh) || app.pending.has(appCh)) return refuse('channel-in-use');
    if (app.channels.size + app.pending.size >= MAX_CHANNELS_PER_APP) return refuse('too-many-channels');
    const kind = frame.kind;
    const appEphemeralPub = (frame.e2e as Record<string, unknown> | undefined)?.appEphemeralPub;
    if ((kind !== 'control' && kind !== 'attach') || !rawKey(appEphemeralPub) || typeof frame.runnerId !== 'string') {
      return refuse('bad-open');
    }
    const envId = kind === 'attach' && typeof frame.envId === 'string' ? frame.envId : null;
    if (kind === 'attach' && !envId) return refuse('bad-open');

    // Reserve the number while the lookups run, so a second open cannot race it.
    app.pending.add(appCh);
    let runner: Runner | null;
    let instance: Awaited<ReturnType<ServerContext['store']['getInstance']>>;
    try {
      runner = await this.ctx.store.getRunner(frame.runnerId);
      instance = envId ? await this.ctx.store.getInstance(envId) : null;
    } finally {
      app.pending.delete(appCh);
    }
    if (!this.apps.has(app)) return;
    if (!runner || runner.userId !== app.userId || runner.removedAt !== null) return refuse('not-found');
    if (kind === 'attach' && (!instance || instance.userId !== app.userId || instance.runnerId !== runner.id || instance.status !== 'active')) {
      return refuse('not-found');
    }
    const conn = this.runners.get(runner.id);
    if (!conn) return refuse('runner-offline');

    let rch = conn.nextCh;
    while (conn.channels.has(rch)) rch = rch >= MAX_CHANNEL_ID ? 1 : rch + 1;
    conn.nextCh = rch >= MAX_CHANNEL_ID ? 1 : rch + 1;
    const ch: Channel = {
      app,
      appCh,
      runner: conn,
      rch,
      kind,
      envId,
      open: false,
      openedAt: this.clock.now(),
      toRunnerInFlight: 0,
      toAppInFlight: 0,
      bytesToRunner: 0,
      bytesToApp: 0,
    };
    app.channels.set(appCh, ch);
    conn.channels.set(rch, ch);
    send(conn.ws, { type: 'open', ch: rch, appCh, kind, envId, userId: app.userId, e2e: { appEphemeralPub } });
  }

  private fromAppData(app: AppConn, data: Buffer): void {
    const frame = decodeData(data);
    if (!frame) return app.ws.close(CLOSE.protocol, 'bad-data');
    const ch = app.channels.get(frame.ch);
    if (!ch || !ch.open) return;
    if (ch.toRunnerInFlight + frame.payload.length > WINDOW_BYTES) return this.closeChannel(ch, 'flow-control', true, true);
    ch.toRunnerInFlight += frame.payload.length;
    ch.bytesToRunner += frame.payload.length;
    if (ch.runner.ws.readyState === ch.runner.ws.OPEN) ch.runner.ws.send(readdress(data, ch.rch));
  }

  /* ---------- Channels ---------- */

  /** Applies returned credit; false when it is malformed or more than was in flight. */
  private credit(ch: Channel, field: 'toRunnerInFlight' | 'toAppInFlight', credit: unknown): boolean {
    if (!ch.open || typeof credit !== 'number' || !Number.isInteger(credit) || credit <= 0 || credit > ch[field]) return false;
    ch[field] -= credit;
    return true;
  }

  private closeChannel(ch: Channel, reason: string, tellApp: boolean, tellRunner: boolean): void {
    if (ch.app.channels.get(ch.appCh) !== ch) return;
    ch.app.channels.delete(ch.appCh);
    ch.runner.channels.delete(ch.rch);
    if (tellApp) send(ch.app.ws, { type: 'close', ch: ch.appCh, reason });
    if (tellRunner) send(ch.runner.ws, { type: 'close', ch: ch.rch, reason });
    this.ctx.log.info('channel closed', {
      runnerId: ch.runner.runnerId,
      kind: ch.kind,
      envId: ch.envId,
      reason,
      bytesToRunner: ch.bytesToRunner,
      bytesToApp: ch.bytesToApp,
    });
  }

  /** Test seam: bytes in flight per direction for the app's channel `appCh`. */
  inFlight(userId: string, appCh: number): { toRunner: number; toApp: number } | null {
    for (const app of this.apps) {
      const ch = app.userId === userId ? app.channels.get(appCh) : undefined;
      if (ch) return { toRunner: ch.toRunnerInFlight, toApp: ch.toAppInFlight };
    }
    return null;
  }
}
