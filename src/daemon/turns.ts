/**
 * Sessions and their turns.
 *
 * Each session has a FIFO input queue, stored on its session record before
 * the input is acknowledged, and runs one turn at a time. Inputs that
 * arrive while a turn runs wait; the next turn takes all of them (and,
 * for the orchestrator, any pending notices) as one prompt. A turn:
 *
 *   - records the inputs as `user`/`notice` entries, then a `turn` entry;
 *   - runs the session's harness adapter, streaming every HarnessEvent as a
 *     `turn.event` and recording it in the persisted dialect;
 *   - resumes the provider conversation with the session's resume id. If
 *     the provider says the id no longer resolves BEFORE producing any
 *     content, the id is dropped and the turn silently retries once fresh.
 *     An id we only attempted is never persisted, even when echoed back;
 *   - always ends with a turn-end (synthesized if the adapter did not send
 *     one), then starts the next queued input.
 *
 * Interrupting a turn cancels its open questions and aborts the adapter.
 */

import type { AskQuestion, HarnessEvent, TurnStats } from '../harness/types';
import type {
  DaemonEvent,
  InflightTurn,
  OpenAsk,
  SessionKind,
  SessionSummary,
} from '../harness/daemon-protocol';
import { recordAskAnswer, recordEvent, type EntryAuthor, type Notice, type TurnEntry } from '../harness/transcript';
import { isStaleResumeError } from '../harness/resume';
import { harnessDescriptorById } from '../harness/providers';
import { validateSettings } from '../harness/options';
import { newId } from '../harness/ulid';
import type { DaemonAgent } from './definition';
import type { HarnessAdapter, AdapterRequest, AdapterContext } from './harness/types';
import type { Logger } from './log';
import type { JsonStore } from './store/store';
import type { QueuedInput, SessionMap, SessionRecord } from './store/sessions';
import type { TranscriptBook } from './transcripts';

export interface TurnsDeps {
  adapters: Record<string, HarnessAdapter>;
  sessions: JsonStore<SessionMap>;
  transcripts: TranscriptBook;
  emit(ev: DaemonEvent): void;
  log: Logger;
  /** The effective agent for a session (instructions composed), or null if it is gone. */
  agentFor(session: SessionRecord): DaemonAgent | null;
  /** The complete harness process environment for a session's turn. */
  envFor(session: SessionRecord): Record<string, string>;
  /** Notices to deliver with the orchestrator's next turn (removed from the pending list). */
  takeNotices(): Notice[];
  now?: () => number;
}

interface PendingAsk {
  sessionId: string;
  turnId: string;
  questions: AskQuestion[];
  resolve(answers: Record<string, string> | null): void;
}

interface ActiveTurn {
  turnId: string;
  startedAt: number;
  interrupted: boolean;
  /** Interrupt hooks of the current attempt. */
  interruptFns: Array<() => void>;
  aborter: AbortController;
  done: Promise<void>;
}

const ZERO_STATS: TurnStats = { inputTokens: 0, outputTokens: 0, durationMs: 0 };

/** Notices as the orchestrator reads them at the top of its prompt. */
export function noticePrompt(notices: Notice[]): string {
  return ['[Puck] Updates since your last turn:', ...notices.map((n) => `- ${n.text}`)].join('\n');
}

export class Turns {
  private readonly queues = new Map<string, QueuedInput[]>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly asks = new Map<string, PendingAsk>();
  private accepting = true;
  private readonly now: () => number;

  constructor(private readonly deps: TurnsDeps) {
    this.now = deps.now ?? Date.now;
    this.restoreQueues();
  }

  /* ---------- Sessions ---------- */

