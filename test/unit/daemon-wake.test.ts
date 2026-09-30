import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '../../src/harness/daemon-protocol';
import type { HarnessEvent } from '../../src/harness/types';
import type { AdapterContext, AdapterRequest } from '../../src/daemon/harness/types';
import { nullLogger } from '../../src/daemon/log';
import { Orchestrator, RUNAWAY_WINDOW_MS, WAKE_BATCH_MS, type WakeTurns } from '../../src/daemon/orchestrator';
import { noticesStore } from '../../src/daemon/store/notices';
import { sessionsStore, type SessionRecord } from '../../src/daemon/store/sessions';
import { TranscriptBook } from '../../src/daemon/transcripts';
import { noticePrompt, Turns } from '../../src/daemon/turns';
import { defined } from './daemon-fakes';

// The orchestrator's wake loop: notices batch for 3 s, then start a turn
// only when the orchestrator is idle; a runaway guard stops automatic
// turns after maxAutoTurnsPerHour and a user message resumes them.

const END: HarnessEvent = { kind: 'turn-end', stats: { inputTokens: 1, outputTokens: 1, durationMs: 0 } };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-wake-'));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeTurns() {
  const session = { id: 'ses_01J0000000000000000000000A', kind: 'orchestrator' } as SessionRecord;
  const state = { running: false, kicks: 0, upserts: 0 };
  const turns: WakeTurns = {
    orchestrator: () => session,
    isRunning: () => state.running,
    kick: () => {
      state.kicks += 1;
      return `trn_${state.kicks}`;
    },
    upsert: () => {
      state.upserts += 1;
    },
  };
  return { turns, state };
}

function orchestrator(turns: WakeTurns, settings = { autoWake: true, maxAutoTurnsPerHour: 3 }) {
  let now = 1_000_000;
  const o = new Orchestrator({
    notices: noticesStore(dir),
    turns,
    settings: () => settings,
    canWake: () => true,
    log: nullLogger,
    now: () => now,
  });
  return { o, advance: (ms: number) => (now += ms) };
}

describe('wake batching', () => {
  it('waits 3 s after the first notice and starts one turn for the whole batch', () => {
    const { turns, state } = fakeTurns();
    const { o } = orchestrator(turns);
    o.push('item.review', 'W-1 is ready for review.');
    vi.advanceTimersByTime(1_000);
    o.push('item.failed', 'W-2 failed.');
    vi.advanceTimersByTime(WAKE_BATCH_MS - 1_001);
    expect(state.kicks).toBe(0);
    vi.advanceTimersByTime(1);
    expect(state.kicks).toBe(1);
    expect(o.pending().map((n) => n.text)).toEqual(['W-1 is ready for review.', 'W-2 failed.']);
  });

  it('opens no wake window for a notice with wake: false; it rides along with the next turn', () => {
    const { turns, state } = fakeTurns();
    const { o } = orchestrator(turns);
    const quiet = o.push('item.updated', 'W-1 round 2 is verifying.', 'itm_1', { wake: false });
    expect(quiet.wake).toBe(false);
    vi.advanceTimersByTime(WAKE_BATCH_MS * 10);
    expect(state.kicks).toBe(0);
    o.fire();
    expect(state.kicks).toBe(0);
    expect(o.pending().map((n) => n.text)).toEqual(['W-1 round 2 is verifying.']);
    // A notice that wakes opens the window, and the quiet one rides along with its turn.
    o.push('item.failed', 'W-2 failed.');
    vi.advanceTimersByTime(WAKE_BATCH_MS);
    expect(state.kicks).toBe(1);
    expect(o.pending().map((n) => n.text)).toEqual(['W-1 round 2 is verifying.', 'W-2 failed.']);
  });

  it('treats a stored notice without wake as one that wakes', () => {
    fs.writeFileSync(path.join(dir, 'notices.json'), JSON.stringify({ pending: [{ id: 'ntc_1', kind: 'item.review', at: 1, text: 'Stored before wake existed.' }] }));
    const { turns, state } = fakeTurns();
    const { o } = orchestrator(turns);
    o.schedule();
    vi.advanceTimersByTime(WAKE_BATCH_MS);
    expect(state.kicks).toBe(1);
  });

  it('holds notices while a turn runs, and opens a new window when it ends', () => {
    const { turns, state } = fakeTurns();
    const { o } = orchestrator(turns);
    state.running = true;
    o.push('item.review', 'W-1 is ready.');
    vi.advanceTimersByTime(WAKE_BATCH_MS);
    expect(state.kicks).toBe(0);
    state.running = false;
    o.turnEnded();
    vi.advanceTimersByTime(WAKE_BATCH_MS);
    expect(state.kicks).toBe(1);
  });

  it('with autoWake off, notices only ride along with user messages', () => {
    const { turns, state } = fakeTurns();
    const { o } = orchestrator(turns, { autoWake: false, maxAutoTurnsPerHour: 3 });
    o.push('item.review', 'W-1 is ready.');
    vi.advanceTimersByTime(10 * WAKE_BATCH_MS);
    expect(state.kicks).toBe(0);
    expect(o.pending()).toHaveLength(1);
  });

  it('persists pending notices and drops them only once a turn has recorded them', () => {
    const { turns } = fakeTurns();
    const { o } = orchestrator(turns);
    o.push('item.review', 'one');
    o.push('item.review', 'two');
    o.commit(1);
    expect(noticesStore(dir).get().pending.map((n) => n.text)).toEqual(['two']);
  });
});

