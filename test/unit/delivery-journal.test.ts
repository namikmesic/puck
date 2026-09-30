import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CheckpointAheadError,
  encodeTransaction,
  JOURNAL_LIMITS,
  JournalDamagedError,
  JournalError,
  nodeJournalIO,
  openJournal,
  type JournalEvent,
  type JournalIO,
} from '../../src/daemon/delivery/journal';
import { PIPELINE } from '../../src/daemon/delivery/derive';
import { nullLogger, type Logger } from '../../src/daemon/log';
import { migrateState } from '../../src/daemon/store/meta';
import { bootstrapLegacy, openFirstRound, queueImplement, ticketStatus } from '../../src/daemon/workflow';
import type { TicketTrigger } from '../../src/harness/item-transitions';
import { legacyIds } from '../../src/harness/workflow';
import { deliveryStack, LEGACY, LEGACY_T, seedTicket, writeLegacyState, type Stack } from './daemon-fakes';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-journal-'));
  file = path.join(dir, 'delivery', 'journal.ndjson');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function recordingLog(): Logger & { warns: { message: string; fields?: Record<string, unknown> }[] } {
  const warns: { message: string; fields?: Record<string, unknown> }[] = [];
  return {
    warns,
    info: () => undefined,
    warn: (message, fields) => warns.push({ message, fields }),
    error: () => undefined,
    files: () => [],
  };
}

const ev = (n: number, extra: Record<string, unknown> = {}): JournalEvent => ({ kind: 'ticket.patch', itemId: `itm_${n}`, change: { n }, ...extra });

/** Text full of characters JSON escapes, so the serialized size is far above the raw length. */
function escapeHeavy(bytes: number): string {
  const unit = '"\\\u0001\n\t<>';
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
}

/** A transaction far above one line: twenty check tails of 8 KB, each escape-heavy. */
function bigEvents(): JournalEvent[] {
  return Array.from({ length: 20 }, (_, i) => ({ kind: 'review.finished', reviewId: `rev_${i}`, outputTail: escapeHeavy(8 * 1024) })).concat(
    Array.from({ length: 50 }, (_, i) => ({ kind: 'finding.raised', finding: { id: `fnd_${i}`, description: escapeHeavy(4000), suggestedFix: escapeHeavy(4000) } })),
  );
}

function lines(): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

function js(): number[] {
  return lines().map((l) => (JSON.parse(l) as { j: number }).j);
}

/**
 * An IO whose `crash` fires once at a named point. After a crash, every call
 * throws: the process is gone, so nothing (not even the undo) reaches the file.
 */
function crashingIO(point: 'mid-write' | 'before-fsync', opts: { onWrite?: number } = {}): JournalIO & { crashed: boolean } {
  let writes = 0;
  const io = {
    crashed: false,
    read: nodeJournalIO.read,
    openAppend: nodeJournalIO.openAppend,
    close: nodeJournalIO.close,
    write(fd: number, buf: Buffer, offset: number, length: number): number {
      if (io.crashed) throw new Error('crashed');
      writes += 1;
      if (point === 'mid-write' && writes === (opts.onWrite ?? 1)) {
        nodeJournalIO.write(fd, buf, offset, Math.max(1, Math.floor(length / 2)));
        io.crashed = true;
        throw new Error('crash during the byte loop');
      }
      return nodeJournalIO.write(fd, buf, offset, length);
    },
    fsync(fd: number): void {
      if (io.crashed) throw new Error('crashed');
      if (point === 'before-fsync') {
        io.crashed = true;
        throw new Error('crash before fsync');
      }
      nodeJournalIO.fsync(fd);
    },
    truncate(fd: number, size: number): void {
      if (io.crashed) throw new Error('crashed');
      nodeJournalIO.truncate(fd, size);
    },
  };
  return io;
}

