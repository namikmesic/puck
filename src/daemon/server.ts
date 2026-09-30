/**
 * The daemon's control socket (/run/puck/puckd.sock, root 0600). Access to
 * `docker exec` into the container is the authentication; there are no
 * tokens on this channel, and agents (the puck user) cannot open it.
 *
 * Per connection: the client must send `hello` within a few seconds; an
 * unsupported protocol gets `protocol-mismatch` and the connection closes.
 * `welcome` says whether the client's cursor is still inside the event
 * log (then every missed event follows, then live ones) or it must resync
 * from `snapshot.get`. Commands are answered by id, in any order. Several
 * connections may be attached; every one gets every event.
 *
 * Each connection keeps the protocol it said hello with. A protocol-1
 * connection gets the projection of `protocol-v1.ts`: every event with its
 * own seq (unknown kinds as substitutes), projected results, and
 * `snapshot.get` whole. A protocol-2 connection whose cursor is from
 * before the state's format boundary resyncs, so it never applies an
 * eight-state record. Every result is measured before it is sent, and one
 * larger than a frame is refused with `limit` (protocol 1's whole snapshot
 * is the one exception, as today). Protocol 2's `snapshot.get` freezes the
 * whole snapshot and serves its growing collections in parts
 * (`SnapshotParts`), each below 512 KiB, all from the one copy.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import {
  PAGE_LIMITS,
  SNAPSHOT_COLLECTIONS,
  WIRE_LIMITS,
  isOp,
  protocolSupported,
  type ClientFrame,
  type DaemonEvent,
  type DaemonFrame,
  type ErrorCode,
  type InflightTurn,
  PROTOCOL_VERSION,
  type Snapshot,
  type SnapshotHead,
  type SnapshotPart,
  type SnapshotV1,
} from '../harness/daemon-protocol';
import { newId } from '../harness/ulid';
import type { EventLog, LoggedEvent } from './eventlog';
import type { Logger } from './log';
import { OpError } from './ops';
import { projectEvent, projectResult, V1_OPS, type ProjectionState } from './protocol-v1';

/** A client this far behind on reading is dropped (it reconnects and replays). */
const MAX_BACKLOG_BYTES = 64 * 1024 * 1024;

function exceedsFrame(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') > WIRE_LIMITS.maxFrameBytes;
}

export const FRAME_LIMIT_MESSAGE = 'The result is larger than one frame; page it.';

/** What a command knows about the connection it came on. */
export interface OpContext {
  protocol: number;
}

export interface ServerDeps {
  socketPath: string;
  log: Logger;
  events: EventLog;
  identity(): { envId: string; version: string; build: string };
  dispatch(op: string, args: unknown, ctx: OpContext): Promise<unknown>;
  /** Protocol 1's whole snapshot. */
  snapshotV1(): SnapshotV1;
  /** What protocol-1 substitutes are projected from, and the format boundary. */
  projection(): ProjectionState;
}

/* ---------- Snapshot parts ---------- */

const PART_ENVELOPE_BYTES = 512;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * A record as a part keeps it: parsed back from its own serialization, so
 * no part holds a live object (a coalesced text delta grows in place after
 * the snapshot's head), with its serialized size.
 */
function frozenRecord(record: unknown): { value: unknown; bytes: number } {
  const text = JSON.stringify(record);
  return { value: JSON.parse(text) as unknown, bytes: Buffer.byteLength(text, 'utf8') };
}

/** Serialized bytes of one character inside a JSON string (escapes counted). */
function jsonCharBytes(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x20 && code < 0x7f) return ch === '"' || ch === '\\' ? 2 : 1;
  return Buffer.byteLength(JSON.stringify(ch), 'utf8') - 2;
}

/**
 * A text delta cut into consecutive deltas whose text serializes within
 * `maxTextBytes` each. Cuts fall between code points, never inside a
 * surrogate pair, so the pieces joined in order are the original text.
 */
