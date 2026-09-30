/**
 * The delivery journal: `/puck/state/delivery/journal.ndjson` (root 0600),
 * the write-ahead log of tickets, their workflows and every delivery
 * record. It is append-only, never pruned or rewritten, and the only
 * authority: `items.json` and `delivery/tables.json` are checkpoints of it
 * (see `docs/delivery-workflow-spec.md`, 6.6).
 *
 * Transactions. One operation's events are one transaction, applied whole
 * or not at all. A transaction whose line fits in 256 KiB is one line,
 * `{ j, at, op, events }`. A larger one is its JSON text `{ at, op, events }`
 * cut at byte boundaries into base64 fragments of at most 190 KiB, each
 * `{ j, at, tx, part, data }`, closed by `{ j, at, tx, commit, bytes, sha256 }`.
 * `j` numbers lines without gaps.
 *
 * Write path. Every line of a transaction is written in a byte loop, then
 * fsynced once. On any error the file is truncated back to where the
 * transaction started and fsynced: the transaction did not happen. If that
 * fails too, the journal is failing: nothing is appended again in this
 * process, and every mutation is refused until a boot finds the file sound.
 *
 * Boot. The file is read whole. A final line without a newline, a final
 * line that does not parse, fragments whose commit never came, and a commit
 * whose bytes or sha256 do not match at the tail are a torn tail: the file
 * is truncated to the end of the last committed transaction. Anything else
 * out of place, or a gap in `j`, is corruption and fails the boot.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DaemonEvent, WorkItem } from '../../harness/daemon-protocol';
import { newId } from '../../harness/ulid';
import { nullLogger, type Logger } from '../log';
import type { TablesFile } from '../store/delivery';
import type { ItemRecord, ItemsFile } from '../store/items';
import type { JsonStore } from '../store/store';
import { applyItems, applyTables, asJournalEvents, JOURNAL_ONLY, type ItemsDelta, type LedgerEvent } from './derive';

export const JOURNAL_LIMITS = {
  /** A single-line transaction, newline included. */
  lineBytes: 256 * 1024,
  /** Transaction text per fragment, before base64. */
  fragmentBytes: 190 * 1024,
} as const;

export interface JournalEvent {
  kind: string;
  [key: string]: unknown;
}

/** A committed transaction as replay reads it. */
export interface Transaction {
  /** The `j` of its first line. */
  first: number;
  /** The `j` of its last line (the commit line of a fragmented one). */
  last: number;
  at: number;
  op: string;
  events: JournalEvent[];
}

/** The file operations the journal performs. Tests inject failures and crashes here. */
export interface JournalIO {
  /** The whole file, or null when it does not exist. */
  read(file: string): Buffer | null;
  /** Open for appending (created 0600 when missing). */
  openAppend(file: string): number;
  /** One write; returns the bytes written, which may be fewer than asked. */
  write(fd: number, buf: Buffer, offset: number, length: number): number;
  fsync(fd: number): void;
  truncate(fd: number, size: number): void;
  close(fd: number): void;
}

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some filesystems refuse directory fsync.
  }
}