describe('delivery journal', () => {
  it('writes single-line transactions with gapless j and reads them back', () => {
    const { journal, transactions } = openJournal(file);
    expect(transactions).toEqual([]);
    const a = journal.append('item.create', [ev(1), ev(2)], 1000);
    const b = journal.append('item.patch', [ev(3)], 1001);
    expect([a.first, a.last, b.first, b.last]).toEqual([1, 1, 2, 2]);
    journal.close();
    const again = openJournal(file);
    expect(again.tornBytes).toBe(0);
    expect(again.transactions.map((t) => [t.first, t.op, t.at, t.events.length])).toEqual([
      [1, 'item.create', 1000, 2],
      [2, 'item.patch', 1001, 1],
    ]);
    expect(again.journal.head()).toBe(2);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
  });

  it('writes a transaction larger than a line as byte fragments closed by a commit line', () => {
    const events = bigEvents();
    const { journal } = openJournal(file);
    journal.append('small', [ev(1)], 1);
    const tx = journal.append('review.finish', events, 2);
    expect(tx.last - tx.first).toBeGreaterThan(1);
    const raw = lines();
    for (const l of raw) expect(Buffer.byteLength(l, 'utf8') + 1).toBeLessThanOrEqual(JOURNAL_LIMITS.lineBytes);
    const commit = JSON.parse(raw[raw.length - 1] as string) as { commit: number; bytes: number };
    expect(commit.commit).toBe(tx.last - tx.first);
    expect(js()).toEqual(Array.from({ length: tx.last }, (_, i) => i + 1));
    journal.close();
    const back = openJournal(file).transactions;
    expect(back[1]?.events).toEqual(events);
    expect(back[1]?.first).toBe(2);
  });

  it('repairs a torn tail of each kind and keeps appending without a gap or a reused j', () => {
    const tails: [string, (buf: string) => string][] = [
      ['a final line without a newline', (s) => s + '{"j":3,"at":1,"op":"x","events":[]}'],
      ['a final line that does not parse', (s) => s + '{"j":3,"at":1,"op":"x","eve\n'],
      [
        'fragments whose commit never came',
        (s) => s + encodeTransaction(3, 1, 'big', bigEvents()).slice(0, 2).join(''),
      ],
      [
        'a commit whose sha256 does not match',
        (s) => {
          const big = encodeTransaction(3, 1, 'big', bigEvents());
          const commit = JSON.parse(big[big.length - 1] as string) as Record<string, unknown>;
          commit.sha256 = '0'.repeat(64);
          return s + big.slice(0, -1).join('') + JSON.stringify(commit) + '\n';
        },
      ],
    ];
    for (const [name, tear] of tails) {
      fs.rmSync(path.join(dir, 'delivery'), { recursive: true, force: true });
      const first = openJournal(file);
      first.journal.append('a', [ev(1)], 1);
      first.journal.append('b', [ev(2)], 2);
      first.journal.close();
      const sound = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, tear(sound));
      const log = recordingLog();
      const opened = openJournal(file, { log });
      expect(opened.tornBytes, name).toBeGreaterThan(0);
      expect(log.warns[0], name).toEqual({ message: 'journal.torn-tail', fields: { bytes: opened.tornBytes } });
      expect(fs.readFileSync(file, 'utf8'), name).toBe(sound);
      expect(opened.transactions.map((t) => t.op), name).toEqual(['a', 'b']);
      opened.journal.append('c', [ev(3)], 3);
      opened.journal.close();
      expect(js(), name).toEqual([1, 2, 3]);
    }
  });

  it('refuses corruption anywhere but the tail, naming the line', () => {
    const cases: [string, (s: string[]) => string[], number][] = [
      ['a bad line in the middle', (s) => [s[0] as string, 'not json', s[1] as string], 2],
      ['a gap in j', (s) => [s[0] as string, (s[1] as string).replace('"j":2', '"j":3')], 2],
      ['a transaction without its commit before the tail', (s) => [s[0] as string, ...encodeTransaction(2, 1, 'big', bigEvents()).slice(0, 1), (s[1] as string).replace('"j":2', '"j":3')], 3],
    ];
    for (const [name, damage, line] of cases) {
      fs.rmSync(path.join(dir, 'delivery'), { recursive: true, force: true });
      const { journal } = openJournal(file);
      journal.append('a', [ev(1)], 1);
      journal.append('b', [ev(2)], 2);
      journal.close();
      fs.writeFileSync(file, damage(lines()).join('\n') + '\n');
      let caught: unknown = null;
      try {
        openJournal(file);
      } catch (err) {
        caught = err;
      }
      expect(caught, name).toBeInstanceOf(JournalDamagedError);
      expect((caught as JournalDamagedError).line, name).toBe(line);
      expect((caught as Error).message, name).toBe(`The delivery journal is damaged at line ${line}; restore ${file} from a backup.`);
    }
  });

  it('truncates a write that fails in a later fragment, and the next transaction commits and replays', () => {
    let writes = 0;
    const io: JournalIO = {
      ...nodeJournalIO,
      write(fd, buf, offset, length) {
        writes += 1;
        if (writes === 4) throw new Error('ENOSPC');
        return nodeJournalIO.write(fd, buf, offset, length);
      },
    };
    const { journal } = openJournal(file, { io });
    journal.append('a', [ev(1)], 1);
    const before = fs.statSync(file).size;
    expect(() => journal.append('big', bigEvents(), 2)).toThrow(new JournalError('internal', 'The delivery journal could not record the change.'));
    expect(fs.statSync(file).size).toBe(before);
    expect(journal.head()).toBe(1);
    journal.append('c', [ev(3)], 3);
    journal.close();
    expect(openJournal(file).transactions.map((t) => [t.first, t.op])).toEqual([
      [1, 'a'],
      [2, 'c'],
    ]);
  });

  it('stops appending once a failed write cannot be undone', () => {
    let failWrites = false;
    let writes = 0;
    const io: JournalIO = {
      ...nodeJournalIO,
      write(fd, buf, offset, length) {
        writes += 1;
        if (failWrites) {
          nodeJournalIO.write(fd, buf, offset, 5);
          throw new Error('EIO');
        }
        return nodeJournalIO.write(fd, buf, offset, length);
      },
      truncate() {
        throw new Error('EIO on truncate');
      },
    };
    const { journal } = openJournal(file, { io });
    journal.append('a', [ev(1)], 1);
    failWrites = true;
    expect(() => journal.append('b', [ev(2)], 2)).toThrow(new JournalError('not-ready', 'The delivery journal is failing; see the environment log.'));
    expect(journal.failing()).toBe(true);
    const writesBefore = writes;
    expect(() => journal.append('c', [ev(3)], 3)).toThrow(JournalError);
    expect(writes).toBe(writesBefore); // nothing appended after an unconfirmed write
    journal.close();
    // The next boot finds the partial line at the tail and recovers.
    const again = openJournal(file);
    expect(again.transactions.map((t) => t.op)).toEqual(['a']);
  });

  describe('crash injection: boot recovers the whole transaction or none of it', () => {
    const shapes: [string, () => JournalEvent[], number[]][] = [
      ['a single-line transaction', () => [ev(2)], [1]],
      ['a fragmented transaction', bigEvents, [1, 2, 3]],
    ];
    for (const [shape, events, writes] of shapes) {
      it(`${shape}, crashing during the byte loop`, () => {
        for (const onWrite of writes) {
          fs.rmSync(path.join(dir, 'delivery'), { recursive: true, force: true });
          const sound = openJournal(file);
          sound.journal.append('a', [ev(1)], 1);
          sound.journal.close();
          const io = crashingIO('mid-write', { onWrite });
          const crashing = openJournal(file, { io });
          expect(() => crashing.journal.append('b', events(), 2)).toThrow(JournalError);
          expect(io.crashed).toBe(true);
          const boot = openJournal(file);
          expect(boot.transactions.map((t) => t.op)).toEqual(['a']);
          boot.journal.append('c', [ev(3)], 3);
          boot.journal.close();
          expect(js()).toEqual([1, 2]);
        }
      });

      it(`${shape}, crashing after the write and before the fsync`, () => {
        const sound = openJournal(file);
        sound.journal.append('a', [ev(1)], 1);
        sound.journal.close();
        const base = fs.statSync(file).size;
        const io = crashingIO('before-fsync');
        const crashing = openJournal(file, { io });
        expect(() => crashing.journal.append('b', events(), 2)).toThrow(JournalError);
        const written = fs.readFileSync(file);
        // Whatever part of the unsynced write survived, boot applies all of it or none.
        for (const keep of [written.length, base, base + Math.floor((written.length - base) / 2), written.length - 1]) {
          fs.writeFileSync(file, written.subarray(0, keep));
          const boot = openJournal(file);
          const ops = boot.transactions.map((t) => t.op);
          expect(keep === written.length ? ops : ops.slice(0, 1)).toEqual(keep === written.length ? ['a', 'b'] : ['a']);
          const last = boot.transactions[boot.transactions.length - 1];
          boot.journal.append('c', [ev(3)], 3);
          boot.journal.close();
          const expected = Array.from({ length: (last?.last ?? 0) + 1 }, (_, i) => i + 1);
          expect(js()).toEqual(expected);
        }
      });
    }
  });
});