function splitText(event: InflightTurn['events'][number] & { kind: 'text-delta' }, maxTextBytes: number): InflightTurn['events'] {
  const out: InflightTurn['events'] = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of event.text) {
    const size = jsonCharBytes(ch);
    if (chunk && bytes + size > maxTextBytes) {
      out.push({ ...event, text: chunk });
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += size;
  }
  if (chunk || !out.length) out.push({ ...event, text: chunk });
  return out;
}

/**
 * An in-flight turn cut into records that each fit `budget` with the turn's
 * own fields: a turn too large for one record continues in the next records
 * under the same turnId, and a text delta too large for any record is cut
 * into consecutive deltas. Any other event is bounded by its adapter (tool
 * input and output are capped at a few KB); one that still does not fit is
 * an error rather than a silent cut.
 */
function splitInflight(turn: InflightTurn, budget: number): InflightTurn[] {
  if (jsonBytes(turn) <= budget) return [turn];
  const envelope = jsonBytes({ ...turn, events: [] });
  const room = budget - envelope - 1;
  const events: InflightTurn['events'] = [];
  for (const event of turn.events) {
    const size = jsonBytes(event);
    if (size <= room) events.push(event);
    else if (event.kind === 'text-delta') events.push(...splitText(event, room - jsonBytes({ ...event, text: '' })));
    else throw new Error(`An in-flight ${event.kind} event of ${size} bytes does not fit a snapshot part.`);
  }
  const out: InflightTurn[] = [];
  let batch: InflightTurn['events'] = [];
  let bytes = envelope;
  for (const event of events) {
    const size = jsonBytes(event) + 1;
    if (batch.length && bytes + size > budget) {
      out.push({ ...turn, events: batch });
      batch = [];
      bytes = envelope;
    }
    batch.push(event);
    bytes += size;
  }
  out.push({ ...turn, events: batch });
  return out;
}

/**
 * A snapshot's growing collections cut into parts of whole records, each
 * below `pageBytes` serialized. Every record is a copy taken now, and every
 * record, the first of a part included, fits the part's budget.
 */
export function snapshotParts(snapshot: Snapshot, pageBytes: number = PAGE_LIMITS.pageBytes): Omit<SnapshotPart, 'partsCursor'>[] {
  const budget = pageBytes - PART_ENVELOPE_BYTES;
  const parts: Omit<SnapshotPart, 'partsCursor'>[] = [];
  for (const collection of SNAPSHOT_COLLECTIONS) {
    const all: unknown[] =
      collection === 'inflight' ? snapshot.inflight.flatMap((t) => splitInflight(t, budget)) : (snapshot[collection] as unknown[]);
    let records: unknown[] = [];
    let bytes = 0;
    for (const record of all) {
      const frozen = frozenRecord(record);
      const size = frozen.bytes + 1;
      if (size > budget) throw new Error(`A record in ${collection} of ${frozen.bytes} bytes does not fit a snapshot part.`);
      if (records.length && bytes + size > budget) {
        parts.push({ collection, records });
        records = [];
        bytes = 0;
      }
      records.push(frozen.value);
      bytes += size;
    }
    if (records.length) parts.push({ collection, records });
  }
  return parts;
}

export function snapshotHead(snapshot: Snapshot, partsCursor: string | null): SnapshotHead {
  const { items: _i, order: _o, sessions: _s, inflight: _f, asks: _a, decisions: _d, ...rest } = snapshot;
  void [_i, _o, _s, _f, _a, _d];
  return { ...rest, partsCursor };
}

/**
 * Frozen protocol-2 snapshots. `freeze` copies the whole snapshot at its
 * head and returns the bounded fields with the first part's cursor; each
 * part names the next. A copy lives `ttlMs` after its last request.
 */
