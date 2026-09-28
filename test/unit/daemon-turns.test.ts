import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonEvent } from '../../src/harness/daemon-protocol';
import type { HarnessEvent } from '../../src/harness/types';
import type { TurnEntry } from '../../src/harness/transcript';
import type { DaemonAgent } from '../../src/daemon/definition';
import type { AdapterContext, AdapterRequest, HarnessAdapter } from '../../src/daemon/harness/types';
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
    expect(calls[0].prompt).toBe('[Puck] Updates since your last turn:\n- The environment restarted.\n\nstatus?');
    expect(noticePrompt([notice])).toBe('[Puck] Updates since your last turn:\n- The environment restarted.');
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
    expect(calls.map((c) => c.prompt)).toEqual(['[Puck] Updates since your last turn:\n- The environment restarted.\n\nkeep me']);
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

  it('refuses input once it stops accepting, and for closed sessions', () => {
    const s = orchestrator();
    turns.close(s.id);
    expect(() => turns.send(s.id, 'x')).toThrow(/closed/);
    const t = orchestrator();
    turns.stopAccepting();
    expect(() => turns.send(t.id, 'x')).toThrow(/shutting down/);
  });
});
