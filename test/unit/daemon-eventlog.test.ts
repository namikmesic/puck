import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '../../src/harness/daemon-protocol';
import { EventLog } from '../../src/daemon/eventlog';
import { defined } from './daemon-fakes';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-events-'));
});
afterEach(() => {
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