export class SnapshotParts {
  private readonly frozen = new Map<string, { parts: SnapshotPart[]; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly pageBytes: number;

  constructor(private readonly opts: { now: () => number; ttlMs?: number; pageBytes?: number }) {
    this.ttlMs = opts.ttlMs ?? PAGE_LIMITS.snapshotTtlMs;
    this.pageBytes = opts.pageBytes ?? PAGE_LIMITS.pageBytes;
  }

  private sweep(): void {
    const now = this.opts.now();
    for (const [id, entry] of this.frozen) if (entry.expiresAt <= now) this.frozen.delete(id);
  }

  freeze(snapshot: Snapshot): SnapshotHead {
    this.sweep();
    const id = newId('snp', this.opts.now());
    const cut = snapshotParts(snapshot, this.pageBytes);
    const cursor = (i: number): string | null => (i < cut.length ? `${id}.${i}` : null);
    const parts = cut.map((p, i) => ({ ...p, partsCursor: cursor(i + 1) }));
    if (parts.length) this.frozen.set(id, { parts, expiresAt: this.opts.now() + this.ttlMs });
    return snapshotHead(snapshot, cursor(0));
  }

  next(cursor: string): SnapshotPart {
    this.sweep();
    const m = /^(snp_[0-9A-Z]{26})\.(\d{1,6})$/.exec(cursor);
    const entry = m ? this.frozen.get(m[1] as string) : undefined;
    const part = entry && m ? entry.parts[Number(m[2])] : undefined;
    if (!entry || !part) throw new OpError('not-found', 'The snapshot expired; take a new one.');
    entry.expiresAt = this.opts.now() + this.ttlMs;
    return part;
  }

  /** Frozen copies still held (tests). */
  size(): number {
    return this.frozen.size;
  }
}

export class DaemonServer {
  private server: net.Server | null = null;
  private readonly clients = new Set<net.Socket>();
  private accepting = true;

  constructor(private readonly deps: ServerDeps) {}