  list(): SessionRecord[] {
    return Object.values(this.deps.sessions.get()).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(sessionId: string): SessionRecord | null {
    const map = this.deps.sessions.get();
    return Object.prototype.hasOwnProperty.call(map, sessionId) ? map[sessionId] : null;
  }

  /** The open orchestrator session, if any. */
  orchestrator(): SessionRecord | null {
    return this.list().find((s) => s.kind === 'orchestrator' && s.status !== 'closed') ?? null;
  }

  create(init: { kind: SessionKind; agent: string; harness: string; cwd: string; itemId?: string }): SessionRecord {
    const at = this.now();
    const session: SessionRecord = {
      id: newId('ses', at),
      kind: init.kind,
      agent: init.agent,
      harness: init.harness,
      ...(init.itemId ? { itemId: init.itemId } : {}),
      cwd: init.cwd,
      status: 'idle',
      queue: [],
      turns: 0,
      lastTurnTokens: 0,
      costUsd: 0,
      createdAt: at,
      lastActiveAt: at,
    };
    this.deps.sessions.get()[session.id] = session;
    this.deps.sessions.save();
    this.deps.log.info('session.create', { sessionId: session.id, kind: session.kind, agent: session.agent });
    this.upsert(session);
    return session;
  }

  close(sessionId: string): void {
    const session = this.get(sessionId);
    if (!session || session.status === 'closed') return;
    session.status = 'closed';
    this.deps.sessions.save();
    this.upsert(session);
  }

  summary(session: SessionRecord): SessionSummary {
    return {
      id: session.id,
      kind: session.kind,
      agent: session.agent,
      harness: session.harness,
      ...(session.itemId ? { itemId: session.itemId } : {}),
      cwd: session.cwd,
      status: session.status,
      turns: session.turns,
      lastTurnTokens: session.lastTurnTokens,
      costUsd: session.costUsd,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      queued: this.queues.get(session.id)?.length ?? 0,
    };
  }

  private upsert(session: SessionRecord): void {
    this.deps.emit({ kind: 'session.upsert', session: this.summary(session) });
  }

  /**
   * Boot reconciliation: a session whose turn was in flight when the daemon
   * stopped becomes `interrupted`, and its unfinished turn entry is closed
   * (unanswered questions marked dismissed, an error and a turn-end
   * appended) so replay renders a finished turn. Returns the sessions touched.
   */
  reconcile(): SessionRecord[] {
    const touched: SessionRecord[] = [];
    const at = this.now();
    for (const session of this.list()) {
      if (session.status !== 'running') continue;
      session.status = 'interrupted';
      touched.push(session);
      const log = this.deps.transcripts.get(session.id).log;
      const last = [...log].reverse().find((e): e is TurnEntry => e.kind === 'turn');
      if (last && !last.events.some((e) => e.kind === 'turn-end')) {
        for (const e of last.events) if (e.kind === 'ask' && e.answers === undefined) e.answers = null;
        last.events.push({ kind: 'error', message: 'The environment restarted during this turn.', ts: at });
        last.events.push({ kind: 'turn-end', stats: ZERO_STATS, ts: at });
        this.deps.transcripts.saveNow(session.id);
      }
    }
    if (touched.length) this.deps.sessions.save();
    this.restoreQueues();
    this.startQueued();
    return touched;
  }

  private restoreQueues(): void {
    for (const session of this.list()) {
      if (session.status === 'closed' || this.queues.has(session.id) || session.queue.length === 0) continue;
      this.queues.set(
        session.id,
        session.queue.map((item) => ({ text: item.text, author: item.author })),
      );
    }
  }

  private startQueued(): void {
    if (!this.accepting) return;
    for (const session of this.list()) {
      if (session.status === 'closed' || this.active.has(session.id)) continue;
      if (this.queues.get(session.id)?.length) this.startTurn(session);
    }
  }

  private persistQueue(session: SessionRecord): void {
    session.queue = (this.queues.get(session.id) ?? []).map((item) => ({ text: item.text, author: item.author }));
    this.deps.sessions.commit();
  }

  /* ---------- Inputs and turns ---------- */

  /** Stop taking new input (shutdown, upgrade). */
  stopAccepting(): void {
    this.accepting = false;
  }

  /** Take input again (an upgrade that failed before the swap). */
  resumeAccepting(): void {
    this.accepting = true;
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  /**
   * Queue an input. Starts a turn right away when the session is idle;
   * otherwise the input waits for the running turn to end.
   */
  send(sessionId: string, text: string, author: EntryAuthor = 'user'): { queued: boolean; turnId?: string } {
    const session = this.get(sessionId);
    if (!session) throw new TurnsError('not-found', `No session ${sessionId}.`);
    if (session.status === 'closed') throw new TurnsError('invalid-state', 'This session is closed.');
    if (!this.accepting) throw new TurnsError('not-ready', 'The environment is shutting down or upgrading.');
    const queue = this.queues.get(sessionId) ?? [];
    queue.push({ text, author });
    this.queues.set(sessionId, queue);
    this.persistQueue(session);
    if (this.active.has(sessionId)) {
      this.upsert(session);
      return { queued: true };
    }
    return { queued: false, turnId: this.startTurn(session) };
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  interrupt(sessionId: string): boolean {
    const turn = this.active.get(sessionId);
    if (!turn) return false;
    turn.interrupted = true;
    this.cancelAsks(sessionId);
    for (const fn of turn.interruptFns) {
      try {
        fn();
      } catch {
        // best effort
      }
    }
    turn.aborter.abort();
    return true;
  }

  /** Interrupt every running turn and wait for all of them to end. */
  async interruptAll(): Promise<void> {
    for (const sessionId of [...this.active.keys()]) this.interrupt(sessionId);
    await this.idle();
  }

  /** Resolves once no turn is running (queued inputs still start turns while accepting). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active.values()].map((t) => t.done));
  }

  answer(sessionId: string, askId: string, answers: Record<string, string> | null): boolean {
    const ask = this.asks.get(askId);
    if (!ask || ask.sessionId !== sessionId) return false;
    this.closeAsk(askId, answers, 'user');
    return true;
  }

  private closeAsk(askId: string, answers: Record<string, string> | null, by: 'user' | 'orchestrator' | 'cancelled'): void {
    const ask = this.asks.get(askId);
    if (!ask) return;
    this.asks.delete(askId);
    const entry = this.deps.transcripts.turn(ask.sessionId, ask.turnId);
    if (entry && recordAskAnswer(entry, askId, answers)) this.deps.transcripts.saveSoon(ask.sessionId);
    this.deps.emit({ kind: 'ask.closed', sessionId: ask.sessionId, askId, answers, by });
    ask.resolve(answers);
  }

  private cancelAsks(sessionId: string): void {
    for (const [askId, ask] of [...this.asks]) if (ask.sessionId === sessionId) this.closeAsk(askId, null, 'cancelled');
  }

  inflight(): InflightTurn[] {
    const out: InflightTurn[] = [];
    for (const [sessionId, turn] of this.active) {
      const entry = this.deps.transcripts.turn(sessionId, turn.turnId);
      out.push({ sessionId, turnId: turn.turnId, startedAt: turn.startedAt, events: entry ? [...entry.events] : [] });
    }
    return out;
  }

  openAsks(): OpenAsk[] {
    return [...this.asks].map(([askId, a]) => ({
      sessionId: a.sessionId,
      turnId: a.turnId,
      askId,
      questions: a.questions,
      routedTo: 'user',
    }));
  }

  private startTurn(session: SessionRecord): string {
    const turnId = newId('trn', this.now());
    const turn: ActiveTurn = {
      turnId,
      startedAt: this.now(),
      interrupted: false,
      interruptFns: [],
      aborter: new AbortController(),
      done: Promise.resolve(),
    };
    this.active.set(session.id, turn);
    turn.done = this.runTurn(session, turn)
      .catch((err) => this.deps.log.error('turn.crash', err, { sessionId: session.id, turnId }))
      .finally(() => {
        this.active.delete(session.id);
        const next = this.queues.get(session.id);
        if (next?.length && this.accepting && session.status !== 'closed') this.startTurn(session);
        else this.upsert(session);
      });
    return turnId;
  }

  private async runTurn(session: SessionRecord, turn: ActiveTurn): Promise<void> {
    const { transcripts, emit, log } = this.deps;
    const inputs = this.queues.get(session.id)?.splice(0) ?? [];
    this.persistQueue(session);
    const notices = session.kind === 'orchestrator' ? this.deps.takeNotices() : [];
    const at = this.now();

    if (notices.length) {
      const entry = { kind: 'notice' as const, ts: at, notices };
      transcripts.append(session.id, entry);
      emit({ kind: 'turn.notice', sessionId: session.id, entry });
    }
    for (const input of inputs) {
      const entry = { kind: 'user' as const, text: input.text, author: input.author, ts: at };
      transcripts.append(session.id, entry);
      emit({ kind: 'turn.user', sessionId: session.id, entry });
    }
    const prompt = [...(notices.length ? [noticePrompt(notices)] : []), ...inputs.map((i) => i.text)].join('\n\n');
    const record: TurnEntry = { kind: 'turn', turnId: turn.turnId, ts: at, events: [] };
    transcripts.append(session.id, record);

    session.status = 'running';
    session.turns += 1;
    session.lastActiveAt = at;
    this.deps.sessions.save();
    this.upsert(session);
    emit({ kind: 'turn.start', sessionId: session.id, turnId: turn.turnId });
    log.info('turn.start', {
      sessionId: session.id,
      turnId: turn.turnId,
      agent: session.agent,
      harness: session.harness,
      resume: !!session.resumeId,
    });

    let ended = false;
    let thinking = false;
    let stats: TurnStats = { ...ZERO_STATS };
    const forward = (event: HarnessEvent): void => {
      const now = this.now();
      if (event.kind === 'thinking') thinking = event.active;
      if (event.kind === 'turn-end') {
        if (ended) return; // one turn-end per turn, whatever the adapter does
        ended = true;
        stats = event.stats;
      }
      const stamped: HarnessEvent = event.kind === 'thinking' ? event : { ...event, ts: now };
      if (recordEvent(record, event, now)) transcripts.saveSoon(session.id);
      emit({ kind: 'turn.event', sessionId: session.id, turnId: turn.turnId, event: stamped });
    };

    try {
      const agent = this.deps.agentFor(session);
      const adapter = this.deps.adapters[session.harness];
      const descriptor = harnessDescriptorById(session.harness);
      if (!agent || !adapter || !descriptor) {
        throw new Error(
          !agent
            ? `The agent "${session.agent}" is not in this environment's definition.`
            : `This daemon has no adapter for the harness "${session.harness}".`,
        );
      }
      const settings = descriptor.compileSettings(validateSettings(descriptor.configOptions, agent.options));
      const env = this.deps.envFor(session);
      const resume = session.resumeId ?? null;
      // Attempt 0 resumes; if the provider reports the id no longer resolves
      // before any content, drop it and retry once with a fresh session.
      const attempts = resume ? [resume, null] : [null];
      for (let i = 0; i < attempts.length; i++) {
        const attempt = attempts[i];
        let stale = false;
        let sawContent = false;
        const aborter = new AbortController();
        turn.aborter.signal.addEventListener('abort', () => aborter.abort(), { once: true });
        turn.interruptFns = [];
        const req: AdapterRequest = {
          sessionId: session.id,
          turnId: turn.turnId,
          prompt,
          resumeId: attempt,
          cwd: session.cwd,
          agent,
          settings,
          tools: session.kind === 'orchestrator' ? 'orchestrator' : null,
          env,
        };
        const ctx: AdapterContext = {
          emit: (event) => {
            if (stale) return; // the abandoned attempt's tail
            if (event.kind === 'text-delta' || event.kind === 'tool-start') sawContent = true;
            if (
              attempt !== null &&
              !sawContent &&
              !turn.interrupted &&
              event.kind === 'error' &&
              isStaleResumeError(event.message)
            ) {
              stale = true;
              delete session.resumeId;
              this.deps.sessions.save();
              log.info('turn.resume-stale', { sessionId: session.id, turnId: turn.turnId });
              for (const fn of turn.interruptFns) {
                try {
                  fn();
                } catch {
                  // best effort
                }
              }
              aborter.abort();
              return;
            }
            if (event.kind === 'error') log.warn('turn.error', { turnId: turn.turnId, message: event.message });
            forward(event);
          },
          reportSession: (id) => {
            // Never persist a rejected id, and never re-persist the id we
            // merely ATTEMPTED: providers echo it even when they refused it.
            if (stale || id === attempt || !id) return;
            if (session.resumeId !== id) {
              session.resumeId = id;
              this.deps.sessions.save();
            }
          },
          onInterrupt: (fn) => {
            turn.interruptFns.push(fn);
            if (turn.interrupted) fn();
          },
          askUser: (questions) => this.ask(session, turn, questions, forward),
          signal: aborter.signal,
        };
        try {
          await adapter.run(req, ctx);
        } catch (err) {
          if (!stale && !turn.interrupted) forward({ kind: 'error', message: errText(err) });
        }
        if (!stale) break;
      }
    } catch (err) {
      forward({ kind: 'error', message: errText(err) });
    } finally {
      this.cancelAsks(session.id);
      if (!ended) {
        if (thinking) forward({ kind: 'thinking', active: false });
        forward({ kind: 'turn-end', stats: { ...ZERO_STATS, durationMs: this.now() - turn.startedAt } });
      }
      const tokens = stats.inputTokens + stats.outputTokens;
      if (tokens > 0) session.lastTurnTokens = tokens;
      if (typeof stats.costUsd === 'number') session.costUsd += stats.costUsd;
      session.lastActiveAt = this.now();
      if (session.status === 'running') session.status = 'idle';
      const t = transcripts.get(session.id);
      t.turns = session.turns;
      t.lastTurnTokens = session.lastTurnTokens;
      t.lastActiveAt = session.lastActiveAt;
      transcripts.saveNow(session.id);
      this.deps.sessions.save();
      emit({ kind: 'turn.end', sessionId: session.id, turnId: turn.turnId, stats });
      log.info('turn.end', {
        sessionId: session.id,
        turnId: turn.turnId,
        ms: this.now() - turn.startedAt,
        interrupted: turn.interrupted,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
      });
    }
  }

  private ask(
    session: SessionRecord,
    turn: ActiveTurn,
    questions: AskQuestion[],
    forward: (event: HarnessEvent) => void,
  ): Promise<Record<string, string> | null> {
    if (turn.interrupted) return Promise.resolve(null);
    const askId = newId('ask', this.now());
    return new Promise((resolve) => {
      this.asks.set(askId, { sessionId: session.id, turnId: turn.turnId, questions, resolve });
      forward({ kind: 'ask', askId, questions });
      this.deps.emit({ kind: 'ask.routed', sessionId: session.id, askId, to: 'user' });
    });
  }
}

export class TurnsError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid-state' | 'not-ready',
    message: string,
  ) {
    super(message);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
