import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonEvent } from '../../src/harness/daemon-protocol';
import type { HarnessEvent } from '../../src/harness/types';
import type { TurnEntry } from '../../src/harness/transcript';
import type { DaemonAgent } from '../../src/harness/env-definition';
import type { AdapterContext, AdapterRequest, HarnessAdapter } from '../../src/daemon/harness/types';
import { EventLog } from '../../src/daemon/eventlog';
import { nullLogger } from '../../src/daemon/log';
import { flushJsonWrites } from '../../src/daemon/store/jsonfile';
import { sessionsStore } from '../../src/daemon/store/sessions';
import { TranscriptBook } from '../../src/daemon/transcripts';
import { noticesStore } from '../../src/daemon/store/notices';
import { noticePrompt, Turns, type TurnsDeps } from '../../src/daemon/turns';
import { defined } from './daemon-fakes';

// The daemon's turn loop inherits the app's stale-resume retry, whose
// failure mode (a resume silently becoming a fresh conversation, or the
// reverse) looks like success. Script the adapter and pin it down.

const END: HarnessEvent = { kind: 'turn-end', stats: { inputTokens: 1, outputTokens: 2, durationMs: 0 } };

type Attempt = (req: AdapterRequest, ctx: AdapterContext) => Promise<void> | void;

let dir: string;
let attempts: Attempt[];
let calls: AdapterRequest[];
let events: DaemonEvent[];
let turns: Turns;
let transcripts: TranscriptBook;
let pendingNotices: Array<{ id: string; kind: 'environment.restarted'; at: number; text: string }>;

const agent: DaemonAgent = {
  name: 'lead',
  description: '',
  harness: 'claude-code',
  model: 'auto',
  effort: 'auto',
  instructions: '',
  options: { maxTurns: 9 },
  advanced: {},
};