export const nodeJournalIO: JournalIO = {
  read(file) {
    try {
      return fs.readFileSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  openAppend(file) {
    const existed = fs.existsSync(file);
    const fd = fs.openSync(file, 'a', 0o600);
    fs.fchmodSync(fd, 0o600);
    if (!existed) fsyncDir(path.dirname(file));
    return fd;
  },
  write: (fd, buf, offset, length) => fs.writeSync(fd, buf, offset, length),
  fsync: (fd) => fs.fsyncSync(fd),
  truncate: (fd, size) => fs.ftruncateSync(fd, size),
  close: (fd) => fs.closeSync(fd),
};

/** A write the journal refused or could not make. `code` is the op error clients see. */
export class JournalError extends Error {
  constructor(
    readonly code: 'internal' | 'not-ready',
    message: string,
  ) {
    super(message);
    this.name = 'JournalError';
  }
}

/** The journal is damaged somewhere other than its tail; the boot fails. */
export class JournalDamagedError extends Error {
  constructor(
    readonly line: number,
    readonly file: string,
  ) {
    super(`The delivery journal is damaged at line ${line}; restore ${file} from a backup.`);
    this.name = 'JournalDamagedError';
  }
}

/**
 * items.json is ahead of the journal (a journal restored from an older
 * backup) and the journal cannot rebuild it: it holds no bootstrap marker,
 * so not every ticket has its ticket.created. The boot fails.
 */
export class CheckpointAheadError extends Error {
  constructor(
    readonly journalSeq: number,
    readonly head: number,
  ) {
    super(
      `items.json holds journal records up to ${journalSeq} but the delivery journal ends at ${head}, and the journal cannot rebuild it; restore items.json and delivery/journal.ndjson from the same backup.`,
    );
    this.name = 'CheckpointAheadError';
  }
}

export const JOURNAL_FAILING = 'The delivery journal is failing; see the environment log.';
export const JOURNAL_NOT_RECORDED = 'The delivery journal could not record the change.';

interface Scan {
  transactions: Transaction[];
  /** Byte offset just after the last committed transaction. */
  cleanEnd: number;
  lastJ: number;
}

function parseBody(body: Buffer): { at?: unknown; op?: unknown; events?: unknown } | null {
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    return value && typeof value === 'object' ? (value as { at?: unknown; op?: unknown; events?: unknown }) : null;
  } catch {
    return null;
  }
}

type Line = { j?: unknown; at?: unknown; op?: unknown; events?: unknown; tx?: unknown; part?: unknown; data?: unknown; commit?: unknown; bytes?: unknown; sha256?: unknown };

/** Reads every committed transaction; throws JournalDamagedError on corruption. */
export function scanJournal(buf: Buffer, file: string): Scan {
  const transactions: Transaction[] = [];
  let pos = 0;
  let lineNo = 0;
  let cleanEnd = 0;
  let lastJ = 0;
  let pending: { tx: string; first: number; parts: Buffer[] } | null = null;
  const damaged = (): never => {
    throw new JournalDamagedError(lineNo, file);
  };
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break; // a final line without its newline: torn
    lineNo += 1;
    const text = buf.toString('utf8', pos, nl);
    pos = nl + 1;
    const atTail = pos >= buf.length;
    let line: Line;
    try {
      line = JSON.parse(text) as Line;
    } catch {
      if (atTail) break;
      return damaged();
    }
    if (!line || typeof line !== 'object' || line.j !== lastJ + 1 + (pending ? pending.parts.length : 0)) return damaged();
    const j = line.j as number;
    if (Array.isArray(line.events)) {
      if (pending || typeof line.op !== 'string' || typeof line.at !== 'number') return damaged();
      transactions.push({ first: j, last: j, at: line.at, op: line.op, events: line.events as JournalEvent[] });
      lastJ = j;
      cleanEnd = pos;
      continue;
    }
    if (typeof line.part === 'number') {
      if (typeof line.tx !== 'string' || typeof line.data !== 'string') return damaged();
      if (!pending) {
        if (line.part !== 1) return damaged();
        pending = { tx: line.tx, first: j, parts: [] };
      } else if (line.tx !== pending.tx || line.part !== pending.parts.length + 1) return damaged();
      pending.parts.push(Buffer.from(line.data, 'base64'));
      continue;
    }
    if (typeof line.commit === 'number') {
      if (!pending || line.tx !== pending.tx || line.commit !== pending.parts.length) return damaged();
      const body = Buffer.concat(pending.parts);
      const sound = line.bytes === body.length && line.sha256 === createHash('sha256').update(body).digest('hex');
      const parsed = sound ? parseBody(body) : null;
      if (!parsed || typeof parsed.op !== 'string' || typeof parsed.at !== 'number' || !Array.isArray(parsed.events)) {
        if (atTail) break; // the commit landed but its fragments did not: torn
        return damaged();
      }
      transactions.push({ first: pending.first, last: j, at: parsed.at, op: parsed.op, events: parsed.events as JournalEvent[] });
      pending = null;
      lastJ = j;
      cleanEnd = pos;
      continue;
    }
    return damaged();
  }
  return { transactions, cleanEnd, lastJ };
}

export interface OpenedJournal {
  journal: Journal;
  transactions: Transaction[];
  /** Bytes a torn tail left and boot truncated (0 when the file was sound). */
  tornBytes: number;
}

/** Boot: read, repair a torn tail, and open for appending. Throws JournalDamagedError. */
export function openJournal(file: string, opts: { io?: JournalIO; log?: Logger } = {}): OpenedJournal {
  const io = opts.io ?? nodeJournalIO;
  const log = opts.log ?? nullLogger;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const buf = io.read(file) ?? Buffer.alloc(0);
  const scan = scanJournal(buf, file);
  const fd = io.openAppend(file);
  const tornBytes = buf.length - scan.cleanEnd;
  if (tornBytes > 0) {
    io.truncate(fd, scan.cleanEnd);
    io.fsync(fd);
    log.warn('journal.torn-tail', { bytes: tornBytes });
  }
  return { journal: new Journal(fd, scan.lastJ, scan.cleanEnd, io, log), transactions: scan.transactions, tornBytes };
}

/** The encoded lines of one transaction, starting at line `j`. */
export function encodeTransaction(j: number, at: number, op: string, events: JournalEvent[]): string[] {
  const single = JSON.stringify({ j, at, op, events }) + '\n';
  if (Buffer.byteLength(single, 'utf8') <= JOURNAL_LIMITS.lineBytes) return [single];
  const body = Buffer.from(JSON.stringify({ at, op, events }), 'utf8');
  const tx = newId('txn', at);
  const lines: string[] = [];
  for (let off = 0, part = 1; off < body.length; off += JOURNAL_LIMITS.fragmentBytes, part++) {
    const data = body.subarray(off, off + JOURNAL_LIMITS.fragmentBytes).toString('base64');
    lines.push(JSON.stringify({ j: j + part - 1, at, tx, part, data }) + '\n');
  }
  const sha256 = createHash('sha256').update(body).digest('hex');
  lines.push(JSON.stringify({ j: j + lines.length, at, tx, commit: lines.length, bytes: body.length, sha256 }) + '\n');
  return lines;
}