  async listen(): Promise<void> {
    const { socketPath } = this.deps;
    // A socket file left by a previous daemon (the lock proves it is gone).
    fs.rmSync(socketPath, { force: true });
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Created 0600 from the start: no window where another user could connect.
      const oldMask = process.umask(0o177);
      server.listen(socketPath, () => {
        process.umask(oldMask);
        server.off('error', reject);
        resolve();
      });
    });
    fs.chmodSync(socketPath, 0o600);
  }

  /** Refuse new commands; attached clients still get events. */
  stopAccepting(): void {
    this.accepting = false;
  }

  async close(): Promise<void> {
    for (const socket of this.clients) socket.end();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private accept(socket: net.Socket): void {
    const { log, events } = this.deps;
    this.clients.add(socket);
    let buffer = '';
    let welcomed = false;
    let protocol = 0;
    let unsubscribe: (() => void) | null = null;

    const write = (text: string): void => {
      if (socket.destroyed) return;
      if (socket.writableLength > MAX_BACKLOG_BYTES) {
        log.warn('client.dropped', { reason: 'backlog' });
        socket.destroy();
        return;
      }
      socket.write(text + '\n');
    };
    const send = (frame: DaemonFrame): void => write(JSON.stringify(frame));
    const sendEvent = (e: LoggedEvent): void => {
      const ev = protocol === 1 ? projectEvent(e.seq, e.ev, this.deps.projection()) : e.ev;
      send({ t: 'event', seq: e.seq, at: e.at, ev: ev as DaemonEvent });
    };
    const fatal = (code: 'protocol-mismatch' | 'bad-frame', message: string): void => {
      send({ t: 'error', code, message });
      socket.end();
    };
    const helloTimer = setTimeout(() => fatal('bad-frame', 'Expected hello.'), WIRE_LIMITS.helloTimeoutMs);

    const onFrame = (frame: ClientFrame): void => {
      if (!welcomed) {
        if (frame.t !== 'hello') return fatal('bad-frame', 'Expected hello.');
        clearTimeout(helloTimer);
        if (!protocolSupported(frame.protocol)) {
          return fatal(
            'protocol-mismatch',
            `This daemon speaks protocol ${PROTOCOL_VERSION} (and ${PROTOCOL_VERSION - 1}); the client sent ${String(frame.protocol)}.`,
          );
        }
        const since = typeof frame.since === 'number' && Number.isInteger(frame.since) && frame.since >= 0 ? frame.since : null;
        protocol = frame.protocol;
        // Replay list, welcome and subscription happen in one tick, so no
        // event can fall between the replay and the live stream. A
        // protocol-2 cursor from before the format boundary resyncs.
        const boundary = this.deps.projection().formatBoundary;
        const replay = protocol >= 2 && since !== null && since < boundary ? null : events.since(since);
        const id = this.deps.identity();
        welcomed = true;
        send({
          t: 'welcome',
          protocol: frame.protocol,
          daemon: { version: id.version, build: id.build },
          envId: id.envId,
          head: events.head(),
          replay: replay ? 'events' : 'resync',
        });
        for (const e of replay ?? []) sendEvent(e);
        unsubscribe = events.subscribe((e: LoggedEvent) => sendEvent(e));
        log.info('client.attached', { protocol: frame.protocol, replay: replay ? replay.length : 'resync' });
        return;
      }
      if (frame.t === 'ping') {
        send({ t: 'pong', at: Date.now() });
        return;
      }
      if (frame.t !== 'cmd') return fatal('bad-frame', 'Unknown frame.');
      const cmdId = typeof frame.id === 'string' && frame.id.length <= 100 ? frame.id : null;
      if (!cmdId) return fatal('bad-frame', 'A command needs an id.');
      const fail = (code: ErrorCode, message: string): void => send({ t: 'res', id: cmdId, ok: false, error: { code, message } });
      if (!isOp(frame.op) || (protocol === 1 && !V1_OPS.has(frame.op))) return fail('invalid-args', `Unknown op ${String(frame.op).slice(0, 40)}.`);
      if (!this.accepting) return fail('not-ready', 'The daemon is shutting down.');
      const op = frame.op;
      if (protocol === 1 && op === 'snapshot.get') {
        // Protocol 1 cannot page: its snapshot goes out whole and unmeasured, as it always did.
        try {
          send({ t: 'res', id: cmdId, ok: true, result: this.deps.snapshotV1() });
        } catch (err) {
          log.error('command.failed', err, { op });
          fail('internal', err instanceof Error ? err.message : String(err));
        }
        return;
      }
      this.deps
        .dispatch(op, frame.args, { protocol })
        .then((result) => {
          const text = JSON.stringify({ t: 'res', id: cmdId, ok: true, result: (protocol === 1 ? projectResult(op, result) : result) ?? {} });
          if (exceedsFrame(text)) {
            log.warn('command.too-large', { op, bytes: Buffer.byteLength(text, 'utf8') });
            fail('limit', FRAME_LIMIT_MESSAGE);
          } else write(text);
        })
        .catch((err: unknown) => {
          if (err instanceof OpError) fail(err.code, err.message);
          else {
            log.error('command.failed', err, { op: frame.op });
            fail('internal', err instanceof Error ? err.message : String(err));
          }
        });
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (exceedsFrame(line)) return fatal('bad-frame', 'A frame is larger than 1 MiB.');
        if (!line.trim()) continue;
        let frame: ClientFrame;
        try {
          frame = JSON.parse(line) as ClientFrame;
        } catch {
          return fatal('bad-frame', 'A frame is not JSON.');
        }
        if (!frame || typeof frame !== 'object') return fatal('bad-frame', 'A frame is not an object.');
        onFrame(frame);
      }
      if (exceedsFrame(buffer)) return fatal('bad-frame', 'A frame is larger than 1 MiB.');
    });
    const cleanup = (): void => {
      clearTimeout(helloTimer);
      unsubscribe?.();
      this.clients.delete(socket);
    };
    socket.on('close', cleanup);
    socket.on('error', () => socket.destroy());
  }
}