describe('runaway guard', () => {
  it('pauses auto-wake at maxAutoTurnsPerHour; notices accumulate; a user message resumes with a fresh count', () => {
    const { turns, state } = fakeTurns();
    const { o, advance } = orchestrator(turns, { autoWake: true, maxAutoTurnsPerHour: 2 });
    for (let i = 0; i < 2; i++) {
      o.push('item.review', `n${i}`);
      vi.advanceTimersByTime(WAKE_BATCH_MS);
      o.commit(1);
      advance(60_000);
    }
    expect(state.kicks).toBe(2);
    o.push('item.review', 'third');
    vi.advanceTimersByTime(WAKE_BATCH_MS);
    expect(state.kicks).toBe(2);
    expect(o.autoWakePaused()).toBe(true);
    expect(state.upserts).toBe(1); // the session reports autoWakePaused
    o.push('item.review', 'fourth');
    vi.advanceTimersByTime(WAKE_BATCH_MS);
    expect(state.kicks).toBe(2);
    expect(o.pending().map((n) => n.text)).toEqual(['third', 'fourth']);

    o.userMessage();
    expect(o.autoWakePaused()).toBe(false);
    expect(state.upserts).toBe(2);
    o.turnEnded();
    vi.advanceTimersByTime(WAKE_BATCH_MS);
    expect(state.kicks).toBe(3);
  });

  it('counts over a sliding hour', () => {
    const { turns, state } = fakeTurns();
    const { o, advance } = orchestrator(turns, { autoWake: true, maxAutoTurnsPerHour: 1 });
    o.push('item.review', 'a');
    vi.advanceTimersByTime(WAKE_BATCH_MS);
    o.commit(1);
    advance(RUNAWAY_WINDOW_MS + 1);
    o.push('item.review', 'b');
    vi.advanceTimersByTime(WAKE_BATCH_MS);
    expect(state.kicks).toBe(2);
    expect(o.autoWakePaused()).toBe(false);
  });
});

describe('wake through the turn loop', () => {
  it('starts a notice-only turn, and queued user messages follow the notice block in order', async () => {
    vi.useRealTimers();
    const calls: AdapterRequest[] = [];
    const gates: Array<() => void> = [];
    const events: DaemonEvent[] = [];
    // The turn loop and the wake loop refer to each other.
    const box = {} as { o: Orchestrator };
    const turns: Turns = new Turns({
      adapters: {
        'claude-code': {
          id: 'claude-code',
          run: async (req: AdapterRequest, ctx: AdapterContext) => {
            calls.push(req);
            await new Promise<void>((r) => gates.push(r));
            ctx.emit(END);
          },
        },
      },
      sessions: sessionsStore(dir),
      transcripts: new TranscriptBook(path.join(dir, 'transcripts')),
      emit: (ev) => events.push(ev),
      log: nullLogger,
      agentFor: () => ({ name: 'lead', description: '', harness: 'claude-code', model: 'auto', effort: 'auto', instructions: '', options: {}, advanced: {} }),
      envFor: () => ({}),
      peekNotices: () => box.o.pending(),
      commitNotices: (n) => box.o.commit(n),
      onTurnEnd: () => box.o.turnEnded(),
      summaryExtra: () => ({ autoWakePaused: box.o.autoWakePaused() }),
    });
    const o = (box.o = new Orchestrator({
      notices: noticesStore(dir),
      turns,
      settings: () => ({ autoWake: true, maxAutoTurnsPerHour: 5 }),
      canWake: () => true,
      log: nullLogger,
    }));
    const session = turns.create({ kind: 'orchestrator', agent: 'lead', harness: 'claude-code', cwd: '/workspace' });
    const first = o.push('item.review', 'W-1 is ready.');
    o.fire(); // the window closing
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].prompt).toBe(noticePrompt([first]));
    expect(o.pending()).toEqual([]);

    // While it runs: two user messages and another notice.
    turns.send(session.id, 'first', 'user');
    turns.send(session.id, 'second', 'user');
    const late = o.push('item.failed', 'W-2 failed.');
    defined(gates.shift())();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].prompt).toBe(`${noticePrompt([late])}\n\nfirst\n\nsecond`);
    defined(gates.shift())();
    await turns.idle();
    o.stop();
    const summary = events.filter((e) => e.kind === 'session.upsert').at(-1);
    expect(summary).toMatchObject({ session: { autoWakePaused: false } });
  });
});