export class Journal {
  private failed = false;

  constructor(
    private readonly fd: number,
    private lastJ: number,
    private size: number,
    private readonly io: JournalIO,
    private readonly log: Logger,
  ) {}

  /** The `j` of the last committed line (0 for an empty journal). */
  head(): number {
    return this.lastJ;
  }

  /** True once a failed write could not be undone: nothing is appended again. */
  failing(): boolean {
    return this.failed;
  }

  /**
   * Write one transaction durably. Throws JournalError when it did not
   * happen (`internal`) or when the journal is failing (`not-ready`).
   */
  append(op: string, events: JournalEvent[], at: number): Transaction {
    if (this.failed) throw new JournalError('not-ready', JOURNAL_FAILING);
    const first = this.lastJ + 1;
    const lines = encodeTransaction(first, at, op, events);
    const start = this.size;
    let written = 0;
    try {
      for (const line of lines) {
        const buf = Buffer.from(line, 'utf8');
        let off = 0;
        while (off < buf.length) off += this.io.write(this.fd, buf, off, buf.length - off);
        written += buf.length;
      }
      this.io.fsync(this.fd);
    } catch (err) {
      try {
        this.io.truncate(this.fd, start);
        this.io.fsync(this.fd);
      } catch (undo) {
        this.failed = true;
        this.log.error('journal.failing', undo, { op });
        throw new JournalError('not-ready', JOURNAL_FAILING);
      }
      this.log.error('journal.write-failed', err, { op });
      throw new JournalError('internal', JOURNAL_NOT_RECORDED);
    }
    this.size = start + written;
    this.lastJ = first + lines.length - 1;
    return { first, last: this.lastJ, at, op, events };
  }

  close(): void {
    try {
      this.io.close(this.fd);
    } catch {
      // closing at exit
    }
  }
}

/* ---------- The write path over the checkpoints ---------- */

export interface LedgerDeps {
  journal: Journal;
  items: JsonStore<ItemsFile>;
  tables: JsonStore<TablesFile>;
  /** Emit on the event log; throws when the log cannot record (the state is already durable). */
  emit(ev: DaemonEvent): void;
  /** The public shape of a ticket, with its workflow summary. */
  publicItem(item: ItemRecord): WorkItem;
  log: Logger;
  /** Test seam: the write path's crash points after the journal's fsync. */
  hooks?: { afterJournal?(tx: Transaction): void; afterItems?(tx: Transaction): void };
}

/**
 * Steps 4 and 5 of the write path: after the journal's one fsync, apply the
 * transaction to the in-memory state through the reducer, commit items.json
 * synchronously when a ticket record changed, save tables.json, and emit
 * the events clients see. The caller runs the transaction's side effects
 * (queue an input, start a session) after `commit` returns.
 */
export class Ledger {
  constructor(private readonly deps: LedgerDeps) {}

  failing(): boolean {
    return this.deps.journal.failing();
  }

  head(): number {
    return this.deps.journal.head();
  }

  commit(op: string, events: LedgerEvent[], at: number): { tx: Transaction; delta: ItemsDelta } {
    const tx = this.deps.journal.append(op, asJournalEvents(events), at);
    this.deps.hooks?.afterJournal?.(tx);
    const delta = applyItems(this.deps.items.get(), tx);
    if (delta.changed.size || delta.removed.size || delta.order) {
      try {
        this.deps.items.commit();
      } catch (err) {
        // The journal holds the change; the next boot rolls items.json forward.
        this.deps.log.error('store.write', err, { file: 'items.json' });
      }
    }
    this.deps.hooks?.afterItems?.(tx);
    applyTables(this.deps.tables.get(), tx);
    this.deps.tables.save();
    this.publish(events, delta);
    return { tx, delta };
  }

  private publish(events: readonly LedgerEvent[], delta: ItemsDelta): void {
    for (const ev of events) if (!JOURNAL_ONLY.has(ev.kind)) this.deps.emit(ev as DaemonEvent);
    const file = this.deps.items.get();
    for (const itemId of delta.removed) this.deps.emit({ kind: 'item.removed', itemId });
    for (const itemId of delta.changed) {
      const item = file.items[itemId];
      if (item) this.deps.emit({ kind: 'item.upsert', item: this.deps.publicItem(item) });
    }
    if (delta.order) this.deps.emit({ kind: 'backlog.order', order: file.order.slice() });
  }
}