function build(over: Partial<TurnsDeps> = {}): Turns {
  const adapter: HarnessAdapter = {
    id: 'claude-code',
    run: async (req, ctx) => {
      calls.push(req);
      const next = attempts.shift();
      if (!next) throw new Error('no scripted attempt');
      await next(req, ctx);
    },
  };
  transcripts = new TranscriptBook(path.join(dir, 'transcripts'));
  return new Turns({
    adapters: { 'claude-code': adapter },
    sessions: sessionsStore(dir),
    transcripts,
    emit: (ev) => events.push(ev),
    retained: () => events.slice(),
    log: nullLogger,
    agentFor: () => agent,
    envFor: () => ({ HOME: '/puck/home' }),
    peekNotices: () => pendingNotices.slice(),
    commitNotices: (count) => {
      pendingNotices.splice(0, count);
    },
    ...over,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-turns-'));
  attempts = [];
  calls = [];
  events = [];
  pendingNotices = [];
  turns = build();
});

afterEach(async () => {
  await flushJsonWrites();
  fs.rmSync(dir, { recursive: true, force: true });
});

function orchestrator() {
  return turns.create({ kind: 'orchestrator', agent: 'lead', harness: 'claude-code', cwd: '/workspace' });
}

async function send(sessionId: string, text = 'hello'): Promise<HarnessEvent[]> {
  const start = events.length;
  turns.send(sessionId, text);
  await turns.idle();
  return events
    .slice(start)
    .filter((e): e is Extract<DaemonEvent, { kind: 'turn.event' }> => e.kind === 'turn.event')
    .map((e) => e.event);
}

const kinds = (list: HarnessEvent[]) => list.filter((e) => e.kind !== 'thinking').map((e) => e.kind);

describe('daemon turns: stale-resume retry', () => {
  it('fresh conversation: one attempt without a resume id; the reported id is persisted', async () => {
    const s = orchestrator();
    attempts = [
      (_req, ctx) => {
        ctx.reportSession('sess-new');
        ctx.emit({ kind: 'text-delta', text: 'hi' });
        ctx.emit(END);
      },
    ];
    expect(kinds(await send(s.id))).toEqual(['text-delta', 'turn-end']);
    expect(calls.map((c) => c.resumeId)).toEqual([null]);
    expect(turns.get(s.id)?.resumeId).toBe('sess-new');
    expect(calls[0]).toMatchObject({ cwd: '/workspace', tools: 'orchestrator', env: { HOME: '/puck/home' }, settings: { maxTurns: 9 } });
  });

  it('stale resume before content: silent fresh retry, old id dropped', async () => {
    const s = orchestrator();
    defined(turns.get(s.id)).resumeId = 'dead-id';
    attempts = [
      (_req, ctx) => {
        ctx.emit({ kind: 'error', message: 'No conversation found with session ID dead-id' });
        ctx.emit(END);
      },
      (_req, ctx) => {
        ctx.reportSession('replacement');
        ctx.emit({ kind: 'text-delta', text: 'recovered' });
        ctx.emit(END);
      },
    ];
    expect(kinds(await send(s.id))).toEqual(['text-delta', 'turn-end']);
    expect(calls.map((c) => c.resumeId)).toEqual(['dead-id', null]);
    expect(calls[0].turnId).toBe(calls[1].turnId); // one turn, two attempts
    expect(turns.get(s.id)?.resumeId).toBe('replacement');
  });

  it('a stale-looking error after content surfaces instead of retrying', async () => {
    const s = orchestrator();
    defined(turns.get(s.id)).resumeId = 'live-id';
    attempts = [
      (_req, ctx) => {
        ctx.emit({ kind: 'text-delta', text: 'partial work' });
        ctx.emit({ kind: 'error', message: 'thread live-id not found' });
        ctx.emit(END);
      },
    ];
    expect(kinds(await send(s.id))).toEqual(['text-delta', 'error', 'turn-end']);
    expect(calls).toHaveLength(1);
    expect(turns.get(s.id)?.resumeId).toBe('live-id');
  });

  it('an echoed attempted id is never re-persisted after being dropped', async () => {
    const s = orchestrator();
    defined(turns.get(s.id)).resumeId = 'dead-id';
    attempts = [
      (_req, ctx) => {
        ctx.reportSession('dead-id');
        ctx.emit({ kind: 'error', message: 'no rollout found' });
        ctx.reportSession('dead-id');
      },
      (_req, ctx) => {
        ctx.reportSession('fresh-id');
        ctx.emit(END);
      },
    ];
    await send(s.id);
    expect(turns.get(s.id)?.resumeId).toBe('fresh-id');
  });

  it('an adapter that throws still ends the turn with an error and a turn-end', async () => {
    const s = orchestrator();
    attempts = [
      (_req, ctx) => {
        ctx.emit({ kind: 'thinking', active: true });
        throw new Error('SDK import failed');
      },
    ];
    const out = await send(s.id);
    expect(out.map((e) => e.kind)).toEqual(['thinking', 'error', 'thinking', 'turn-end']);
    expect(out[1]).toMatchObject({ message: 'SDK import failed' });
    expect(turns.get(s.id)?.status).toBe('idle');
  });
});

describe('daemon turns: queueing, recording, interrupts and asks', () => {
  it('queues input behind a running turn and runs it next as one prompt', async () => {
    const s = orchestrator();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    attempts = [
      async (_req, ctx) => {
        await gate;
        ctx.emit(END);
      },
      (_req, ctx) => ctx.emit(END),
    ];
    expect(turns.send(s.id, 'first').queued).toBe(false);
    expect(turns.send(s.id, 'second')).toEqual({ queued: true });
    expect(turns.send(s.id, 'third')).toEqual({ queued: true });
    release();
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual(['first', 'second\n\nthird']);
  });

  it('delivers pending notices ahead of the user text and records both', async () => {
    const s = orchestrator();
    const notice = { id: 'ntc_1', kind: 'environment.restarted' as const, at: 1, text: 'The environment restarted.' };
    pendingNotices = [notice];
    attempts = [(_req, ctx) => ctx.emit(END)];
    await send(s.id, 'status?');
    expect(calls[0].prompt).toBe('[Puck] Updates since your last turn:\n- The environment restarted.\nDecide what to do next. If nothing needs doing, reply in one sentence.\n\nstatus?');
    expect(noticePrompt([notice])).toBe(
      '[Puck] Updates since your last turn:\n- The environment restarted.\nDecide what to do next. If nothing needs doing, reply in one sentence.',
    );
    const log = transcripts.get(s.id).log;
    expect(log.map((e) => e.kind)).toEqual(['notice', 'user', 'turn']);
    expect(events.some((e) => e.kind === 'turn.notice')).toBe(true);
  });

  it('records the persisted dialect: merged deltas, no thinking, stamped events', async () => {
    const s = orchestrator();
    attempts = [
      (_req, ctx) => {
        ctx.emit({ kind: 'thinking', active: true });
        ctx.emit({ kind: 'text-delta', text: 'a' });
        ctx.emit({ kind: 'text-delta', text: 'b' });
        ctx.emit({ kind: 'text-delta', text: 'c', parentId: 'tool1' });
        ctx.emit(END);
      },
    ];
    await send(s.id);
    const turn = transcripts.get(s.id).log[1] as TurnEntry;
    expect(turn.events.map((e) => [e.kind, (e as { text?: string }).text])).toEqual([
      ['text-delta', 'ab'],
      ['text-delta', 'c'],
      ['turn-end', undefined],
    ]);
    expect(turn.events.every((e) => typeof e.ts === 'number')).toBe(true);
    expect(turns.get(s.id)).toMatchObject({ turns: 1, lastTurnTokens: 3 });
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'transcripts', `${s.id}.json`), 'utf8'));
    expect(saved).toMatchObject({ v: 2, sessionId: s.id, turns: 1, lastTurnTokens: 3 });
  });

  it('interrupting cancels the open question and aborts the adapter', async () => {
    const s = orchestrator();
    let asked: Promise<Record<string, string> | null> | null = null;
    let interrupted = false;
    attempts = [
      async (_req, ctx) => {
        ctx.onInterrupt(() => (interrupted = true));
        asked = ctx.askUser([{ question: 'Go?', header: 'Q', multiSelect: false, options: [] }]);
        const answer = await asked;
        ctx.emit({ kind: 'text-delta', text: `answer=${String(answer)}` });
      },
    ];
    turns.send(s.id, 'ask me');
    await new Promise((r) => setTimeout(r, 0));
    expect(turns.openAsks()).toHaveLength(1);
    turns.interrupt(s.id);
    await turns.idle();
    expect(interrupted).toBe(true);
    expect(await asked).toBeNull();
    expect(turns.openAsks()).toHaveLength(0);
    const closed = events.find((e) => e.kind === 'ask.closed');
    expect(closed).toMatchObject({ by: 'cancelled', answers: null });
    const turn = transcripts.get(s.id).log[1] as TurnEntry;
    expect(turn.events.find((e) => e.kind === 'ask')).toMatchObject({ answers: null });
  });

  it('an answered question resumes the turn and is recorded on the ask event', async () => {
    const s = orchestrator();
    attempts = [
      async (_req, ctx) => {
        const answer = await ctx.askUser([{ question: 'Go?', header: 'Q', multiSelect: false, options: [] }]);
        ctx.emit({ kind: 'text-delta', text: JSON.stringify(answer) });
        ctx.emit(END);
      },
    ];
    turns.send(s.id, 'ask me');
    await new Promise((r) => setTimeout(r, 0));
    const [open] = turns.openAsks();
    expect(turns.answer(s.id, 'ask_wrong', { 'Go?': 'Yes' })).toBe(false);
    expect(turns.answer(s.id, open.askId, { 'Go?': 'Yes' })).toBe(true);
    await turns.idle();
    const turn = transcripts.get(s.id).log[1] as TurnEntry;
    expect(turn.events.find((e) => e.kind === 'ask')).toMatchObject({ answers: { 'Go?': 'Yes' } });
    expect(turn.events.find((e) => e.kind === 'text-delta')).toMatchObject({ text: '{"Go?":"Yes"}' });
  });

  it('boot reconciliation marks in-flight sessions interrupted and closes their turn', async () => {
    const s = orchestrator();
    attempts = [
      async (_req, ctx) => {
        ctx.emit({ kind: 'ask', askId: 'ask_x', questions: [] });
        await new Promise(() => undefined); // never finishes: the daemon "dies" here
      },
    ];
    turns.send(s.id, 'long job');
    await new Promise((r) => setTimeout(r, 0));
    await transcripts.flush();
    await flushJsonWrites();
    // A new daemon over the same state.
    events = [];
    turns = build();
    const touched = turns.reconcile();
    expect(touched.map((t) => t.id)).toEqual([s.id]);
    expect(turns.get(s.id)?.status).toBe('interrupted');
    const turn = transcripts.get(s.id).log[1] as TurnEntry;
    expect(turn.events.map((e) => e.kind)).toEqual(['ask', 'error', 'turn-end']);
    expect(turn.events[0]).toMatchObject({ answers: null });
    // The next input runs normally.
    attempts = [(_req, ctx) => ctx.emit(END)];
    await send(s.id, 'again');
    expect(turns.get(s.id)?.status).toBe('idle');
  });

  it('delivers a follow-up queued during an in-flight turn after a restart', async () => {
    const s = orchestrator();
    attempts = [
      () => new Promise<void>(() => undefined),
      (_req, ctx) => ctx.emit(END),
    ];
    expect(turns.send(s.id, 'first').queued).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(turns.send(s.id, 'second')).toEqual({ queued: true });
    const readQueue = (): unknown =>
      (JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<string, { queue: unknown }>)[s.id].queue;
    expect(readQueue()).toEqual([{ text: 'second', author: 'user' }]);
    await transcripts.flush();
    await flushJsonWrites();
    expect(readQueue()).toEqual([{ text: 'second', author: 'user' }]);

    calls = [];
    events = [];
    turns = build();
    turns.reconcile();
    expect(calls).toEqual([]);
    expect(turns.resumeInterrupted().map((t) => t.id)).toEqual([s.id]);
    const notice = { id: 'ntc_1', kind: 'environment.restarted' as const, at: 1, text: 'The environment restarted.' };
    pendingNotices.push(notice);
    turns.startRestored();
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual([`${noticePrompt([notice])}\n\nContinue.\n\nsecond`]);
    expect(calls.map((c) => c.resumeId)).toEqual([null]);
    const log = transcripts.get(s.id).log;
    expect(log.filter((e) => e.kind === 'user').map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['first', 'Continue.', 'second']);
    expect(turns.get(s.id)?.queue).toEqual([]);
  });

  it('does not deliver a closed session queue onto the session that replaces it', async () => {
    const s = orchestrator();
    attempts = [() => new Promise<void>(() => undefined), (_req, ctx) => ctx.emit(END)];
    expect(turns.send(s.id, 'first').queued).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(turns.send(s.id, 'second')).toEqual({ queued: true });
    await transcripts.flush();
    await flushJsonWrites();
    calls = [];
    turns = build();
    turns.reconcile();
    turns.close(s.id);
    const replacement = turns.create({ kind: 'orchestrator', agent: 'next', harness: 'claude-code', cwd: '/workspace' });
    turns.startRestored();
    await turns.idle();
    expect(calls).toEqual([]);
    expect(turns.get(s.id)?.status).toBe('closed');
    expect(turns.get(s.id)?.queue).toEqual([{ text: 'second', author: 'user' }]);
    expect(turns.get(replacement.id)?.queue).toEqual([]);
    expect(turns.get(replacement.id)?.status).toBe('idle');
  });

  it('keeps accepted input when the process dies after the transcript is durable and before the queue is cleared', async () => {
    const sessions = sessionsStore(dir);
    let crash = false;
    const commit = sessions.commit.bind(sessions);
    (sessions as { commit(): void }).commit = () => {
      const emptied = Object.values(sessions.get()).every((s) => s.queue.length === 0);
      if (crash && emptied) throw new Error('killed before the empty queue was committed');
      commit();
    };
    const notices = noticesStore(dir);
    notices.get().pending.push({ id: 'ntc_1', kind: 'environment.restarted', at: 1, text: 'The environment restarted.' });
    notices.commit();
    const errors: string[] = [];
    turns = build({
      sessions,
      log: { ...nullLogger, error: (message) => errors.push(message) },
      peekNotices: () => notices.get().pending.slice(),
      commitNotices: (count) => {
        const pending = notices.get().pending;
        const removed = pending.splice(0, count);
        try {
          notices.commit();
        } catch (err) {
          pending.unshift(...removed);
          throw err;
        }
      },
    });
    const s = orchestrator();
    crash = true;
    attempts = [(_req, ctx) => ctx.emit(END)];
    turns.send(s.id, 'keep me');
    await turns.idle();
    expect(errors).toEqual(['turn.crash']);
    expect(calls).toEqual([]);
    expect(turns.isRunning(s.id)).toBe(false);
    expect(turns.get(s.id)?.status).toBe('idle');
    expect(turns.get(s.id)?.queue).toEqual([{ text: 'keep me', author: 'user' }]);
    expect(turns.get(s.id)?.handoff).toBeUndefined();

    const savedSessions = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<string, { queue: unknown; status: string }>;
    expect(savedSessions[s.id].queue).toEqual([{ text: 'keep me', author: 'user' }]);
    expect(savedSessions[s.id].status).toBe('idle');
    const savedNotices = JSON.parse(fs.readFileSync(path.join(dir, 'notices.json'), 'utf8')) as { pending: typeof pendingNotices };
    expect(savedNotices.pending.map((n) => n.id)).toEqual(['ntc_1']);

    pendingNotices = savedNotices.pending;
    calls = [];
    errors.length = 0;
    turns = build();
    turns.reconcile();
    turns.resumeInterrupted();
    turns.startRestored();
    await turns.idle();
    await transcripts.flush();
    const log = transcripts.get(s.id).log;
    expect(log.filter((e) => e.kind === 'user').map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['keep me']);
    expect(log.filter((e) => e.kind === 'notice')).toHaveLength(1);
    expect(calls.map((c) => c.prompt)).toEqual([
      `${noticePrompt([{ id: 'ntc_1', kind: 'environment.restarted', at: 1, text: 'The environment restarted.' }])}\n\nkeep me`,
    ]);
    expect(errors).toEqual([]);
  });

  it('redelivers an unhanded input once and then the queued follow-up', async () => {
    const notice = { id: 'ntc_1', kind: 'environment.restarted' as const, at: 1, text: 'The environment restarted.' };
    let capture = false;
    let snap = '';
    turns = build({
      log: {
        ...nullLogger,
        info: (message) => {
          if (!capture || message !== 'turn.start') return;
          capture = false;
          const session = turns.orchestrator();
          if (!session) return;
          turns.send(session.id, 'next');
          snap = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-crash-'));
          fs.cpSync(dir, snap, { recursive: true });
        },
      },
    });
    const s = orchestrator();
    attempts = [
      () => new Promise<void>(() => undefined),
      (_req, ctx) => ctx.emit(END),
    ];
    capture = true;
    turns.send(s.id, 'keep me');
    await new Promise((r) => setTimeout(r, 0));
    const saved = JSON.parse(fs.readFileSync(path.join(snap, 'sessions.json'), 'utf8')) as Record<
      string,
      { handoff?: { handedOff: boolean; inputs: Array<{ text: string; author: string }> }; queue: unknown }
    >;
    expect(saved[s.id].handoff).toMatchObject({ handedOff: false, inputs: [{ text: 'keep me', author: 'user' }] });
    expect(saved[s.id].queue).toEqual([{ text: 'next', author: 'user' }]);

    const live = dir;
    dir = snap;
    calls = [];
    try {
      turns = build();
      expect(turns.reconcile().map((t) => t.id)).toEqual([s.id]);
      expect(turns.resumeInterrupted().map((t) => t.id)).toEqual([s.id]);
      pendingNotices.push(notice);
      turns.startRestored();
      await turns.idle();
      expect(calls.map((c) => c.resumeId)).toEqual([null]);
      expect(calls.map((c) => c.prompt)).toEqual([`${noticePrompt([notice])}\n\nkeep me\n\nnext`]);
      const log = transcripts.get(s.id).log;
      expect(log.filter((e) => e.kind === 'user').map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['keep me', 'next']);
      expect(log.filter((e) => e.kind === 'notice')).toHaveLength(1);
    } finally {
      await transcripts.flush();
      await flushJsonWrites();
      dir = live;
      fs.rmSync(snap, { recursive: true, force: true });
    }
  });

  it('redelivers an unhanded input on the saved resume id', async () => {
    const notice = { id: 'ntc_1', kind: 'environment.restarted' as const, at: 1, text: 'The environment restarted.' };
    let capture = false;
    let snap = '';
    turns = build({
      log: {
        ...nullLogger,
        info: (message) => {
          if (!capture || message !== 'turn.start') return;
          capture = false;
          const session = turns.orchestrator();
          if (!session) return;
          turns.send(session.id, 'next');
          snap = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-crash-'));
          fs.cpSync(dir, snap, { recursive: true });
        },
      },
    });
    const s = orchestrator();
    attempts = [
      (_req, ctx) => {
        ctx.reportSession('sess-live');
        ctx.emit(END);
      },
      () => new Promise<void>(() => undefined),
      (_req, ctx) => ctx.emit(END),
    ];
    await send(s.id, 'hello');
    capture = true;
    turns.send(s.id, 'keep me');
    await new Promise((r) => setTimeout(r, 0));

    const live = dir;
    dir = snap;
    calls = [];
    try {
      turns = build();
      turns.reconcile();
      turns.resumeInterrupted();
      pendingNotices.push(notice);
      turns.startRestored();
      await turns.idle();
      expect(calls.map((c) => c.resumeId)).toEqual(['sess-live']);
      expect(calls.map((c) => c.prompt)).toEqual([`${noticePrompt([notice])}\n\nkeep me\n\nnext`]);
      const log = transcripts.get(s.id).log;
      expect(log.filter((e) => e.kind === 'user').map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['hello', 'keep me', 'next']);
    } finally {
      await transcripts.flush();
      await flushJsonWrites();
      dir = live;
      fs.rmSync(snap, { recursive: true, force: true });
    }
  });

  it('resumes a handed-off turn with continue and keeps the queued follow-up', async () => {
    const s = orchestrator();
    const notice = { id: 'ntc_1', kind: 'environment.restarted' as const, at: 1, text: 'The environment restarted.' };
    attempts = [
      async (_req, ctx) => {
        ctx.reportSession('sess-live');
        await new Promise(() => undefined);
      },
      (_req, ctx) => ctx.emit(END),
    ];
    turns.send(s.id, 'keep me');
    await new Promise((r) => setTimeout(r, 0));
    expect(turns.send(s.id, 'next')).toEqual({ queued: true });
    await transcripts.flush();
    await flushJsonWrites();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<
      string,
      { status: string; queue: unknown; handoff?: { handedOff: boolean } }
    >;
    expect(saved[s.id].status).toBe('running');
    expect(saved[s.id].queue).toEqual([{ text: 'next', author: 'user' }]);
    expect(saved[s.id].handoff?.handedOff).toBe(true);

    const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-crash-'));
    fs.cpSync(dir, snap, { recursive: true });
    const live = dir;
    dir = snap;
    calls = [];
    try {
      turns = build();
      expect(turns.reconcile().map((t) => t.id)).toEqual([s.id]);
      expect(turns.resumeInterrupted().map((t) => t.id)).toEqual([s.id]);
      pendingNotices.push(notice);
      turns.startRestored();
      await turns.idle();
      expect(calls.map((c) => c.resumeId)).toEqual(['sess-live']);
      expect(calls.map((c) => c.prompt)).toEqual([`${noticePrompt([notice])}\n\nContinue.\n\nnext`]);
      const log = transcripts.get(s.id).log;
      expect(log.filter((e) => e.kind === 'user').map((e) => (e.kind === 'user' ? e.text : ''))).toEqual(['keep me', 'Continue.', 'next']);
      expect(turns.get(s.id)?.status).toBe('idle');
    } finally {
      await transcripts.flush();
      await flushJsonWrites();
      dir = live;
      fs.rmSync(snap, { recursive: true, force: true });
    }
  });

  it('resumes an interrupted turn after restart without a new message', async () => {
    const s = orchestrator();
    attempts = [
      async (_req, ctx) => {
        ctx.reportSession('sess-live');
        await new Promise(() => undefined);
      },
      (_req, ctx) => {
        ctx.emit({ kind: 'text-delta', text: 'continued' });
        ctx.emit(END);
      },
    ];
    turns.send(s.id, 'long job');
    await new Promise((r) => setTimeout(r, 0));
    expect(turns.get(s.id)?.resumeId).toBe('sess-live');
    await transcripts.flush();
    await flushJsonWrites();
    calls = [];
    events = [];
    turns = build();
    expect(turns.reconcile().map((t) => t.id)).toEqual([s.id]);
    expect(turns.resumeInterrupted().map((t) => t.id)).toEqual([s.id]);
    turns.startRestored();
    await turns.idle();
    expect(calls.map((c) => c.resumeId)).toEqual(['sess-live']);
    expect(calls.map((c) => c.prompt)).toEqual(['Continue.']);
    expect(turns.get(s.id)?.status).toBe('idle');
  });

  it('retries a resumed turn fresh when the saved id no longer resolves', async () => {
    const s = orchestrator();
    attempts = [
      async (_req, ctx) => {
        ctx.reportSession('sess-live');
        await new Promise(() => undefined);
      },
      (_req, ctx) => {
        ctx.emit({ kind: 'error', message: 'No conversation found with session ID sess-live' });
      },
      (_req, ctx) => {
        ctx.reportSession('sess-new');
        ctx.emit({ kind: 'text-delta', text: 'fresh' });
        ctx.emit(END);
      },
    ];
    turns.send(s.id, 'long job');
    await new Promise((r) => setTimeout(r, 0));
    await transcripts.flush();
    await flushJsonWrites();
    calls = [];
    turns = build();
    turns.reconcile();
    turns.resumeInterrupted();
    turns.startRestored();
    await turns.idle();
    expect(calls.map((c) => c.resumeId)).toEqual(['sess-live', null]);
    expect(calls.map((c) => c.prompt)).toEqual(['Continue.', 'Continue.']);
    expect(turns.get(s.id)?.resumeId).toBe('sess-new');
  });

  it('keeps accepted input when publishing the turn start fails, then a later send delivers it once', async () => {
    const elog = new EventLog(path.join(dir, 'events'));
    const errors: string[] = [];
    turns = build({
      emit: (ev) => {
        if (!elog.append(ev)) throw new Error('The event log could not record an event.');
      },
      retained: () => (elog.since(0) ?? []).map((e) => e.ev),
      log: { ...nullLogger, error: (message) => errors.push(message) },
    });
    const s = orchestrator();
    const eventsDir = path.join(dir, 'events');
    for (const name of fs.readdirSync(eventsDir)) fs.chmodSync(path.join(eventsDir, name), 0o400);
    fs.chmodSync(eventsDir, 0o500);
    const disarm = (): void => {
      fs.chmodSync(eventsDir, 0o700);
      for (const name of fs.readdirSync(eventsDir)) fs.chmodSync(path.join(eventsDir, name), 0o600);
    };
    calls = [];
    attempts = [(_req, ctx) => ctx.emit(END)];
    try {
      turns.send(s.id, 'deploy');
    } finally {
      disarm();
    }
    await turns.idle();
    expect(calls).toEqual([]);
    expect(errors).toContain('turn.start-failed');
    expect(turns.isRunning(s.id)).toBe(false);
    expect(turns.get(s.id)?.status).toBe('idle');
    expect(turns.get(s.id)?.handoff).toBeUndefined();
    expect(turns.get(s.id)?.queue).toEqual([{ text: 'deploy', author: 'user' }]);
    expect(turns.get(s.id)?.turns).toBe(0);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<
      string,
      { status: string; queue: unknown; handoff?: unknown }
    >;
    expect(saved[s.id].status).toBe('idle');
    expect(saved[s.id].queue).toEqual([{ text: 'deploy', author: 'user' }]);
    expect(saved[s.id].handoff).toBeUndefined();

    calls = [];
    errors.length = 0;
    attempts = [
      (_req, ctx) => {
        ctx.emit({ kind: 'text-delta', text: 'ok' });
        ctx.emit(END);
      },
    ];
    turns.send(s.id, 'next');
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual(['deploy\n\nnext']);
    expect(turns.get(s.id)?.turns).toBe(1);
    const users = transcripts.get(s.id).log.filter((e) => e.kind === 'user').map((e) => (e.kind === 'user' ? e.text : ''));
    expect(users).toEqual(['deploy', 'next']);
    const published = defined(elog.since(0)).flatMap((e) => (e.ev.kind === 'turn.user' ? [e.ev.entry.text] : []));
    expect(published).toEqual(['deploy', 'next']);
    expect(errors).not.toContain('turn.start-failed');
  });

  it('a failure after turn.start leaves no unfinished turn and emits turn.end', async () => {
    pendingNotices = [{ id: 'n1', kind: 'environment.restarted', at: 1, text: 'booted' }];
    const errors: string[] = [];
    turns = build({
      commitNotices: () => {
        throw new Error('notice commit failed');
      },
      log: { ...nullLogger, error: (message) => errors.push(message) },
    });
    const s = orchestrator();
    events = [];
    attempts = [() => undefined];
    turns.send(s.id, 'deploy');
    await turns.idle();
    expect(calls).toEqual([]);
    expect(errors).toContain('turn.start-failed');
    await transcripts.flush();
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'transcripts', `${s.id}.json`), 'utf8')) as {
      log: Array<{ kind: string }>;
    };
    expect(disk.log.filter((e) => e.kind === 'turn')).toEqual([]);
    expect(disk.log.some((e) => e.kind === 'user')).toBe(true);
    const start = events.find((e): e is Extract<DaemonEvent, { kind: 'turn.start' }> => e.kind === 'turn.start');
    const end = events.find((e): e is Extract<DaemonEvent, { kind: 'turn.end' }> => e.kind === 'turn.end');
    expect(start).toBeDefined();
    expect(end).toMatchObject({ kind: 'turn.end', turnId: start?.turnId });
    expect(events.filter((e) => e.kind === 'turn.user')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'turn.end')).toHaveLength(1);
    expect(turns.get(s.id)?.status).toBe('idle');
    expect(turns.get(s.id)?.handoff).toBeUndefined();
    expect(turns.get(s.id)?.queue).toEqual([{ text: 'deploy', author: 'user' }]);
  });

  it('a throwing listener mid-turn does not end the turn', async () => {
    const elog = new EventLog(path.join(dir, 'events'));
    elog.subscribe((entry) => {
      if (entry.ev.kind === 'turn.event' && entry.ev.event.kind === 'tool-start') throw new Error('listener');
    });
    const errors: string[] = [];
    turns = build({
      emit: (ev) => {
        if (!elog.append(ev)) throw new Error('The event log could not record an event.');
      },
      retained: () => (elog.since(0) ?? []).map((e) => e.ev),
      log: { ...nullLogger, error: (message) => errors.push(message) },
    });
    const s = orchestrator();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let during = false;
    attempts = [
      async (_req, ctx) => {
        ctx.emit({ kind: 'tool-start', toolId: 't1', tool: 'Bash', summary: 'ls', input: 'ls' });
        during =
          turns.isRunning(s.id) && turns.get(s.id)?.status === 'running' && turns.get(s.id)?.handoff?.handedOff === true;
        await gate;
        ctx.emit(END);
      },
    ];
    turns.send(s.id, 'deploy');
    await new Promise((r) => setTimeout(r, 0));
    expect(during).toBe(true);
    expect(turns.isRunning(s.id)).toBe(true);
    expect(turns.get(s.id)?.handoff?.handedOff).toBe(true);
    expect(errors).not.toContain('turn.event-failed');
    expect(errors).not.toContain('turn.crash');
    expect(defined(elog.since(0)).some((e) => e.ev.kind === 'turn.event' && e.ev.event.kind === 'tool-start')).toBe(true);
    release();
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual(['deploy']);
    expect(turns.get(s.id)?.status).toBe('idle');
    expect(turns.get(s.id)?.handoff).toBeUndefined();
  });

  it('refuses input once it stops accepting, and for closed sessions', () => {
    const s = orchestrator();
    turns.close(s.id);
    expect(() => turns.send(s.id, 'x')).toThrow(/closed/);
    const t = orchestrator();
    turns.stopAccepting();
    expect(() => turns.send(t.id, 'x')).toThrow(/shutting down/);
  });
});

