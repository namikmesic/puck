import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  encodeTransaction,
  JOURNAL_LIMITS,
  JournalDamagedError,
  JournalError,
  nodeJournalIO,
  openJournal,
  type JournalEvent,
  type JournalIO,
} from '../../src/daemon/delivery/journal';
import type { Logger } from '../../src/daemon/log';

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