describe('the write path over the checkpoints: boot recovers the whole transaction or none of it', () => {
  class Crash extends Error {}

  /** A ticket with an agent: ticket.created, round.opened and two step.changed, one transaction. */
  function createTicket(stack: Stack, title: string): string {
    const tx = stack.workflow.begin('item.create');
    const item = stack.backlog.create(tx, { title, body: '', agent: 'implementer', repo: null, createdBy: 'user' });
    openFirstRound(tx, item.id, 'assigned');
    queueImplement(tx, item.id, 1, { agent: 'implementer', sessionId: null, purpose: 'task' });
    stack.workflow.commit(tx);
    return item.id;
  }

  function state(dir: string) {
    const again = deliveryStack(dir, { now: () => 5 });
    const out = {
      tickets: again.backlog.list().map((i) => [i.title, i.status, i.stage, i.workflowId]),
      steps: Object.values(again.tables.get().workflows).map((w) => w.steps.map((s) => [s.kind, s.state, s.result])),
      rounds: Object.values(again.tables.get().workflows).map((w) => w.rounds.length),
      seq: [again.items.get().journalSeq, again.tables.get().journalSeq],
      head: again.journal.head(),
    };
    again.journal.close();
    return out;
  }

  const points = [
    ['after the fsync and before the items.json commit', { afterJournal: () => { throw new Crash('crash'); } }],
    ['after the items.json commit and before the tables and side effects', { afterItems: () => { throw new Crash('crash'); } }],
  ] as const;

  for (const [name, hooks] of points) {
    it(name, () => {
      const first = deliveryStack(path.join(dir, 's'), { now: () => 5 });
      createTicket(first, 'A');
      first.journal.close();
      const crashing = deliveryStack(path.join(dir, 's'), { now: () => 5, hooks });
      expect(() => createTicket(crashing, 'B')).toThrow(Crash);
      crashing.journal.close();
      // The journal held it: boot rolls both checkpoints forward to the whole transaction.
      const after = state(path.join(dir, 's'));
      expect(after.tickets).toEqual([
        ['A', 'todo', null, 'wfl_' + (after.tickets[0]?.[3] as string).slice(4)],
        ['B', 'todo', null, after.tickets[1]?.[3]],
      ]);
      expect(after.steps).toEqual([
        [['decompose', 'done', 'skipped'], ['implement', 'queued', null]],
        [['decompose', 'done', 'skipped'], ['implement', 'queued', null]],
      ]);
      expect(after.seq).toEqual([after.head, after.head]);
      // And the next transaction commits after it, without a gap or a reused j.
      const next = deliveryStack(path.join(dir, 's'), { now: () => 5 });
      createTicket(next, 'C');
      next.journal.close();
      expect(js()).toEqual(Array.from({ length: 3 }, (_, i) => i + 1));
    });
  }

  function js(): number[] {
    return fs
      .readFileSync(path.join(dir, 's', 'delivery', 'journal.ndjson'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { j: number }).j);
  }

  it('rebuilds tables.json from the first line when it is missing or unreadable', () => {
    const s = deliveryStack(path.join(dir, 's'), { now: () => 5 });
    createTicket(s, 'A');
    createTicket(s, 'B');
    s.journal.close();
    const before = state(path.join(dir, 's'));
    fs.writeFileSync(path.join(dir, 's', 'delivery', 'tables.json'), '{ not json');
    expect(state(path.join(dir, 's'))).toEqual(before);
    fs.rmSync(path.join(dir, 's', 'delivery', 'tables.json'));
    expect(state(path.join(dir, 's'))).toEqual(before);
  });

  it('refuses every mutation once the journal is failing, without appending', () => {
    let failWrites = false;
    const io: JournalIO = {
      ...nodeJournalIO,
      write(fd, buf, offset, length) {
        if (failWrites) throw new Error('EIO');
        return nodeJournalIO.write(fd, buf, offset, length);
      },
      truncate(fd, size) {
        if (failWrites) throw new Error('EIO on truncate');
        nodeJournalIO.truncate(fd, size);
      },
    };
    const s = deliveryStack(path.join(dir, 's'), { now: () => 5, io });
    createTicket(s, 'A');
    const size = fs.statSync(path.join(dir, 's', 'delivery', 'journal.ndjson')).size;
    failWrites = true;
    expect(() => createTicket(s, 'B')).toThrow(new JournalError('not-ready', 'The delivery journal is failing; see the environment log.'));
    failWrites = false;
    expect(s.workflow.failing()).toBe(true);
    expect(() => createTicket(s, 'C')).toThrow(JournalError);
    expect(fs.statSync(path.join(dir, 's', 'delivery', 'journal.ndjson')).size).toBe(size);
    expect(s.backlog.list().map((i) => i.title)).toEqual(['A']);
  });
});

