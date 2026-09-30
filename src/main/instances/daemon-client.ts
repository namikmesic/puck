/**
 * One attached environment: the daemon protocol (src/harness/daemon-protocol.ts)
 * over attach channels that come from the environment's runner, through
 * whatever transport reaches it (the relay or This Mac's local socket).
 *
 * - Handshake: `hello` goes out in the same tick the channel opens (the
 *   daemon allows five seconds), with `since` = the last seq applied. On
 *   `welcome` with `replay: events` the daemon streams every later event;
 *   with `resync` the client reads `snapshot.get` and continues from its
 *   `head`, holding live events that arrive meanwhile.
 * - Events are applied once, in seq order: anything at or below the cursor
 *   is a duplicate from a replay overlap and is skipped. The cursor is
 *   handed to `saveSeq` after every event (the owner persists it debounced).
 * - Liveness: a ping every 15 s; no frame for 45 s closes the channel and
 *   reconnects with backoff 1, 2, 5, 10, then 30 s, reset by a welcome.
 * - Commands: typed, one id each, 30 s (60 s for history and snapshots).
 *   Commands in flight when the connection drops fail with `not-ready`, and
 *   nothing is retried automatically.
 * - Attach states: connecting, attached, reconnecting (a channel dropped),
 *   unreachable (the runner or server cannot be reached; it keeps trying),
 *   incompatible (protocol mismatch: stop), detached.
 * - Protocol. Every connection says hello with PROTOCOL_VERSION first. A
 *   daemon that predates it refuses with `protocol-mismatch`; the client
 *   then connects again at once with protocol 1 and maps what it receives
 *   up to the three-state model (`upgradeV1Item` in
 *   src/harness/workflow.ts): tickets in events, snapshots and results. The
 *   window shows such an environment read-only (the welcome's protocol
 *   says which), and the daemon update, a protocol-1 op, keeps working.
 *   The next reconnect tries PROTOCOL_VERSION again.
 * - Snapshots. Protocol 2's `snapshot.get` returns the bounded fields and
 *   a cursor; the client reads every part (`snapshot.part`) from the one
 *   frozen copy before it applies anything, holding live events meanwhile.
 *   `cmd('snapshot.get')` returns the assembled snapshot.
 */

import {
  addSnapshotPart,
  isKnownEvent,
  PROTOCOL_VERSION,
  protocolSupported,
  snapshotFromHead,
  WIRE_LIMITS,
  type ClientResult,
  type DaemonEvent,
  type DaemonFrame,
  type ErrorCode,
  type Op,
  type OpArgs,
  type Snapshot,
  type SnapshotHead,
  type SnapshotV1,
  type WorkItem,
  type WorkItemV1,
} from '../../harness/daemon-protocol';
import { upgradeV1Item } from '../../harness/workflow';
import { lines, type ByteChannel } from '../runners/channel';

export type AttachState = 'connecting' | 'attached' | 'reconnecting' | 'unreachable' | 'incompatible' | 'detached';

export class DaemonCommandError extends Error {
  constructor(
    readonly code: ErrorCode | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'DaemonCommandError';
  }
}

export interface DaemonClientDeps {
  envId: string;
  /** Opens an attach channel to this environment's daemon. */
  open(): Promise<ByteChannel>;
  /** The last seq applied for this environment, or null on first attach. */
  since(): number | null;
  saveSeq(seq: number): void;
  onEvent(seq: number, at: number, ev: DaemonEvent): void;
  /** A resync: the owner applies this snapshot in place of missed events. */
  onSnapshot(snapshot: Snapshot): void;
  onState(state: AttachState, detail: string): void;
  /** Each welcome: the current build and the head through which events are replayed. */
  onWelcome?(daemon: Snapshot['daemon'], head: number): void;
  client: { app: string; build: string };
  now?(): number;
  /** Test seam. */
  timing?: { pingMs?: number; idleMs?: number; welcomeMs?: number; backoffMs?: readonly number[] };
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const WELCOME_TIMEOUT_MS = 20_000;

/** Ops whose protocol-1 result is one ticket. */
const ITEM_RESULTS: ReadonlySet<string> = new Set(['item.create', 'item.update', 'item.assign', 'item.cancel', 'item.retry', 'item.accept', 'issue.import']);

/** A protocol-1 event in the three-state model. */
export function upgradeV1Event(ev: DaemonEvent): DaemonEvent {
  if (ev.kind === 'item.upsert') return { kind: 'item.upsert', item: upgradeV1Item(ev.item as unknown as WorkItemV1) };
  return ev;
}

/** A protocol-1 snapshot in the three-state model. */
export function upgradeV1Snapshot(snapshot: SnapshotV1): Snapshot {
  return { ...snapshot, items: snapshot.items.map(upgradeV1Item), decisions: [] };
}

export class DaemonClient {
  private channel: ByteChannel | null = null;
  private send: ((frame: unknown) => boolean) | null = null;
  private stopped = true;
  private failures = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private cursor: number | null = null;
  private n = 0;
  private readonly pending = new Map<string, Pending>();
  private state: AttachState = 'detached';
  private everAttached = false;
  private connecting = false;
  /** The protocol the current connection said hello with, and whether the next one falls back to 1. */
  private protocol: number = PROTOCOL_VERSION;
  private fallback = false;

