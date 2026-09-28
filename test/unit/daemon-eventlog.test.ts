import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '../../src/harness/daemon-protocol';
import { EventLog } from '../../src/daemon/eventlog';
import { nullLogger } from '../../src/daemon/log';
import { defined } from './daemon-fakes';

const fsGate = vi.hoisted(() => ({ short: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    appendFileSync(
      file: Parameters<typeof actual.appendFileSync>[0],
      data: Parameters<typeof actual.appendFileSync>[1],
      options?: Parameters<typeof actual.appendFileSync>[2],
    ): void {
      if (fsGate.short) {
        actual.appendFileSync(file, String(data).slice(0, 12), options);
        throw new Error('ENOSPC');
      }
      actual.appendFileSync(file, data, options);
    },
  };
});

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-events-'));
});
afterEach(() => {
  fsGate.short = false;
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const status = (n: number): DaemonEvent => ({ kind: 'instance.status', status: 'provisioning', detail: `step ${n}` });
const delta = (text: string, parentId?: string, sessionId = 'ses_A'): DaemonEvent => ({
  kind: 'turn.event',
  sessionId,
  turnId: 'trn_1',
  event: { kind: 'text-delta', text, ...(parentId ? { parentId } : {}) },
});

describe('event log', () => {
  it('appends with seq from 1 and fans out to subscribers', () => {
    const log = new EventLog(dir);
    const seen: number[] = [];
    log.subscribe((e) => seen.push(e.seq));
    log.append(status(1));
    log.append(status(2));
    expect(log.head()).toBe(2);
    expect(seen).toEqual([1, 2]);
    expect(log.since(0)?.map((e) => e.seq)).toEqual([1, 2]);
    expect(log.since(1)?.map((e) => e.seq)).toEqual([2]);
    expect(log.since(2)).toEqual([]);
  });

  it('keeps seq across restarts and drops a torn final line', () => {
    const first = new EventLog(dir);
    for (let i = 1; i <= 5; i++) first.append(status(i));
    fs.appendFileSync(path.join(dir, '1.ndjson'), '{"seq":6,"at":1,"ev":{"kind"');
    const second = new EventLog(dir);
    expect(second.head()).toBe(5);
    second.append(status(6));
    expect(second.since(4)?.map((e) => e.seq)).toEqual([5, 6]);
  });

  it('rolls segments over at the segment size and retains the newest events', () => {
    const log = new EventLog(dir, { segmentSize: 10, retention: 30 });
    for (let i = 1; i <= 45; i++) log.append(status(i));
    const files = fs.readdirSync(dir).sort((a, b) => parseInt(a) - parseInt(b));
    expect(files).toEqual(['11.ndjson', '21.ndjson', '31.ndjson', '41.ndjson']);
    expect(log.oldest()).toBe(11);
    // Inside retention: replay; older than retention, first attach, or ahead: resync.
    expect(log.since(10)?.length).toBe(35);
    expect(log.since(9)).toBeNull();
    expect(log.since(null)).toBeNull();
    expect(log.since(46)).toBeNull();
  });

  it('keeps at least the retention window with the real sizes', () => {
    const log = new EventLog(dir, { segmentSize: 10_000, retention: 50_000 });
    // Fast path: write segment files directly would be brittle; append 60,001 events.
    for (let i = 1; i <= 60_001; i++) log.append(status(i));
    expect(log.head()).toBe(60_001);
    expect(log.oldest()).toBe(10_001);
    expect(log.since(60_001 - 50_000)?.length).toBe(50_000);
  }, 60_000);

  it('coalesces text-deltas per session and parent, flushing before any other event of the session', () => {
    vi.useFakeTimers();
    const log = new EventLog(dir, { coalesceMs: 50 });
    log.append(delta('a'));
    log.append(delta('b'));
    log.append(delta('x', 'tool1')); // other parent: flushes 'ab'
    log.append(delta('y', 'tool1'));
    log.append(delta('other', undefined, 'ses_B')); // another session: held separately
    expect(log.head()).toBe(1);
    log.append({ kind: 'turn.end', sessionId: 'ses_A', turnId: 'trn_1', stats: { inputTokens: 0, outputTokens: 0, durationMs: 0 } });
    expect(log.head()).toBe(3);
    vi.advanceTimersByTime(60);
    const all = defined(log.since(0)).map((e) => e.ev);
    expect(all).toEqual([
      delta('ab'),
      delta('xy', 'tool1'),
      { kind: 'turn.end', sessionId: 'ses_A', turnId: 'trn_1', stats: { inputTokens: 0, outputTokens: 0, durationMs: 0 } },
      delta('other', undefined, 'ses_B'),
    ]);
  });

  it('a throwing listener does not escape, and the other listeners still see the event', () => {
    const logged: string[] = [];
    const log = new EventLog(dir, { log: { ...nullLogger, error: (message) => logged.push(message) } });
    const seen: number[] = [];
    log.subscribe(() => {
      throw new Error('bad client');
    });
    log.subscribe((e) => seen.push(e.seq));
    expect(log.append(status(1))).toBe(true);
    expect(log.append(status(2))).toBe(true);
    expect(log.head()).toBe(2);
    expect(seen).toEqual([1, 2]);
    expect(defined(log.since(0)).map((e) => e.seq)).toEqual([1, 2]);
    expect(logged).toEqual(['eventlog.write', 'eventlog.write']);
  });

  it('a short write is rolled back so later events stay readable after reopen', () => {
    const log = new EventLog(dir, { segmentSize: 2 });
    const appendShort = (ev: DaemonEvent): boolean => {
      fsGate.short = true;
      try {
        return log.append(ev);
      } finally {
        fsGate.short = false;
      }
    };
    expect(log.append(status(1))).toBe(true);
    const before = fs.readFileSync(path.join(dir, '1.ndjson'), 'utf8');
    expect(appendShort(status(2))).toBe(false);
    expect(log.head()).toBe(1);
    expect(fs.readFileSync(path.join(dir, '1.ndjson'), 'utf8')).toBe(before);
    expect(log.append(status(2))).toBe(true);
    expect(appendShort(status(3))).toBe(false);
    expect(fs.existsSync(path.join(dir, '3.ndjson'))).toBe(false);
    expect(log.head()).toBe(2);
    expect(log.append(status(3))).toBe(true);
    expect(log.append(status(4))).toBe(true);
    const details = (events: { ev: DaemonEvent }[]): string[] =>
      events.map((e) => (e.ev.kind === 'instance.status' ? e.ev.detail ?? '' : e.ev.kind));
    expect(details(defined(log.since(0)))).toEqual(['step 1', 'step 2', 'step 3', 'step 4']);
    const reopened = new EventLog(dir, { segmentSize: 2 });
    expect(reopened.head()).toBe(4);
    expect(details(defined(reopened.since(0)))).toEqual(['step 1', 'step 2', 'step 3', 'step 4']);
  });

  it('a failed write drops that event and the next append still lands', () => {
    const log = new EventLog(dir);
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => log.append(status(1))).not.toThrow();
      expect(log.head()).toBe(0);
      expect(log.since(0)).toEqual([]);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(log.append(status(2))).toBe(true);
    expect(log.head()).toBe(1);
    expect(defined(log.since(0)).map((e) => e.ev)).toEqual([status(2)]);
  });

  it('a failed segment prune does not drop the new event', () => {
    const log = new EventLog(dir, { segmentSize: 1, retention: 1 });
    expect(log.append(status(1))).toBe(true);
    expect(log.append(status(2))).toBe(true);
    const stale = path.join(dir, '1.ndjson');
    fs.rmSync(stale);
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'blocked'), 'x');
    expect(() => log.append(status(3))).not.toThrow();
    expect(log.head()).toBe(3);
    expect(defined(log.since(2)).map((e) => e.seq)).toEqual([3]);
  });

  it('a window closes after the coalescing interval', () => {
    vi.useFakeTimers();
    const log = new EventLog(dir, { coalesceMs: 50 });
    log.append(delta('a'));
    vi.advanceTimersByTime(49);
    expect(log.head()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(log.head()).toBe(1);
    log.append(delta('b'));
    log.flush();
    expect(defined(log.since(0)).map((e) => e.ev)).toEqual([delta('a'), delta('b')]);
  });
});