describe('the format-2 bootstrap', () => {
  function migrated(d: string): void {
    writeLegacyState(d);
    expect(migrateState(d, { daemonVersion: 'new', now: 5, eventHead: 7 })).toMatchObject({ ok: true, to: 2 });
  }

  function journalEvents(d: string) {
    const opened = openJournal(path.join(d, 'delivery', 'journal.ndjson'));
    opened.journal.close();
    return opened.transactions;
  }

  function boot(d: string, hooks: { afterTicket?(itemId: string): void } = {}) {
    const s = deliveryStack(d, { now: () => 5 });
    try {
      return { journaled: bootstrapLegacy(s.workflow, s.backlog.list(), s.items.get().nextNumber, hooks), stack: s };
    } finally {
      s.journal.close();
    }
  }

  it('journals each ticket once with its legacy workflow, never a check or a review, then the marker', () => {
    const d = path.join(dir, 'clean');
    migrated(d);
    const { journaled } = boot(d);
    expect(journaled).toBe(Object.keys(LEGACY).length);
    const txs = journalEvents(d);
    expect(txs.map((t) => t.op)).toEqual([...Object.keys(LEGACY).map(() => 'journal.bootstrap'), 'journal.bootstrap']);
    const events = txs.flatMap((t) => t.events);
    expect(events.filter((e) => e.kind === 'journal.bootstrap')).toEqual([{ kind: 'journal.bootstrap', format: 2, tickets: journaled, nextNumber: journaled + 1 }]);
    const steps = events.filter((e) => e.kind === 'step.changed').map((e) => (e as unknown as { step: { kind: string; legacy?: true } }).step);
    expect(new Set(steps.map((s) => s.kind))).toEqual(new Set(['implement', 'merge']));
    expect(steps.every((s) => s.legacy === true)).toBe(true);
    const s = deliveryStack(d, { now: () => 5 });
    const review = s.backlog.get(LEGACY.review);
    expect(review).toMatchObject({ status: 'in-progress', stage: 'merge' });
    expect(s.pub(review as NonNullable<typeof review>).workflow?.steps.map((x) => [x.kind, x.state, x.result])).toEqual([
      ['implement', 'done', 'passed'],
      ['merge', 'waiting', null],
    ]);
    expect(s.tables.get().tickets[LEGACY.merged]).toMatchObject({ outcome: 'merged', closedAt: LEGACY_T + 100 + 9 });
    // The running ticket's implement step still runs until boot restarts it; its session stays linked.
    expect(s.workflow.activeImplement(LEGACY.running)).toMatchObject({ id: legacyIds(LEGACY.running).implementId, state: 'running', sessionId: expect.stringMatching(/^ses_/) });
    // A second boot journals nothing more.
    s.journal.close();
    expect(boot(d).journaled).toBe(0);
    expect(journalEvents(d)).toHaveLength(txs.length);
  });

  // One migration, a crashing boot and a resumed one per ticket, each fsynced: slow under a loaded suite.
  it('resumes after a crash after any ticket, ending in the same state with no duplicated ticket, id or record', { timeout: 30_000 }, () => {
    const clean = path.join(dir, 'clean');
    migrated(clean);
    boot(clean);
    const snapshot = (d: string) => {
      const s = deliveryStack(d, { now: () => 5 });
      const out = { items: s.items.get(), tables: { ...s.tables.get(), journalSeq: 0 } };
      s.journal.close();
      return JSON.parse(JSON.stringify(out)) as unknown;
    };
    const expected = snapshot(clean);
    const total = Object.keys(LEGACY).length;
    for (let crashAfter = 1; crashAfter <= total; crashAfter++) {
      const d = path.join(dir, `crash-${crashAfter}`);
      migrated(d);
      let n = 0;
      expect(() =>
        boot(d, {
          afterTicket: () => {
            n += 1;
            if (n === crashAfter) throw new Error('crash');
          },
        }),
      ).toThrow('crash');
      boot(d);
      expect(snapshot(d), `crash after ticket ${crashAfter}`).toEqual(expected);
      const events = journalEvents(d).flatMap((t) => t.events);
      const created = events.filter((e) => e.kind === 'ticket.created').map((e) => (e as unknown as { item: { id: string } }).item.id);
      expect(created.sort(), `crash after ticket ${crashAfter}`).toEqual(Object.values(LEGACY).sort());
      expect(events.filter((e) => e.kind === 'journal.bootstrap')).toHaveLength(1);
      const stepIds = events.filter((e) => e.kind === 'step.changed').map((e) => (e as unknown as { step: { id: string } }).step.id);
      expect(new Set(stepIds).size).toBe(stepIds.length);
    }
  });

  it('keeps each migrated updatedAt through bootstrap and a journal rebuild, and a live status stamps it', () => {
    const d = path.join(dir, 'updated-at');
    migrated(d);
    const migratedItems = (stack: Stack) => JSON.parse(JSON.stringify(stack.items.get().items)) as Record<string, { updatedAt: number; closedAt: number | null }>;
    const opened = deliveryStack(d, { now: () => 5 });
    const prior = migratedItems(opened);
    opened.journal.close();
    boot(d);
    const fresh = deliveryStack(d, { now: () => 5 });
    try {
      expect(migratedItems(fresh)).toEqual(prior);
      for (const id of Object.values(LEGACY)) {
        expect(fresh.tables.get().tickets[id]?.closedAt, id).toBe(prior[id]?.closedAt ?? null);
      }
    } finally {
      fresh.journal.close();
    }

    fs.rmSync(path.join(d, 'items.json'));
    fs.rmSync(path.join(d, 'delivery', 'tables.json'));
    let now = 5;
    const rebuilt = deliveryStack(d, { now: () => now });
    try {
      expect(migratedItems(rebuilt)).toEqual(prior);
      for (const id of Object.values(LEGACY)) {
        expect(rebuilt.tables.get().tickets[id]?.closedAt, id).toBe(prior[id]?.closedAt ?? null);
      }
      const live: { id: string; trigger: TicketTrigger; started?: boolean; at: number; closed: number | null }[] = [
        { id: LEGACY.review, trigger: 'accept', at: 9_001, closed: 9_001 },
        { id: LEGACY.backlog, trigger: 'cancel', at: 9_002, closed: 9_002 },
        { id: LEGACY.running, trigger: 'fail', at: 9_003, closed: 9_003 },
        { id: LEGACY.askOrch, trigger: 'merged', at: 9_004, closed: 9_004 },
        { id: LEGACY.failed, trigger: 'retry', started: true, at: 9_005, closed: null },
      ];
      for (const step of live) {
        now = step.at;
        const item = rebuilt.backlog.get(step.id);
        expect(item, step.trigger).toBeTruthy();
        const tx = rebuilt.workflow.begin(`item.${step.trigger}`);
        ticketStatus(tx, item as NonNullable<typeof item>, step.trigger, { by: PIPELINE, started: step.started ?? false });
        rebuilt.workflow.commit(tx);
        const after = rebuilt.backlog.get(step.id);
        expect(after?.updatedAt, step.trigger).toBe(step.at);
        expect(after?.closedAt, step.trigger).toBe(step.closed);
        expect(rebuilt.tables.get().tickets[step.id]?.closedAt, step.trigger).toBe(step.closed);
      }
      expect(rebuilt.backlog.get(LEGACY.merged)?.updatedAt).toBe(prior[LEGACY.merged]?.updatedAt);
      expect(rebuilt.tables.get().tickets[LEGACY.merged]?.closedAt).toBe(prior[LEGACY.merged]?.closedAt ?? null);
    } finally {
      rebuilt.journal.close();
    }
  });
});

