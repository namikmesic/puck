/**
 * Sessions and their turns.
 *
 * Each session has a FIFO input queue, stored on its session record before
 * the input is acknowledged, and runs one turn at a time. Inputs that
 * arrive while a turn runs wait; the next turn takes all of them (and,
 * for the orchestrator, any pending notices) as one prompt. A turn:
 *
 *   - commits one turn-start record on the session: the inputs leave the
 *     queue, the session is running, and the turn id plus the exact input
 *     text are stored, not yet handed off. The transcript entries follow.
 *     Immediately before the prompt reaches the adapter, that record is
 *     marked handed off. A restart redelivers the text until then, and
 *     resumes with a short continue once it has been handed off;
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
import {
  recordAskAnswer,
  recordEvent,
  type EntryAuthor,
  type Notice,
  type TranscriptEntry,
  type TurnEntry,
} from '../harness/transcript';
import { isStaleResumeError } from '../harness/resume';
import { harnessDescriptorById } from '../harness/providers';
import { validateSettings } from '../harness/options';
import { newId } from '../harness/ulid';
import type { DaemonAgent } from './definition';
import type { HarnessAdapter, AdapterRequest, AdapterContext } from './harness/types';
import type { Logger } from './log';
import type { JsonStore } from './store/store';
import type { QueuedInput, SessionMap, SessionRecord, TurnHandoff } from './store/sessions';
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
  /** Pending notices still stored. A snapshot the caller may record. */
  peekNotices(): Notice[];
  /** Fsync the pending list once its first `count` notices are in the transcript. */
  commitNotices(count: number): void;
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
  started: boolean;
  interrupted: boolean;
  /** Interrupt hooks of the current attempt. */
  interruptFns: Array<() => void>;
  aborter: AbortController;
  done: Promise<void>;
}

const ZERO_STATS: TurnStats = { inputTokens: 0, outputTokens: 0, durationMs: 0 };

/** Sent when a restart resumes an interrupted turn. Kept in the input queue, not a new store. */
const RESUME_PROMPT = 'Continue.';