  constructor(private readonly deps: DaemonClientDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get timing() {
    return {
      pingMs: this.deps.timing?.pingMs ?? WIRE_LIMITS.pingIntervalMs,
      idleMs: this.deps.timing?.idleMs ?? WIRE_LIMITS.idleTimeoutMs,
      welcomeMs: this.deps.timing?.welcomeMs ?? WELCOME_TIMEOUT_MS,
      backoffMs: this.deps.timing?.backoffMs ?? WIRE_LIMITS.reconnectBackoffS.map((s) => s * 1000),
    };
  }

  get attachState(): AttachState {
    return this.state;
  }

  get envId(): string {
    return this.deps.envId;
  }

  /** The protocol of the current connection (1 when the daemon predates protocol 2). */
  get protocolVersion(): number {
    return this.protocol;
  }

  private setState(state: AttachState, detail = ''): void {
    if (state === this.state && !detail) return;
    this.state = state;
    this.deps.onState(state, detail);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.failures = 0;
    this.cursor = this.deps.since();
    void this.connect();
  }

  /** Detaches: the daemon keeps working; nothing reconnects. */
  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.drop('detached');
    this.setState('detached');
  }

  /** Reconnect now (after a runner came back, say), skipping the backoff wait. */
  nudge(): void {
    if (this.stopped || this.channel || this.connecting) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    void this.connect();
  }