describe('daemon turns: crash windows and storage failures', () => {
  type DiskLog = Array<{ kind: string; text?: string; events?: Array<{ kind: string }> }>;
  const diskLog = (sessionId: string): DiskLog => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(dir, 'transcripts', `${sessionId}.json`), 'utf8')) as { log: DiskLog }).log;
    } catch {
      return [];
    }
  };
  const lastTurnKinds = (log: DiskLog): string[] =>
    ([...log].reverse().find((e) => e.kind === 'turn')?.events ?? []).map((e) => e.kind);

  /** A sessions store that records the on-disk transcript whenever `when` holds at a commit. */
  function watchedSessions(when: (s: { status: string; turns: number }) => boolean) {
    const sessions = sessionsStore(dir);
    const seen: DiskLog[] = [];
    const commit = sessions.commit.bind(sessions);
    (sessions as { commit(): void }).commit = () => {
      for (const s of Object.values(sessions.get())) if (when(s)) seen.push(diskLog(s.id));
      commit();
    };
    return { sessions, seen };
  }

  /** Leaves a session running with its turn handed off and open, as a killed daemon does. */
  async function crashMidTurn(): Promise<string> {
    const s = orchestrator();
    attempts = [
      async (_req, ctx) => {
        ctx.emit({ kind: 'text-delta', text: 'working' });
        await new Promise(() => undefined);
      },
    ];
    turns.send(s.id, 'long job');
    await new Promise((r) => setTimeout(r, 0));
    await transcripts.flush();
    await flushJsonWrites();
    return s.id;
  }

  it('makes the reply durable before the session is committed idle', async () => {
    const { sessions, seen } = watchedSessions((s) => s.status === 'idle' && s.turns > 0);
    turns = build({ sessions });
    const s = orchestrator();
    attempts = [
      (_req, ctx) => {
        ctx.emit({ kind: 'text-delta', text: 'the reply' });
        ctx.emit(END);
      },
    ];
    await send(s.id, 'hello');
    expect(seen.length).toBeGreaterThan(0);
    expect(lastTurnKinds(seen[0])).toEqual(['text-delta', 'turn-end']);
  });

  it('closes the interrupted turn on disk before the session is committed interrupted', async () => {
    const id = await crashMidTurn();
    const { sessions, seen } = watchedSessions((s) => s.status === 'interrupted');
    events = [];
    turns = build({ sessions });
    turns.reconcile();
    turns.resumeInterrupted();
    expect(seen.length).toBeGreaterThan(0);
    expect(lastTurnKinds(seen[0])).toEqual(['text-delta', 'error', 'turn-end']);
    expect(lastTurnKinds(diskLog(id))).toEqual(['text-delta', 'error', 'turn-end']);
  });

  it('closes the open turn of a session a restart already marked interrupted', async () => {
    const id = await crashMidTurn();
    // Killed after the interrupted status landed and before the closed turn did.
    const file = path.join(dir, 'sessions.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { status: string }>;
    saved[id].status = 'interrupted';
    fs.writeFileSync(file, JSON.stringify(saved));
    expect(lastTurnKinds(diskLog(id))).toEqual(['text-delta']);
    turns = build();
    turns.reconcile();
    expect(lastTurnKinds(diskLog(id))).toEqual(['text-delta', 'error', 'turn-end']);
    attempts = [(_req, ctx) => ctx.emit(END)];
    expect(turns.resumeInterrupted().map((t) => t.id)).toEqual([id]);
    turns.startRestored();
    await turns.idle();
    expect(calls.at(-1)?.prompt).toBe('Continue.');
    expect(turns.get(id)?.status).toBe('idle');
  });

  it('republishes a durable user line whose publish and rollback both failed, after a restart', async () => {
    let failing = true;
    const errors: string[] = [];
    turns = build({
      emit: (ev) => {
        if (failing && ev.kind === 'turn.user') throw new Error('The event log could not record an event.');
        events.push(ev);
      },
      log: { ...nullLogger, error: (message) => errors.push(message) },
    });
    const s = orchestrator();
    let commits = 0;
    const commit = transcripts.commit.bind(transcripts);
    transcripts.commit = (sessionId: string) => {
      commits += 1;
      if (failing && commits > 1) throw new Error('ENOSPC: no space left on device');
      commit(sessionId);
    };
    attempts = [(_req, ctx) => ctx.emit(END)];
    turns.send(s.id, 'deploy');
    await turns.idle();
    expect(calls).toEqual([]);
    expect(errors).toContain('turn.start-failed');
    // The line stayed durable although its rollback failed.
    expect(diskLog(s.id).filter((e) => e.kind === 'user').map((e) => e.text)).toEqual(['deploy']);
    expect(events.filter((e) => e.kind === 'turn.user')).toEqual([]);

    failing = false;
    await transcripts.flush();
    await flushJsonWrites();
    turns = build();
    attempts = [(_req, ctx) => ctx.emit(END), (_req, ctx) => ctx.emit(END)];
    turns.reconcile();
    turns.resumeInterrupted();
    turns.startRestored();
    await turns.idle();
    turns.send(s.id, 'next');
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual(['deploy', 'next']);
    const published = events.flatMap((e) => (e.kind === 'turn.user' ? [e.entry.text] : []));
    expect(published).toEqual(['deploy', 'next']);
    const users = transcripts.get(s.id).log.flatMap((e) => (e.kind === 'user' ? [e.text] : []));
    expect(users).toEqual(['deploy', 'next']);

    // Already published: a later redelivery of the same durable line does not publish it again.
    attempts = [(_req, ctx) => ctx.emit(END)];
    turns.send(s.id, 'third');
    await turns.idle();
    expect(events.flatMap((e) => (e.kind === 'turn.user' ? [e.entry.text] : []))).toEqual(['deploy', 'next', 'third']);
  });

  it('republishes a durable notice whose publish and rollback both failed, after a restart', async () => {
    const notice = { id: 'ntc_1', kind: 'environment.restarted' as const, at: 1, text: 'The environment restarted.' };
    pendingNotices = [notice];
    let failing = true;
    turns = build({
      emit: (ev) => {
        if (failing && ev.kind === 'turn.notice') throw new Error('The event log could not record an event.');
        events.push(ev);
      },
    });
    const s = orchestrator();
    let commits = 0;
    const commit = transcripts.commit.bind(transcripts);
    transcripts.commit = (sessionId: string) => {
      commits += 1;
      if (failing && commits > 1) throw new Error('ENOSPC: no space left on device');
      commit(sessionId);
    };
    turns.send(s.id, 'deploy');
    await turns.idle();
    expect(calls).toEqual([]);
    expect(diskLog(s.id).filter((e) => e.kind === 'notice')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'turn.notice' || e.kind === 'turn.user')).toEqual([]);

    failing = false;
    await transcripts.flush();
    await flushJsonWrites();
    turns = build();
    attempts = [(_req, ctx) => ctx.emit(END)];
    turns.reconcile();
    turns.resumeInterrupted();
    turns.startRestored();
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual([`${noticePrompt([notice])}\n\ndeploy`]);
    expect(events.flatMap((e) => (e.kind === 'turn.notice' ? [e.entry.notices.map((n) => n.id)] : []))).toEqual([['ntc_1']]);
    expect(events.flatMap((e) => (e.kind === 'turn.user' ? [e.entry.text] : []))).toEqual(['deploy']);
    expect(transcripts.get(s.id).log.filter((e) => e.kind === 'notice')).toHaveLength(1);
  });

  it('retries a turn.end the event log refused until it is appended', async () => {
    let refuse = 1;
    turns = build({
      emit: (ev) => {
        if (ev.kind === 'turn.end' && refuse > 0) {
          refuse -= 1;
          throw new Error('The event log could not record an event.');
        }
        events.push(ev);
      },
      endRetryMs: 5,
    });
    const s = orchestrator();
    attempts = [(_req, ctx) => ctx.emit(END)];
    await send(s.id, 'hello');
    expect(events.filter((e) => e.kind === 'turn.end')).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    const start = defined(events.find((e) => e.kind === 'turn.start'));
    expect(events.filter((e) => e.kind === 'turn.end')).toMatchObject([{ turnId: 'turnId' in start ? start.turnId : '' }]);
  });

  it('appends the previous turn.end before the next turn.start', async () => {
    let refuse = 1;
    turns = build({
      emit: (ev) => {
        if (ev.kind === 'turn.end' && refuse > 0) {
          refuse -= 1;
          throw new Error('The event log could not record an event.');
        }
        events.push(ev);
      },
      endRetryMs: 60_000,
    });
    const s = orchestrator();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    attempts = [
      async (_req, ctx) => {
        await gate;
        ctx.emit(END);
      },
      (_req, ctx) => ctx.emit(END),
    ];
    turns.send(s.id, 'first');
    await new Promise((r) => setTimeout(r, 0));
    turns.send(s.id, 'second');
    release();
    await turns.idle();
    const order = events.flatMap((e) => (e.kind === 'turn.start' || e.kind === 'turn.end' ? [`${e.kind}:${e.turnId}`] : []));
    const [t1, t2] = calls.map((c) => c.turnId);
    expect(order).toEqual([`turn.start:${t1}`, `turn.end:${t1}`, `turn.start:${t2}`, `turn.end:${t2}`]);
  });

  it('starts input that waited on a held turn.end once the end lands', async () => {
    let refuse = 2;
    turns = build({
      emit: (ev) => {
        if (ev.kind === 'turn.end' && refuse > 0) {
          refuse -= 1;
          throw new Error('The event log could not record an event.');
        }
        events.push(ev);
      },
      endRetryMs: 5,
    });
    const s = orchestrator();
    attempts = [(_req, ctx) => ctx.emit(END), (_req, ctx) => ctx.emit(END)];
    await send(s.id, 'first');
    turns.send(s.id, 'second');
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual(['first']);
    expect(turns.get(s.id)?.queue).toEqual([{ text: 'second', author: 'user' }]);
    await new Promise((r) => setTimeout(r, 40));
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual(['first', 'second']);
    const order = events.flatMap((e) => (e.kind === 'turn.start' || e.kind === 'turn.end' ? [e.kind] : []));
    expect(order).toEqual(['turn.start', 'turn.end', 'turn.start', 'turn.end']);
  });

  it('boot still reconciles when the closed turn cannot be written', async () => {
    const id = await crashMidTurn();
    const errors: string[] = [];
    turns = build({ log: { ...nullLogger, error: (message) => errors.push(message) } });
    transcripts.commit = () => {
      throw new Error('ENOSPC: no space left on device');
    };
    expect(turns.reconcile().map((t) => t.id)).toEqual([id]);
    expect(turns.get(id)?.status).toBe('interrupted');
    expect(errors).toEqual(['turn.reconcile-failed']);
  });

  it('closes every retained turn.start that has no turn.end at boot', async () => {
    const stats = { inputTokens: 0, outputTokens: 0, durationMs: 0 };
    events = [
      { kind: 'turn.start', sessionId: 'ses_a', turnId: 'trn_open' },
      { kind: 'turn.start', sessionId: 'ses_a', turnId: 'trn_done' },
      { kind: 'turn.end', sessionId: 'ses_a', turnId: 'trn_done', stats },
    ];
    turns = build();
    turns.reconcile();
    expect(events.filter((e) => e.kind === 'turn.end').map((e) => ('turnId' in e ? e.turnId : ''))).toEqual([
      'trn_done',
      'trn_open',
    ]);
    turns.reconcile();
    expect(events.filter((e) => e.kind === 'turn.end')).toHaveLength(2);
  });

  /** Real commit, but the directory rejects the write after the debounce is cancelled. */
  function failFinishedCommit(failing: () => boolean): void {
    const book = transcripts;
    const commit = book.commit.bind(book);
    const transcriptDir = path.join(dir, 'transcripts');
    book.commit = (sessionId: string) => {
      const last = [...book.get(sessionId).log].reverse().find((e) => e.kind === 'turn');
      const finished = last?.kind === 'turn' && last.events.some((e) => e.kind === 'turn-end');
      if (failing() && finished) {
        fs.chmodSync(transcriptDir, 0o500);
        try {
          commit(sessionId);
        } finally {
          fs.chmodSync(transcriptDir, 0o700);
        }
        return;
      }
      commit(sessionId);
    };
  }

  it('keeps the handoff when the turn-end transcript write fails, and a restart resumes it', async () => {
    const errors: string[] = [];
    turns = build({ log: { ...nullLogger, error: (message) => errors.push(message) } });
    failFinishedCommit(() => true);
    const s = orchestrator();
    attempts = [
      (_req, ctx) => {
        ctx.emit({ kind: 'text-delta', text: 'the reply' });
        ctx.emit(END);
      },
    ];
    await send(s.id, 'hello');
    expect(errors).toContain('turn.end-failed');
    expect(turns.get(s.id)?.status).toBe('running');
    expect(turns.get(s.id)?.handoff).toMatchObject({ handedOff: true, inputs: [{ text: 'hello', author: 'user' }] });
    expect(lastTurnKinds(diskLog(s.id))).not.toContain('turn-end');

    attempts = [(_req, ctx) => ctx.emit(END)];
    expect(turns.send(s.id, 'next')).toEqual({ queued: true });
    expect(calls.map((c) => c.prompt)).toEqual(['hello']);
    expect(turns.get(s.id)?.handoff).toMatchObject({ handedOff: true, inputs: [{ text: 'hello', author: 'user' }] });
    await flushJsonWrites();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<
      string,
      { status: string; queue: Array<{ text: string }>; handoff?: { handedOff: boolean } }
    >;
    expect(saved[s.id].status).toBe('running');
    expect(saved[s.id].handoff?.handedOff).toBe(true);
    expect(saved[s.id].queue).toEqual([{ text: 'next', author: 'user' }]);

    calls = [];
    attempts = [(_req, ctx) => ctx.emit(END)];
    turns = build();
    expect(turns.reconcile().map((t) => t.id)).toEqual([s.id]);
    expect(turns.resumeInterrupted().map((t) => t.id)).toEqual([s.id]);
    turns.startRestored();
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual(['Continue.\n\nnext']);
    expect(turns.get(s.id)?.status).toBe('idle');
  });

  it('retries a failed turn-end transcript write before publishing turn.end, then starts the queue', async () => {
    let failing = true;
    turns = build({ endRetryMs: 5 });
    failFinishedCommit(() => failing);
    const s = orchestrator();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    attempts = [
      async (_req, ctx) => {
        await gate;
        ctx.emit({ kind: 'text-delta', text: 'the reply' });
        ctx.emit(END);
      },
      (_req, ctx) => ctx.emit(END),
    ];
    turns.send(s.id, 'hello');
    await new Promise((r) => setTimeout(r, 0));
    expect(turns.send(s.id, 'next')).toEqual({ queued: true });
    release();
    await turns.idle();
    expect(events.filter((e) => e.kind === 'turn.end')).toEqual([]);
    expect(calls.map((c) => c.prompt)).toEqual(['hello']);
    expect(turns.get(s.id)?.status).toBe('running');
    expect(turns.get(s.id)?.handoff).toMatchObject({ handedOff: true });
    expect(lastTurnKinds(diskLog(s.id))).not.toContain('turn-end');

    expect(turns.send(s.id, 'later')).toEqual({ queued: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(events.filter((e) => e.kind === 'turn.end')).toEqual([]);
    expect(calls.map((c) => c.prompt)).toEqual(['hello']);
    expect(turns.get(s.id)?.status).toBe('running');

    failing = false;
    await new Promise((r) => setTimeout(r, 40));
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual(['hello', 'next\n\nlater']);
    const starts = events.flatMap((e) => (e.kind === 'turn.start' ? [e.turnId] : []));
    const ends = events.flatMap((e) => (e.kind === 'turn.end' ? [e.turnId] : []));
    expect(ends).toEqual(starts);
    expect(events.filter((e) => e.kind === 'turn.end')[0]).toMatchObject({
      stats: { inputTokens: 1, outputTokens: 2, durationMs: 0 },
    });
    const order = events.flatMap((e) => (e.kind === 'turn.start' || e.kind === 'turn.end' ? [e.kind] : []));
    expect(order).toEqual(['turn.start', 'turn.end', 'turn.start', 'turn.end']);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'transcripts', `${s.id}.json`), 'utf8')) as {
      log: Array<{ kind: string; events?: Array<{ kind: string; text?: string }> }>;
    };
    const first = saved.log.find((e) => e.kind === 'turn');
    expect(first?.events?.map((e) => e.kind)).toEqual(['text-delta', 'turn-end']);
    expect(first?.events?.some((e) => e.text === 'the reply')).toBe(true);
    expect(turns.get(s.id)?.status).toBe('idle');
    expect(turns.get(s.id)?.handoff).toBeUndefined();
    const sessions = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<string, { status: string; handoff?: unknown }>;
    expect(sessions[s.id].status).toBe('idle');
    expect(sessions[s.id].handoff).toBeUndefined();
  });

  it('writes the reply before the session is marked idle once the transcript write succeeds', async () => {
    const sessions = sessionsStore(dir);
    const idleWithoutReply: string[] = [];
    const commitSessions = sessions.commit.bind(sessions);
    sessions.commit = () => {
      for (const s of Object.values(sessions.get())) {
        if (s.status === 'idle' && s.turns > 0 && !lastTurnKinds(diskLog(s.id)).includes('turn-end')) idleWithoutReply.push(s.id);
      }
      commitSessions();
    };
    let failed = false;
    turns = build({ sessions });
    const commit = transcripts.commit.bind(transcripts);
    const transcriptDir = path.join(dir, 'transcripts');
    transcripts.commit = (sessionId: string) => {
      const last = [...transcripts.get(sessionId).log].reverse().find((e) => e.kind === 'turn');
      const finished = last?.kind === 'turn' && last.events.some((e) => e.kind === 'turn-end');
      if (finished && !failed) {
        failed = true;
        fs.chmodSync(transcriptDir, 0o500);
        try {
          commit(sessionId);
        } finally {
          fs.chmodSync(transcriptDir, 0o700);
        }
        return;
      }
      commit(sessionId);
    };
    const s = orchestrator();
    attempts = [
      (_req, ctx) => {
        ctx.emit({ kind: 'text-delta', text: 'the reply' });
        ctx.emit(END);
      },
      (_req, ctx) => ctx.emit(END),
    ];
    await send(s.id, 'hello');
    expect(turns.get(s.id)?.status).toBe('running');
    expect(turns.get(s.id)?.handoff?.handedOff).toBe(true);
    await send(s.id, 'next');
    expect(calls.map((c) => c.prompt)).toEqual(['hello', 'next']);
    expect(idleWithoutReply).toEqual([]);
    const recorded = diskLog(s.id).flatMap((e) => e.events?.map((ev) => ev.kind) ?? []);
    expect(recorded).toContain('text-delta');
    expect(recorded).toContain('turn-end');
    expect(turns.get(s.id)?.status).toBe('idle');
    expect(turns.get(s.id)?.handoff).toBeUndefined();
    const users = transcripts.get(s.id).log.flatMap((e) => (e.kind === 'user' ? [e.text] : []));
    expect(users).toEqual(['hello', 'next']);
  });

  it('does not resume a turn whose transcript already finished', async () => {
    const sessions = sessionsStore(dir);
    const elog = new EventLog(path.join(dir, 'events'));
    let snap = '';
    const commitSessions = sessions.commit.bind(sessions);
    sessions.commit = () => {
      const session = Object.values(sessions.get()).find((s) => s.status === 'idle' && s.turns > 0);
      if (session && !snap) {
        snap = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-crash-'));
        fs.cpSync(dir, snap, { recursive: true });
        return;
      }
      commitSessions();
    };
    turns = build({
      sessions,
      emit: (ev) => {
        if (!elog.append(ev)) throw new Error('The event log could not record an event.');
      },
      retained: () => (elog.since(0) ?? []).map((e) => e.ev),
    });
    const s = orchestrator();
    attempts = [
      (_req, ctx) => {
        ctx.emit({ kind: 'text-delta', text: 'the reply' });
        ctx.emit(END);
      },
    ];
    await send(s.id, 'hello');
    expect(snap).not.toBe('');
    const live = dir;
    dir = snap;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<string, { status: string; handoff?: { handedOff: boolean } }>;
      expect(saved[s.id].status).toBe('running');
      expect(saved[s.id].handoff?.handedOff).toBe(true);
      expect(lastTurnKinds(diskLog(s.id))).toEqual(['text-delta', 'turn-end']);
      const bootLog = new EventLog(path.join(dir, 'events'));
      events = [];
      calls = [];
      attempts = [(_req, ctx) => ctx.emit(END)];
      turns = build({
        emit: (ev) => {
          if (!bootLog.append(ev)) throw new Error('The event log could not record an event.');
          events.push(ev);
        },
        retained: () => (bootLog.since(0) ?? []).map((e) => e.ev),
      });
      expect(turns.reconcile()).toEqual([]);
      expect(turns.resumeInterrupted()).toEqual([]);
      expect(turns.get(s.id)?.status).toBe('idle');
      expect(turns.get(s.id)?.handoff).toBeUndefined();
      expect(events.filter((e) => e.kind === 'turn.end')).toMatchObject([{ stats: { inputTokens: 1, outputTokens: 2, durationMs: 0 } }]);
      turns.startRestored();
      await turns.idle();
      expect(calls).toEqual([]);
      expect(lastTurnKinds(diskLog(s.id))).toEqual(['text-delta', 'turn-end']);
    } finally {
      await transcripts.flush();
      await flushJsonWrites();
      dir = live;
      fs.rmSync(snap, { recursive: true, force: true });
    }
  });

  /** Session file written when the turn-end transcript is durable and the idle commit has not landed. */
  async function crashBeforeIdleSession(opts: {
    onTurnEnd?: (sessionId: string) => void;
    secondAttempt?: boolean;
  }): Promise<{ snap: string; id: string }> {
    const sessions = sessionsStore(dir);
    let snap = '';
    const commitSessions = sessions.commit.bind(sessions);
    sessions.commit = () => {
      const session = Object.values(sessions.get()).find((s) => s.status === 'idle' && s.turns > 0);
      if (session && !snap) {
        snap = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-crash-'));
        fs.cpSync(dir, snap, { recursive: true });
        return;
      }
      commitSessions();
    };
    let clock = 1_000;
    let sessionId = '';
    turns = build({
      sessions,
      now: () => clock,
      ...(opts.onTurnEnd ? { onTurnEnd: () => opts.onTurnEnd?.(sessionId) } : {}),
    });
    const s = orchestrator();
    sessionId = s.id;
    const record = defined(turns.get(s.id));
    record.costUsd = 2;
    record.lastTurnTokens = 3;
    sessions.commit();
    const finish = { kind: 'turn-end' as const, stats: { inputTokens: 4, outputTokens: 6, durationMs: 5, costUsd: 1 } };
    attempts = [
      (_req, ctx) => {
        clock = 5_000;
        ctx.emit({ kind: 'text-delta', text: 'the reply' });
        ctx.emit(finish);
      },
      ...(opts.secondAttempt ? [((_req, ctx) => ctx.emit(END)) as Attempt] : []),
    ];
    await send(s.id, 'hello');
    expect(snap).not.toBe('');
    return { snap, id: sessionId };
  }

  it('restores session turn accounting when the transcript finished before the session commit', async () => {
    const { snap, id } = await crashBeforeIdleSession({});
    const live = dir;
    dir = snap;
    try {
      const transcript = JSON.parse(fs.readFileSync(path.join(dir, 'transcripts', `${id}.json`), 'utf8')) as {
        turns: number;
        lastTurnTokens: number;
        lastActiveAt: number;
      };
      const before = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<
        string,
        { status: string; turns: number; lastTurnTokens: number; costUsd: number; lastActiveAt: number; handoff?: { handedOff: boolean } }
      >;
      expect(transcript).toMatchObject({ turns: 1, lastTurnTokens: 10, lastActiveAt: 5_000 });
      expect(before[id]).toMatchObject({ status: 'running', turns: 1, lastTurnTokens: 3, costUsd: 2, lastActiveAt: 1_000, handoff: { handedOff: true } });
      let clock = 5_000;
      turns = build({ now: () => clock });
      expect(turns.reconcile()).toEqual([]);
      expect(turns.resumeInterrupted()).toEqual([]);
      expect(turns.get(id)).toMatchObject({ status: 'idle', turns: 1, lastTurnTokens: 10, costUsd: 3, lastActiveAt: 5_000 });
      expect(turns.get(id)?.handoff).toBeUndefined();
      await flushJsonWrites();
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<string, { costUsd: number; lastTurnTokens: number; turns: number }>;
      expect(saved[id]).toMatchObject({ turns: 1, lastTurnTokens: 10, costUsd: 3, lastActiveAt: 5_000, status: 'idle' });
      clock = 9_000;
      attempts = [(_req, ctx) => ctx.emit({ kind: 'turn-end', stats: { inputTokens: 1, outputTokens: 1, durationMs: 1, costUsd: 4 } })];
      await send(id, 'again');
      expect(turns.get(id)).toMatchObject({ status: 'idle', turns: 2, lastTurnTokens: 2, costUsd: 7, lastActiveAt: 9_000 });
    } finally {
      await transcripts.flush();
      await flushJsonWrites();
      dir = live;
      fs.rmSync(snap, { recursive: true, force: true });
    }
  });

  it('does not add the finished turn cost again when the end snapshot is already stored', async () => {
    let queued = false;
    const { snap, id } = await crashBeforeIdleSession({
      secondAttempt: true,
      onTurnEnd: (sessionId) => {
        if (queued) return;
        queued = true;
        turns.send(sessionId, 'later');
      },
    });
    const live = dir;
    dir = snap;
    try {
      const before = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<
        string,
        { status: string; costUsd: number; lastTurnTokens: number; lastActiveAt: number; handoff?: unknown; queue: Array<{ text: string }> }
      >;
      expect(before[id]).toMatchObject({
        status: 'running',
        turns: 1,
        lastTurnTokens: 10,
        costUsd: 3,
        lastActiveAt: 5_000,
        handoff: { handedOff: true },
        queue: [{ text: 'later', author: 'user' }],
      });
      turns = build();
      expect(turns.reconcile()).toEqual([]);
      expect(turns.get(id)).toMatchObject({ status: 'idle', turns: 1, lastTurnTokens: 10, costUsd: 3, lastActiveAt: 5_000 });
      expect(turns.get(id)?.handoff).toBeUndefined();
      await flushJsonWrites();
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<string, { costUsd: number }>;
      expect(saved[id].costUsd).toBe(3);
    } finally {
      await transcripts.flush();
      await flushJsonWrites();
      dir = live;
      fs.rmSync(snap, { recursive: true, force: true });
    }
  });

  it('publishes a second identical user line the event log does not hold', async () => {
    let failSecond = true;
    let pings = 0;
    turns = build({
      emit: (ev) => {
        if (failSecond && ev.kind === 'turn.user' && ev.entry.text === 'ping' && ++pings === 2) {
          throw new Error('The event log could not record an event.');
        }
        events.push(ev);
      },
    });
    const s = orchestrator();
    let failRollback = true;
    const commit = transcripts.commit.bind(transcripts);
    transcripts.commit = (sessionId: string) => {
      const recorded = transcripts.get(sessionId).log.filter((e) => e.kind === 'user' && e.text === 'ping').length;
      if (failRollback && recorded === 1) throw new Error('ENOSPC: no space left on device');
      commit(sessionId);
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    attempts = [
      async (_req, ctx) => {
        await gate;
        ctx.emit(END);
      },
      (_req, ctx) => ctx.emit(END),
    ];
    turns.send(s.id, 'hello');
    await new Promise((r) => setTimeout(r, 0));
    turns.send(s.id, 'ping');
    turns.send(s.id, 'ping');
    release();
    await turns.idle();
    expect(diskLog(s.id).filter((e) => e.text === 'ping')).toHaveLength(2);
    expect(events.flatMap((e) => (e.kind === 'turn.user' ? [e.entry.text] : []))).toEqual(['hello', 'ping']);
    expect(calls.map((c) => c.prompt)).toEqual(['hello']);

    failSecond = false;
    failRollback = false;
    turns.send(s.id, 'next');
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual(['hello', 'ping\n\nping\n\nnext']);
    expect(events.flatMap((e) => (e.kind === 'turn.user' ? [e.entry.text] : []))).toEqual(['hello', 'ping', 'ping', 'next']);
  });

  it('queues a send instead of returning a turn id while the previous turn.end is held', async () => {
    let refuse = 1;
    turns = build({
      emit: (ev) => {
        if (ev.kind === 'turn.end' && refuse > 0) {
          refuse -= 1;
          throw new Error('The event log could not record an event.');
        }
        events.push(ev);
      },
      endRetryMs: 5,
    });
    const s = orchestrator();
    attempts = [(_req, ctx) => ctx.emit(END), (_req, ctx) => ctx.emit(END)];
    await send(s.id, 'first');
    expect(events.filter((e) => e.kind === 'turn.end')).toEqual([]);
    expect(turns.send(s.id, 'second')).toEqual({ queued: true });
    await new Promise((r) => setTimeout(r, 40));
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual(['first', 'second']);
    const starts = events.flatMap((e) => (e.kind === 'turn.start' ? [e.turnId] : []));
    const ends = events.flatMap((e) => (e.kind === 'turn.end' ? [e.turnId] : []));
    expect(starts).toHaveLength(2);
    expect(ends).toEqual(starts);
  });

  it('finalizes a turn only after the turn-end transcript write lands', async () => {
    let failing = true;
    const order: string[] = [];
    const mine: DaemonEvent[] = [];
    let sessionId = '';
    let finalized = false;
    turns = build({
      endRetryMs: 5,
      emit: (ev) => mine.push(ev),
      onTurnEnd: () => {
        if (finalized) return;
        finalized = true;
        order.push(lastTurnKinds(diskLog(sessionId)).includes('turn-end') ? 'hook-after-transcript' : 'hook-before-transcript');
        order.push(mine.some((e) => e.kind === 'turn.end') ? 'hook-after-end' : 'hook-before-end');
      },
    });
    failFinishedCommit(() => failing);
    const s = orchestrator();
    sessionId = s.id;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    attempts = [
      async (_req, ctx) => {
        await gate;
        ctx.emit({ kind: 'text-delta', text: 'the reply' });
        ctx.emit(END);
      },
      (_req, ctx) => {
        order.push('next-turn');
        ctx.emit(END);
      },
    ];
    turns.send(s.id, 'hello');
    await new Promise((r) => setTimeout(r, 0));
    expect(turns.send(s.id, 'next')).toEqual({ queued: true });
    release();
    await turns.idle();
    expect(order).toEqual([]);
    expect(mine.filter((e) => e.kind === 'turn.end')).toEqual([]);
    expect(lastTurnKinds(diskLog(s.id))).not.toContain('turn-end');
    expect(turns.get(s.id)?.status).toBe('running');

    failing = false;
    await new Promise((r) => setTimeout(r, 40));
    await turns.idle();
    expect(order).toEqual(['hook-after-transcript', 'hook-before-end', 'next-turn']);
    expect(calls.map((c) => c.prompt)).toEqual(['hello', 'next']);
    expect(turns.get(s.id)?.status).toBe('idle');
    expect(turns.get(s.id)?.handoff).toBeUndefined();
  });

  it('keeps a shutdown interrupt interrupted when the retried transcript write lands', async () => {
    let failing = true;
    const hookDisk: string[] = [];
    const mine: DaemonEvent[] = [];
    let sessionId = '';
    turns = build({
      endRetryMs: 5,
      emit: (ev) => mine.push(ev),
      onTurnEnd: () => {
        hookDisk.push(lastTurnKinds(diskLog(sessionId)).includes('turn-end') ? 'landed' : 'missing');
      },
    });
    failFinishedCommit(() => failing);
    const s = orchestrator();
    sessionId = s.id;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    attempts = [
      async (_req, ctx) => {
        await gate;
        ctx.emit({ kind: 'text-delta', text: 'partial' });
        ctx.emit(END);
      },
    ];
    turns.send(s.id, 'hello');
    await new Promise((r) => setTimeout(r, 0));
    expect(turns.interrupt(s.id, 'restart')).toBe(true);
    release();
    await turns.idle();
    expect(hookDisk).toEqual([]);
    expect(turns.get(s.id)?.status).toBe('running');
    expect(turns.get(s.id)?.handoff?.handedOff).toBe(true);
    expect(mine.filter((e) => e.kind === 'turn.end')).toEqual([]);

    failing = false;
    await new Promise((r) => setTimeout(r, 40));
    await turns.idle();
    expect(hookDisk).toEqual(['landed']);
    expect(turns.get(s.id)?.status).toBe('interrupted');
    expect(turns.get(s.id)?.handoff).toBeUndefined();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<string, { status: string; handoff?: unknown }>;
    expect(saved[s.id].status).toBe('interrupted');
    expect(saved[s.id].handoff).toBeUndefined();
    expect(lastTurnKinds(diskLog(s.id))).toEqual(['text-delta', 'turn-end']);
    expect(mine.filter((e) => e.kind === 'turn.end')).toHaveLength(1);
  });

  it('writes the turn-end transcript after the session is closed, and still publishes turn.end', async () => {
    let failing = true;
    const mine: DaemonEvent[] = [];
    turns = build({ endRetryMs: 5, emit: (ev) => mine.push(ev) });
    failFinishedCommit(() => failing);
    const s = orchestrator();
    attempts = [
      (_req, ctx) => {
        ctx.emit({ kind: 'text-delta', text: 'the reply' });
        ctx.emit(END);
      },
    ];
    await send(s.id, 'hello');
    expect(lastTurnKinds(diskLog(s.id))).not.toContain('turn-end');
    expect(mine.filter((e) => e.kind === 'turn.end')).toEqual([]);
    turns.close(s.id);
    expect(turns.get(s.id)?.status).toBe('closed');

    failing = false;
    await new Promise((r) => setTimeout(r, 40));
    expect(lastTurnKinds(diskLog(s.id))).toEqual(['text-delta', 'turn-end']);
    expect(mine.filter((e) => e.kind === 'turn.end')).toHaveLength(1);
    expect(turns.get(s.id)?.status).toBe('closed');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')) as Record<string, { status: string; handoff?: unknown }>;
    expect(saved[s.id].status).toBe('closed');
    expect(saved[s.id].handoff).toBeUndefined();
  });

  it('starts a notice-only wake once a held turn-end transcript write lands', async () => {
    let failing = true;
    const notice = { id: 'ntc_late', kind: 'environment.restarted' as const, at: 2, text: 'A worker finished.' };
    const mine: DaemonEvent[] = [];
    turns = build({ endRetryMs: 5, emit: (ev) => mine.push(ev) });
    failFinishedCommit(() => failing);
    const s = orchestrator();
    attempts = [
      (_req, ctx) => {
        ctx.emit({ kind: 'text-delta', text: 'the reply' });
        ctx.emit(END);
      },
      (_req, ctx) => ctx.emit(END),
    ];
    await send(s.id, 'hello');
    expect(turns.get(s.id)?.status).toBe('running');
    expect(mine.filter((e) => e.kind === 'turn.end')).toEqual([]);
    pendingNotices.push(notice);
    expect(turns.kick(s.id)).toBeNull();
    expect(calls.map((c) => c.prompt)).toEqual(['hello']);

    failing = false;
    await new Promise((r) => setTimeout(r, 40));
    await turns.idle();
    expect(calls.map((c) => c.prompt)).toEqual(['hello', noticePrompt([notice])]);
    expect(turns.get(s.id)?.status).toBe('idle');
    const starts = mine.flatMap((e) => (e.kind === 'turn.start' ? [e.turnId] : []));
    const ends = mine.flatMap((e) => (e.kind === 'turn.end' ? [e.turnId] : []));
    expect(ends).toEqual(starts);
    expect(lastTurnKinds(diskLog(s.id))).toContain('turn-end');
  });
});