/** Reconcile closes an interrupted turn with this error so replay can tell it from a finished one. */
const RESTART_ERROR = 'The environment restarted during this turn.';

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
        last.events.push({ kind: 'error', message: RESTART_ERROR, ts: at });
        last.events.push({ kind: 'turn-end', stats: ZERO_STATS, ts: at });
        this.deps.transcripts.saveNow(session.id);
      }
    }
    if (touched.length) this.deps.sessions.save();
    this.restoreQueues();
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

  /**
   * Queue recovery for every session a restart left interrupted. A turn not
   * yet handed to the adapter is delivered again as its stored text (the
   * saved resume id is used when there is one). A turn already handed off
   * resumes with a short continue. Follow-ups already queued stay behind
   * that text. Returns the sessions that will resume.
   */
  resumeInterrupted(): SessionRecord[] {
    const resumed: SessionRecord[] = [];
    for (const session of this.list()) {
      if (session.status !== 'interrupted') continue;
      const queue = this.queues.get(session.id) ?? [];
      const handoff = session.handoff;
      if (handoff && !handoff.handedOff) {
        if (handoff.inputs.length && !startsWithInputs(queue, handoff.inputs)) queue.unshift(...handoff.inputs.map(copyInput));
      } else if (!queue.some((item) => item.author === 'system' && item.text === RESUME_PROMPT)) {
        queue.unshift({ text: RESUME_PROMPT, author: 'system' });
      }
      this.queues.set(session.id, queue);
      this.persistQueue(session);
      resumed.push(session);
    }
    return resumed;
  }

  /** Start restored inputs on open sessions that are not already running. */
  startRestored(): void {
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
      started: false,
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
        if (turn.started && next?.length && this.accepting && session.status !== 'closed') this.startTurn(session);
        else this.upsert(session);
      });
    return turnId;
  }

  private async runTurn(session: SessionRecord, turn: ActiveTurn): Promise<void> {
    const { transcripts, emit, log } = this.deps;
    const inputs = (this.queues.get(session.id) ?? []).slice();
    const notices = session.kind === 'orchestrator' ? this.deps.peekNotices() : [];
    const at = this.now();
    this.commitStarted(session, turn.turnId, inputs, at);

    const prompt = [...(notices.length ? [noticePrompt(notices)] : []), ...inputs.map((i) => i.text)].join('\n\n');
    try {
      this.recordDurable(session, inputs, notices, at);
      if (notices.length) this.deps.commitNotices(notices.length);
    } catch (err) {
      this.abortUnhanded(session, inputs);
      throw err;
    }
    const record: TurnEntry = { kind: 'turn', turnId: turn.turnId, ts: at, events: [] };
    transcripts.append(session.id, record);

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

    let startFailed = false;
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
        if (i === 0) {
          try {
            this.markHandedOff(session);
          } catch (err) {
            startFailed = true;
            this.abortUnhanded(session, inputs);
            throw err;
          }
          turn.started = true;
        }
        try {
          await adapter.run(req, ctx);
        } catch (err) {
          if (!stale && !turn.interrupted) forward({ kind: 'error', message: errText(err) });
        }
        if (!stale) break;
      }
    } catch (err) {
      if (startFailed) throw err;
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
      delete session.handoff;
      const t = transcripts.get(session.id);
      t.turns = session.turns;
      t.lastTurnTokens = session.lastTurnTokens;
      t.lastActiveAt = session.lastActiveAt;
      transcripts.saveNow(session.id);
      try {
        this.deps.sessions.commit();
      } catch (err) {
        log.error('turn.end-failed', err, { sessionId: session.id });
      }
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

  /** One commit: queue no longer holds these inputs, the session is running, and the text is stored unhanded. */
  private commitStarted(session: SessionRecord, turnId: string, inputs: QueuedInput[], at: number): void {
    const previous = {
      status: session.status,
      queue: session.queue.map(copyInput),
      turns: session.turns,
      lastActiveAt: session.lastActiveAt,
      handoff: session.handoff,
    };
    const handoff: TurnHandoff = { turnId, inputs: inputs.map(copyInput), handedOff: false };
    session.status = 'running';
    session.turns += 1;
    session.lastActiveAt = at;
    session.queue = [];
    session.handoff = handoff;
    try {
      this.deps.sessions.commit();
    } catch (err) {
      session.status = previous.status;
      session.queue = previous.queue;
      session.turns = previous.turns;
      session.lastActiveAt = previous.lastActiveAt;
      if (previous.handoff) session.handoff = previous.handoff;
      else delete session.handoff;
      throw err;
    }
    const live = this.queues.get(session.id);
    if (live) live.splice(0, inputs.length);
  }

  /** The prompt is about to be passed to the adapter. A crash after this resumes with continue. */
  private markHandedOff(session: SessionRecord): void {
    const handoff = session.handoff;
    if (!handoff || handoff.handedOff) return;
    handoff.handedOff = true;
    try {
      this.deps.sessions.commit();
    } catch (err) {
      handoff.handedOff = false;
      throw err;
    }
  }

  /**
   * The turn-start commit landed but the prompt was never passed on. Put the
   * text back on the queue and drop the record so a later start can deliver
   * it, without scheduling another attempt from this failure.
   */
  private abortUnhanded(session: SessionRecord, inputs: QueuedInput[]): void {
    const queue = this.queues.get(session.id) ?? [];
    if (inputs.length && !startsWithInputs(queue, inputs)) queue.unshift(...inputs.map(copyInput));
    this.queues.set(session.id, queue);
    session.queue = queue.map(copyInput);
    session.status = 'idle';
    session.turns = Math.max(0, session.turns - 1);
    delete session.handoff;
    try {
      this.deps.sessions.commit();
    } catch (err) {
      this.deps.log.error('turn.start-failed', err, { sessionId: session.id });
    }
  }

  private recordDurable(session: SessionRecord, inputs: QueuedInput[], notices: Notice[], at: number): void {
    if (inputs.length === 0 && notices.length === 0) return;
    const { transcripts, emit } = this.deps;
    const log = transcripts.get(session.id).log;
    const missing = missingInputs(userTail(log), inputs);
    const noticeMissing = notices.length > 0 && !log.some((entry) => entry.kind === 'notice' && sameNotices(entry.notices, notices));
    if (missing.length === 0 && !noticeMissing) return;
    const start = log.length;
    const added: TranscriptEntry[] = [];
    if (noticeMissing) added.push({ kind: 'notice', ts: at, notices });
    for (const input of missing) added.push({ kind: 'user', text: input.text, author: input.author, ts: at });
    log.push(...added);
    try {
      transcripts.commit(session.id);
    } catch (err) {
      log.splice(start);
      throw err;
    }
    for (const entry of added) {
      if (entry.kind === 'notice') emit({ kind: 'turn.notice', sessionId: session.id, entry });
      else if (entry.kind === 'user') emit({ kind: 'turn.user', sessionId: session.id, entry });
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

function copyInput(item: QueuedInput): QueuedInput {
  return { text: item.text, author: item.author };
}

function sameInput(a: QueuedInput, b: QueuedInput): boolean {
  return a.text === b.text && a.author === b.author;
}

function startsWithInputs(queue: QueuedInput[], inputs: QueuedInput[]): boolean {
  return inputs.every((item, i) => queue[i] !== undefined && sameInput(queue[i], item));
}

function sawProvider(events: TurnEntry['events']): boolean {
  return events.some(
    (e) => e.kind === 'text-delta' || e.kind === 'thinking' || e.kind === 'tool-start' || e.kind === 'tool-end' || e.kind === 'ask',
  );
}

/** User lines of the in-flight turn. A finished turn ends the tail; a restart-closed one does not. */
function userTail(log: TranscriptEntry[]): QueuedInput[] {
  const inputs: QueuedInput[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind === 'notice') continue;
    if (entry.kind === 'turn') {
      if (sawProvider(entry.events) || finishedTurn(entry.events)) break;
      continue;
    }
    if (entry.kind !== 'user') break;
    inputs.unshift({ text: entry.text, author: entry.author });
  }
  return inputs;
}

function finishedTurn(events: TurnEntry['events']): boolean {
  const ended = events.some((event) => event.kind === 'turn-end');
  const restarted = events.some((event) => event.kind === 'error' && event.message === RESTART_ERROR);
  return ended && !restarted;
}

function missingInputs(tail: QueuedInput[], inputs: QueuedInput[]): QueuedInput[] {
  if (tail.length <= inputs.length && startsWithInputs(inputs, tail)) return inputs.slice(tail.length);
  if (tail.length >= inputs.length && startsWithInputs(tail.slice(tail.length - inputs.length), inputs)) return [];
  return inputs;
}

function sameNotices(recorded: Notice[], notices: Notice[]): boolean {
  return recorded.length === notices.length && recorded.every((notice, i) => notice.id === notices[i].id);
}