  private schedule(): void {
    if (this.stopped) return;
    const backoff = this.timing.backoffMs;
    const wait = backoff[Math.min(this.failures, backoff.length - 1)];
    this.failures++;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect();
    }, wait);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.channel || this.connecting) return;
    this.connecting = true;
    this.setState(this.everAttached ? 'reconnecting' : 'connecting');
    let channel: ByteChannel;
    try {
      channel = await this.deps.open();
    } catch (err) {
      this.connecting = false;
      if (this.stopped) return;
      this.setState('unreachable', err instanceof Error ? err.message : String(err));
      return this.schedule();
    }
    this.connecting = false;
    if (this.stopped) {
      channel.close('detached');
      return;
    }
    this.channel = channel;
    this.lastFrameAt = this.now();
    const protocol = this.fallback ? 1 : PROTOCOL_VERSION;
    this.fallback = false;
    this.protocol = protocol;
    let welcomed = false;
    let held: { seq: number; at: number; ev: DaemonEvent }[] | null = null;
    const welcomeTimer = setTimeout(() => {
      if (!welcomed && this.channel === channel) channel.close('no-welcome');
    }, this.timing.welcomeMs);

    const out = lines(channel, WIRE_LIMITS.maxFrameBytes * 2, (line) => {
      if (this.channel !== channel) return;
      this.lastFrameAt = this.now();
      let frame: DaemonFrame;
      try {
        frame = JSON.parse(line) as DaemonFrame;
      } catch {
        return;
      }
      switch (frame.t) {
        case 'welcome': {
          welcomed = true;
          clearTimeout(welcomeTimer);
          if (!protocolSupported(frame.protocol) || frame.protocol > PROTOCOL_VERSION) {
            this.stopped = true;
            this.setState('incompatible', `This environment's daemon speaks protocol ${frame.protocol}; update Puck to work in it.`);
            channel.close('protocol-mismatch');
            return;
          }
          this.failures = 0;
          this.everAttached = true;
          this.deps.onWelcome?.({ ...frame.daemon, protocol: frame.protocol }, frame.head);
          this.setState('attached');
          if (frame.replay === 'resync') {
            held = [];
            void this.resync(channel, () => {
              const buffered = held ?? [];
              held = null;
              for (const e of buffered) this.apply(e.seq, e.at, e.ev);
            });
          }
          return;
        }
        case 'event': {
          const ev = protocol === 1 ? upgradeV1Event(frame.ev) : frame.ev;
          if (held) held.push({ seq: frame.seq, at: frame.at, ev });
          else this.apply(frame.seq, frame.at, ev);
          return;
        }
        case 'res': {
          const p = this.pending.get(frame.id);
          if (!p) return;
          this.pending.delete(frame.id);
          clearTimeout(p.timer);
          if (frame.ok) p.resolve(frame.result);
          else p.reject(new DaemonCommandError(frame.error.code, frame.error.message));
          return;
        }
        case 'pong':
          return;
        case 'error':
          if (frame.code === 'protocol-mismatch') {
            if (!welcomed && protocol > 1) {
              // A daemon that predates this protocol: try protocol 1 at once.
              this.fallback = true;
              channel.close('protocol-fallback');
              return;
            }
            this.stopped = true;
            this.setState('incompatible', frame.message);
            channel.close('protocol-mismatch');
          }
          return;
      }
    });
    this.send = out.send;
    // Same tick as the open: the daemon's hello timer is already running.
    out.send({ t: 'hello', protocol, client: this.deps.client, since: this.cursor });

    this.pinger = setInterval(() => {
      if (this.channel !== channel) return;
      if (this.now() - this.lastFrameAt > this.timing.idleMs) {
        channel.close('idle');
        return;
      }
      out.send({ t: 'ping', at: this.now() });
    }, this.timing.pingMs);

    channel.onClose((reason) => {
      clearTimeout(welcomeTimer);
      if (this.channel !== channel) return;
      this.drop(reason);
      if (this.stopped) return;
      if (this.fallback) {
        void this.connect();
        return;
      }
      this.setState(this.everAttached ? 'reconnecting' : 'unreachable', reasonText(reason));
      this.schedule();
    });
  }

  private async resync(channel: ByteChannel, release: () => void): Promise<void> {
    try {
      const snapshot = await this.snapshot();
      if (this.channel !== channel) return;
      this.cursor = snapshot.head;
      this.deps.saveSeq(snapshot.head);
      this.deps.onSnapshot(snapshot);
      release();
    } catch {
      if (this.channel === channel) channel.close('resync-failed');
    }
  }

  private apply(seq: number, at: number, ev: DaemonEvent): void {
    if (this.cursor !== null && seq <= this.cursor) return;
    this.cursor = seq;
    this.deps.saveSeq(seq);
    // Unknown kinds advance the cursor but are never applied.
    if (isKnownEvent(ev)) this.deps.onEvent(seq, at, ev);
  }

  private drop(reason: string): void {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
    const channel = this.channel;
    this.channel = null;
    this.send = null;
    channel?.close(reason);
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new DaemonCommandError('not-ready', 'The connection to the environment dropped; try again.'));
    }
  }

  /**
   * The whole snapshot: protocol 2's head and every part, read from the one
   * frozen copy; protocol 1's whole snapshot, mapped up.
   */
  async snapshot(): Promise<Snapshot> {
    const raw = await this.raw('snapshot.get', {});
    if (this.protocol === 1 || Array.isArray((raw as { items?: unknown }).items)) return upgradeV1Snapshot(raw as SnapshotV1);
    const head = raw as SnapshotHead;
    const snapshot = snapshotFromHead(head);
    let cursor = head.partsCursor;
    while (cursor) {
      const part = (await this.raw('snapshot.part', { cursor })) as { collection: never; records: unknown[]; partsCursor: string | null };
      addSnapshotPart(snapshot, part);
      cursor = part.partsCursor;
    }
    return snapshot;
  }

  /** One daemon command; fails with `not-ready` while not attached. `snapshot.get` returns the assembled snapshot. */
  cmd<O extends Op>(op: O, args: OpArgs<O>, timeoutMs?: number): Promise<ClientResult<O>> {
    if (op === 'snapshot.get') return this.snapshot() as Promise<ClientResult<O>>;
    const legacy = this.protocol === 1;
    return this.raw(op, args, timeoutMs).then((result) =>
      legacy && ITEM_RESULTS.has(op) && result && typeof result === 'object' ? (upgradeV1Item(result as unknown as WorkItemV1) as WorkItem) : result,
    ) as Promise<ClientResult<O>>;
  }

  private raw(op: Op, args: unknown, timeoutMs?: number): Promise<unknown> {
    const send = this.send;
    if (!send || this.state !== 'attached') {
      return Promise.reject(new DaemonCommandError('not-ready', 'The environment is not attached yet.'));
    }
    const id = `a${++this.n}`;
    const ms = timeoutMs ?? (op === 'session.history' || op === 'snapshot.get' || op === 'snapshot.part' ? 60_000 : 30_000);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonCommandError('timeout', `The environment did not answer ${op} in time.`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer });
      send({ t: 'cmd', id, op, args });
    });
  }
}

function reasonText(reason: string): string {
  switch (reason) {
    case 'idle':
      return 'The environment stopped answering; reconnecting.';
    case 'relay-lost':
      return "Can't reach the Puck server; Puck keeps trying.";
    case 'daemon-closed':
      return 'The environment daemon restarted or stopped; reconnecting.';
    default:
      return `Reconnecting (${reason}).`;
  }
}