describe('closedAt is when the ticket last entered done', () => {
  function status(stack: Stack, id: string, trigger: TicketTrigger, started = false): void {
    const item = stack.backlog.get(id);
    expect(item, trigger).toBeTruthy();
    const tx = stack.workflow.begin(`item.${trigger}`);
    ticketStatus(tx, item as NonNullable<typeof item>, trigger, { by: PIPELINE, started });
    stack.workflow.commit(tx);
  }

  it('keeps the close time when a later merge only changes the outcome, stamps it on entry, and clears it on retry', async () => {
    const d = path.join(dir, 'closed-at');
    let now = 1_000;
    const stack = deliveryStack(d, { now: () => now });
    const accepted = seedTicket(stack, { title: 'Ship' }, 'running');
    const failed = seedTicket(stack, { title: 'Retry me' }, 'running');
    expect(stack.backlog.get(accepted.id)?.closedAt).toBeNull();

    now = 2_000;
    status(stack, accepted.id, 'accept');
    expect(stack.backlog.get(accepted.id)).toMatchObject({ status: 'done', outcome: 'accepted', closedAt: 2_000, updatedAt: 2_000 });
    expect(stack.tables.get().tickets[accepted.id]?.closedAt).toBe(2_000);

    now = 3_000;
    status(stack, accepted.id, 'merged');
    expect(stack.backlog.get(accepted.id)).toMatchObject({ status: 'done', outcome: 'merged', closedAt: 2_000, updatedAt: 3_000 });
    expect(stack.tables.get().tickets[accepted.id]?.closedAt).toBe(2_000);

    now = 4_000;
    status(stack, failed.id, 'fail');
    expect(stack.backlog.get(failed.id)).toMatchObject({ status: 'done', outcome: 'failed', closedAt: 4_000, updatedAt: 4_000 });
    expect(stack.tables.get().tickets[failed.id]?.closedAt).toBe(4_000);

    now = 5_000;
    status(stack, failed.id, 'retry', true);
    expect(stack.backlog.get(failed.id)).toMatchObject({ status: 'in-progress', outcome: null, closedAt: null, updatedAt: 5_000 });
    expect(stack.tables.get().tickets[failed.id]?.closedAt).toBeNull();
    await stack.tables.flush();
    stack.journal.close();

    fs.rmSync(path.join(d, 'items.json'));
    fs.rmSync(path.join(d, 'delivery', 'tables.json'));
    const rebuilt = deliveryStack(d, { now: () => 9_999 });
    try {
      expect(rebuilt.backlog.get(accepted.id)).toMatchObject({ status: 'done', outcome: 'merged', closedAt: 2_000, updatedAt: 3_000 });
      expect(rebuilt.tables.get().tickets[accepted.id]?.closedAt).toBe(2_000);
      expect(rebuilt.backlog.get(failed.id)).toMatchObject({ status: 'in-progress', outcome: null, closedAt: null, updatedAt: 5_000 });
      expect(rebuilt.tables.get().tickets[failed.id]?.closedAt).toBeNull();
    } finally {
      rebuilt.journal.close();
    }
  });
});

