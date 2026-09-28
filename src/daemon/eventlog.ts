/**
 * The sequenced event log. Every state change a client renders is appended
 * here with a strictly increasing `seq` that starts at 1 and survives daemon
 * restarts, then fanned out to attached clients. A client that reconnects
 * with the last seq it applied gets exactly the events after it, as long as
 * they are still retained; otherwise it resyncs from a snapshot.
 *
 * On disk: `events/<firstSeq>.ndjson` segments of `segmentSize` events each.
 * Whole segments older than the newest `retention` events are deleted.
 *
 * Live text-deltas are coalesced per (session, turn, parentId): the first
 * delta opens a short window, later ones merge into it, and one event is
 * appended when the window closes. Any other event of the same session
 * flushes the window first, so per-session order is always preserved.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EVENT_LOG, type DaemonEvent } from '../harness/daemon-protocol';

export interface LoggedEvent {
  seq: number;
  at: number;
  ev: DaemonEvent;
}

export interface EventLogOptions {
  segmentSize?: number;
  retention?: number;
  coalesceMs?: number;
  now?: () => number;
}

interface Segment {
  first: number;
  last: number;
  file: string;
}

interface PendingDelta {
  key: string;
  ev: Extract<DaemonEvent, { kind: 'turn.event' }> & { event: { kind: 'text-delta'; text: string } };
  timer: ReturnType<typeof setTimeout>;
}

function segmentFile(dir: string, first: number): string {
  return path.join(dir, `${first}.ndjson`);
}

/** Reads a segment's events, dropping a torn final line left by a crash. */
function readSegment(file: string): LoggedEvent[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: LoggedEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as LoggedEvent);
    } catch {
      break;
    }
  }
  return out;
}

export class EventLog {
  private readonly segmentSize: number;
  private readonly retention: number;
  private readonly coalesceMs: number;
  private readonly now: () => number;
  private segments: Segment[] = [];
  private seq = 0;
  private readonly listeners = new Set<(e: LoggedEvent) => void>();
  private readonly pending = new Map<string, PendingDelta>();

  constructor(private readonly dir: string, opts: EventLogOptions = {}) {
    this.segmentSize = opts.segmentSize ?? EVENT_LOG.segmentSize;
    this.retention = opts.retention ?? EVENT_LOG.retention;
    this.coalesceMs = opts.coalesceMs ?? EVENT_LOG.coalesceMs;
    this.now = opts.now ?? Date.now;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.open();
  }

  private open(): void {
    const firsts = fs
      .readdirSync(this.dir)
      .map((name) => /^(\d+)\.ndjson$/.exec(name))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    for (const first of firsts) {
      const file = segmentFile(this.dir, first);
      const events = readSegment(file);
      const last = events.length ? events[events.length - 1].seq : first - 1;
      this.segments.push({ first, last, file });
    }
    // Rewrite the newest segment when it ends in a torn line, so the next
    // append starts on a clean line.
    const newest = this.segments[this.segments.length - 1];
    if (newest) {
      const events = readSegment(newest.file);
      const clean = events.map((e) => JSON.stringify(e) + '\n').join('');
      if (fs.readFileSync(newest.file, 'utf8') !== clean) fs.writeFileSync(newest.file, clean, { mode: 0o600 });
      this.seq = newest.last;
    }
  }

  /** The last seq appended (0 before the first event). */
  head(): number {
    return this.seq;
  }

  /** The oldest seq still on disk (head + 1 when the log is empty). */
  oldest(): number {
    const first = this.segments[0];
    return first && first.last >= first.first ? first.first : this.seq + 1;
  }

  subscribe(fn: (e: LoggedEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Append an event. Text-deltas may be held briefly for coalescing; every
   * other event is written (after its session's held delta) immediately.
   */
  append(ev: DaemonEvent): void {
    const sessionId = 'sessionId' in ev && typeof ev.sessionId === 'string' ? ev.sessionId : null;
    if (sessionId && ev.kind === 'turn.event' && ev.event.kind === 'text-delta' && this.coalesceMs > 0) {
      const key = `${ev.turnId}\u0000${ev.event.parentId ?? ''}`;
      const held = this.pending.get(sessionId);
      if (held && held.key === key) {
        held.ev.event.text += ev.event.text;
        return;
      }
      if (held) this.flushSession(sessionId);
      const copy = { ...ev, event: { ...ev.event } } as PendingDelta['ev'];
      const timer = setTimeout(() => this.flushSession(sessionId), this.coalesceMs);
      timer.unref?.();
      this.pending.set(sessionId, { key, ev: copy, timer });
      return;
    }
    if (sessionId) this.flushSession(sessionId);
    this.write(ev);
  }

  private flushSession(sessionId: string): void {
    const held = this.pending.get(sessionId);
    if (!held) return;
    clearTimeout(held.timer);
    this.pending.delete(sessionId);
    this.write(held.ev);
  }

  /** Write every held delta now (shutdown, snapshots). */
  flush(): void {
    for (const sessionId of [...this.pending.keys()]) this.flushSession(sessionId);
  }

  private write(ev: DaemonEvent): void {
    const entry: LoggedEvent = { seq: this.seq + 1, at: this.now(), ev };
    let segment = this.segments[this.segments.length - 1];
    if (!segment || segment.last - segment.first + 1 >= this.segmentSize) {
      segment = { first: entry.seq, last: entry.seq - 1, file: segmentFile(this.dir, entry.seq) };
      this.segments.push(segment);
      this.prune();
    }
    fs.appendFileSync(segment.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    segment.last = entry.seq;
    this.seq = entry.seq;
    for (const fn of this.listeners) fn(entry);
  }

  /** Drop whole segments that hold only events older than the retention window. */
  private prune(): void {
    const keepFrom = this.seq + 1 - this.retention;
    while (this.segments.length > 1 && this.segments[0].last < keepFrom) {
      const gone = this.segments.shift();
      if (gone) fs.rmSync(gone.file, { force: true });
    }
  }

  /**
   * Every retained event after `since`, or null when the client must resync:
   * a first attach (null), a cursor older than retention, or one ahead of
   * this log (the state was replaced).
   */
  since(since: number | null): LoggedEvent[] | null {
    if (since === null || since > this.seq || since < this.oldest() - 1) return null;
    const out: LoggedEvent[] = [];
    for (const segment of this.segments) {
      if (segment.last <= since) continue;
      for (const e of readSegment(segment.file)) if (e.seq > since) out.push(e);
    }
    return out;
  }

  close(): void {
    this.flush();
    this.listeners.clear();
  }
}