describe('a checkpoint ahead of the journal', () => {
  const warns: Array<[string, unknown]> = [];
  const log: Logger = { ...nullLogger, warn: (message: string, fields?: unknown) => void warns.push([message, fields]) };
  const file = (d: string) => path.join(d, 'delivery', 'journal.ndjson');

  function create(stack: Stack, title: string): void {
    const tx = stack.workflow.begin('item.create');
    stack.backlog.create(tx, { title, body: '', agent: null, repo: null, createdBy: 'user' });
    stack.workflow.commit(tx);
  }

  beforeEach(() => warns.splice(0));

  it('rebuilds both checkpoints from a journal restored from a backup, and later transactions apply', () => {
    const d = path.join(dir, 's');
    writeLegacyState(d);
    migrateState(d, { daemonVersion: 'new', now: 5, eventHead: 7 });
    const first = deliveryStack(d, { now: () => 5 });
    bootstrapLegacy(first.workflow, first.backlog.list(), first.items.get().nextNumber);
    create(first, 'Before the backup');
    first.journal.close();
    const backup = fs.readFileSync(file(d));
    const atBackup = deliveryStack(d, { now: () => 5 });
    const expected = { titles: atBackup.backlog.list().map((i) => i.title), nextNumber: atBackup.items.get().nextNumber, tables: JSON.stringify({ ...atBackup.tables.get(), journalSeq: 0 }) };
    create(atBackup, 'After the backup 1');
    create(atBackup, 'After the backup 2');
    // tables.json is saved asynchronously; commit it so both checkpoints are on disk past the backup.
    atBackup.tables.commit();
    atBackup.journal.close();
    // The journal comes back from the backup; both checkpoints still hold the two later transactions.
    fs.writeFileSync(file(d), backup);
    const restored = deliveryStack(d, { now: () => 5, log });
    const head = restored.journal.head();
    expect(restored.items.get().journalSeq).toBe(head);
    expect(restored.tables.get().journalSeq).toBe(head);
    expect(restored.backlog.list().map((i) => i.title)).toEqual(expected.titles);
    expect(restored.items.get().nextNumber).toBe(expected.nextNumber);
    expect(JSON.stringify({ ...restored.tables.get(), journalSeq: 0 })).toBe(expected.tables);
    expect(warns).toEqual([
      ['journal.checkpoint-ahead', { file: 'delivery/tables.json', journalSeq: head + 2, head, rebuilt: true }],
      ['journal.checkpoint-ahead', { file: 'items.json', journalSeq: head + 2, head, rebuilt: true }],
    ]);
    // The next transaction takes j = head + 1 and lands in both checkpoints.
    create(restored, 'After the restore');
    expect(restored.backlog.list().map((i) => i.title)).toEqual([...expected.titles, 'After the restore']);
    restored.journal.close();
    const again = deliveryStack(d, { now: () => 5 });
    expect(again.backlog.list().map((i) => i.title)).toEqual([...expected.titles, 'After the restore']);
    expect(again.items.get().journalSeq).toBe(head + 1);
    again.journal.close();
  });

  it('fails the boot, naming both sequences, when the journal cannot rebuild items.json', () => {
    const d = path.join(dir, 's');
    const s = deliveryStack(d, { now: () => 5 });
    create(s, 'A');
    create(s, 'B');
    s.tables.commit();
    s.journal.close();
    // The journal is gone: no bootstrap marker, so not every ticket has its ticket.created.
    fs.rmSync(file(d));
    expect(() => deliveryStack(d, { now: () => 5, log })).toThrow(new CheckpointAheadError(2, 0));
    expect(new CheckpointAheadError(2, 0).message).toBe(
      'items.json holds journal records up to 2 but the delivery journal ends at 0, and the journal cannot rebuild it; restore items.json and delivery/journal.ndjson from the same backup.',
    );
    expect(warns).toEqual([
      ['journal.checkpoint-ahead', { file: 'delivery/tables.json', journalSeq: 2, head: 0, rebuilt: true }],
      ['journal.checkpoint-ahead', { file: 'items.json', journalSeq: 2, head: 0, rebuilt: false }],
    ]);
  });
});

describe('the numbering through the bootstrap', () => {
  it('keeps an empty legacy backlog’s next number through the bootstrap and a rebuild from the journal', () => {
    const d = path.join(dir, 'empty');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ formatVersion: 1, daemonVersion: 'old', createdAt: 1 }));
    fs.writeFileSync(path.join(d, 'items.json'), JSON.stringify({ nextNumber: 42, order: [], items: {} }));
    expect(migrateState(d, { daemonVersion: 'new', now: 5, eventHead: 0 })).toMatchObject({ ok: true, to: 2 });
    const s = deliveryStack(d, { now: () => 5 });
    expect(bootstrapLegacy(s.workflow, s.backlog.list(), s.items.get().nextNumber)).toBe(0);
    s.journal.close();
    // Both checkpoints gone: everything comes back from the journal, the numbering included.
    fs.rmSync(path.join(d, 'items.json'));
    fs.rmSync(path.join(d, 'delivery', 'tables.json'), { force: true });
    const rebuilt = deliveryStack(d, { now: () => 5 });
    expect(rebuilt.items.get().nextNumber).toBe(42);
    const tx = rebuilt.workflow.begin('item.create');
    expect(rebuilt.backlog.create(tx, { title: 'Next', body: '', agent: null, repo: null, createdBy: 'user' }).number).toBe(42);
    rebuilt.workflow.commit(tx);
    rebuilt.journal.close();
  });
});
