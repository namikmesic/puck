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
 *     one). The transcript is fsynced before the turn is finalized, before
 *     the session record says the turn is over, and before `turn.end` is
 *     published. Queued text or pending notices start only after that. A
 *     failed transcript fsync keeps the handoff and the chosen end status
 *     (idle, or interrupted after shutdown or upgrade) and is retried until
 *     it lands, even if the session was closed meanwhile. A `turn.end` the
 *     event log refuses is retried until appended.
 *
 * Interrupting a turn cancels its open questions and aborts the adapter.
 * An interrupt from shutdown or upgrade leaves the session `interrupted`,
 * so the next boot resumes it like a crash would.
 *
 * Worker sessions belong to work items: `canStart` keeps them from starting
 * on their own (the scheduler starts them), `onTurnEnd` hands each finished
 * turn to the item logic only after the turn-end transcript fsync and before
 * the next queued input may start, and `routeAsk` decides whether a question
 * waits for the user or the orchestrator.
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
  type UserEntry,
} from '../harness/transcript';
import { isStaleResumeError } from '../harness/resume';
import { harnessDescriptorById } from '../harness/providers';
import { validateSettings } from '../harness/options';
import { newId } from '../harness/ulid';
import type { DaemonAgent } from '../harness/env-definition';
import { JournalError } from './delivery/journal';
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
  /** Every event the event log still retains, oldest first. Read at boot and on rare recovery paths. */
  retained(): DaemonEvent[];
  log: Logger;
  /** The effective agent for a session (instructions composed), or null if it is gone. */
  agentFor(session: SessionRecord): DaemonAgent | null;
  /** The complete harness process environment for a session's turn. */
  envFor(session: SessionRecord): Record<string, string>;
  /** Pending notices still stored. A snapshot the caller may record. */
  peekNotices(): Notice[];
  /** Fsync the pending list once its first `count` notices are in the transcript. */
  commitNotices(count: number): void;
  /** False keeps a session's queued input waiting (a worker whose item holds no slot). Default: true. */
  canStart?(session: SessionRecord): boolean;
  /** Awaited once the turn-end transcript is durable, before the end status is committed and before the next input may start. */
  onTurnEnd?(session: SessionRecord, outcome: TurnOutcome): Promise<void> | void;
  /** Where a new question waits. Default: the user. */
  routeAsk?(session: SessionRecord, askId: string, questions: AskQuestion[]): 'user' | 'orchestrator';
  /** A question was answered or cancelled. */
  onAskClosed?(session: SessionRecord, askId: string, by: AskCloser): void;
  /**
   * The input queued when a restart resumes a turn that had reached the
   * harness. Default: a short continue. Null queues nothing (the owner of
   * the session supplies its own input later).
   */
  resumeText?(session: SessionRecord): string | null;
  /** Extra summary fields (the orchestrator's auto-wake state). */
  summaryExtra?(session: SessionRecord): Partial<SessionSummary>;
  now?: () => number;
  /** How often a held end is retried: the transcript commit, then `turn.end`, then a start that waited. */
  endRetryMs?: number;
}

export type AskCloser = 'user' | 'orchestrator' | 'cancelled';

/** Why a turn was cut short: a user (or cancel) interrupt, or daemon shutdown/upgrade. */
export type InterruptReason = 'user' | 'restart';

export interface TurnOutcome {
  turnId: string;
  /** The last top-level error of the turn, when it failed. */
  error: string | null;
  interrupted: InterruptReason | null;
  /** The recorded turn (null when it never started). */
  entry: TurnEntry | null;
  /** Notices this turn delivered (orchestrator only). */
  notices: Notice[];
}

type TurnEndEvent = Extract<DaemonEvent, { kind: 'turn.end' }>;

interface HeldEnd {
  ev: TurnEndEvent;
  status: 'idle' | 'interrupted';
  outcome: TurnOutcome;
  landed: boolean;
  finalized: boolean;
  released: boolean;
}

interface PendingAsk {
  sessionId: string;
  turnId: string;
  questions: AskQuestion[];
  routedTo: 'user' | 'orchestrator';
  note?: string;
  resolve(answers: Record<string, string> | null): void;
}

interface ActiveTurn {
  turnId: string;
  startedAt: number;
  started: boolean;
  interrupted: boolean;
  reason: InterruptReason | null;
  /** Interrupt hooks of the current attempt. */
  interruptFns: Array<() => void>;
  aborter: AbortController;
  done: Promise<void>;
}

const ZERO_STATS: TurnStats = { inputTokens: 0, outputTokens: 0, durationMs: 0 };

const END_RETRY_MS = 1000;

/** Sent when a restart resumes an interrupted turn. Kept in the input queue, not a new store. */
export const RESUME_PROMPT = 'Continue.';

/** Reconcile closes an interrupted turn with this error so replay can tell it from a finished one. */
const RESTART_ERROR = 'The environment restarted during this turn.';

/** Notices as the orchestrator reads them at the top of its prompt. */
export function noticePrompt(notices: Notice[]): string {
  return [
    '[Puck] Updates since your last turn:',
    ...notices.map((n) => `- ${n.text}`),
    'Decide what to do next. If nothing needs doing, reply in one sentence.',
  ].join('\n');
}

export class Turns {
  private readonly queues = new Map<string, QueuedInput[]>();
  private readonly active = new Map<string, ActiveTurn>();
  private readonly asks = new Map<string, PendingAsk>();
  private accepting = true;
  private readonly now: () => number;
  /** `turn.end` events not yet appended, by turn id, until an append succeeds. */
  private readonly unsentEnds = new Map<string, TurnEndEvent>();
  private readonly heldEnds = new Map<string, HeldEnd>();
  private readonly releasing = new Map<string, Promise<boolean>>();
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sessions whose start waited on a held end; started once it lands. */
  private readonly blockedStarts = new Set<string>();

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

  create(init: { kind: SessionKind; agent: string; harness: string; cwd: string; itemId?: string; stepId?: string }): SessionRecord {
    const at = this.now();
    const session: SessionRecord = {
      id: newId('ses', at),
      kind: init.kind,
      agent: init.agent,
      harness: init.harness,
      ...(init.itemId ? { itemId: init.itemId } : {}),
      ...(init.stepId ? { stepId: init.stepId } : {}),
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
    // Durable before a journaled ticket names it (the ticket's session is recorded next).
    this.deps.sessions.commit();
    this.deps.log.info('session.create', { sessionId: session.id, kind: session.kind, agent: session.agent });
    this.upsert(session);
    return session;
  }

  /** A worker session works for another implement step now (a new round, a retry). */
  bindStep(sessionId: string, stepId: string): void {
    const session = this.get(sessionId);
    if (!session || session.stepId === stepId) return;
    session.stepId = stepId;
    this.deps.sessions.save();
  }

  /**
   * The texts a session holds as input, one per logical input: queued,
   * handed to the running turn, or recorded in the transcript at or after
   * `since`. An input handed to a turn is in the handoff and, once its turn
   * recorded it, in the transcript too; it counts once, so a repeated
   * request with the same text stays distinct. Boot recovery compares
   * journaled step inputs against it.
   */
  inputTexts(sessionId: string, since: number): string[] {
    const session = this.get(sessionId);
    if (!session) return [];
    const log = this.deps.transcripts.get(sessionId).log;
    const texts = (this.queues.get(sessionId) ?? session.queue).map((q) => q.text);
    const handoff = session.handoff;
    if (handoff) {
      const recorded = durableInputs(turnLines(log, handoff.turnId).map(copyInput), handoff.inputs);
      for (const q of handoff.inputs.slice(recorded)) texts.push(q.text);
    }
    for (const entry of log) if (entry.kind === 'user' && entry.ts >= since) texts.push(entry.text);
    return texts;
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
      ...this.deps.summaryExtra?.(session),
    };
  }

  upsert(session: SessionRecord): void {
    this.deps.emit({ kind: 'session.upsert', session: this.summary(session) });
  }

  private canStart(session: SessionRecord): boolean {
    return this.deps.canStart ? this.deps.canStart(session) : true;
  }

  private emitSafe(ev: DaemonEvent): void {
    try {
      this.deps.emit(ev);
    } catch (err) {
      this.deps.log.error('turn.event-failed', err, { kind: ev.kind });
    }
  }

  /**
   * Boot reconciliation: a session whose turn was in flight when the daemon
   * stopped becomes `interrupted`, and its unfinished turn entry is closed
   * (unanswered questions marked dismissed, an error and a turn-end
   * appended) so replay renders a finished turn. The closed entry is
   * fsynced before the session record changes, and a session an earlier
   * boot already marked interrupted gets the same close if its entry is
   * still open. A session still `running` whose transcript already finished
   * is marked idle and is not resumed. Its turn count, last-turn tokens, and
   * last-active time come from the transcript header, and that turn's cost
   * is added only when the session's last-active time does not already match
   * the header, so a queue write that already stored the end snapshot is not
   * counted twice. A session an orderly shutdown left
   * `interrupted` stays interrupted so the next boot resumes it. Every turn
   * the event log started without ending gets a `turn.end`. Returns the
   * sessions that became interrupted.
   */
  reconcile(): SessionRecord[] {
    const touched: SessionRecord[] = [];
    const at = this.now();
    let dirty = false;
    for (const session of this.list()) {
      if (session.status !== 'running' && session.status !== 'interrupted') continue;
      if (this.needsRelease(session.id)) continue;
      const transcript = this.deps.transcripts.get(session.id);
      const last = [...transcript.log].reverse().find((e): e is TurnEntry => e.kind === 'turn');
      if (
        session.status === 'running' &&
        last &&
        finishedTurn(last.events) &&
        (!session.handoff || session.handoff.turnId === last.turnId)
      ) {
        const stats = finishedStats(last.events);
        if (session.lastActiveAt !== transcript.lastActiveAt && stats && typeof stats.costUsd === 'number') {
          session.costUsd += stats.costUsd;
        }
        session.turns = transcript.turns;
        session.lastTurnTokens = transcript.lastTurnTokens;
        session.lastActiveAt = transcript.lastActiveAt;
        session.status = 'idle';
        if (session.handoff) delete session.handoff;
        dirty = true;
        continue;
      }
      if (last && !last.events.some((e) => e.kind === 'turn-end')) {
        for (const e of last.events) if (e.kind === 'ask' && e.answers === undefined) e.answers = null;
        last.events.push({ kind: 'error', message: RESTART_ERROR, ts: at });
        last.events.push({ kind: 'turn-end', stats: ZERO_STATS, ts: at });
        try {
          this.deps.transcripts.commit(session.id);
        } catch (err) {
          // The session still becomes interrupted; the next boot closes the entry.
          this.deps.log.error('turn.reconcile-failed', err, { sessionId: session.id });
        }
      }
      if (session.status === 'running') {
        session.status = 'interrupted';
        touched.push(session);
        dirty = true;
      }
    }
    if (dirty) this.deps.sessions.save();
    this.restoreQueues();
    this.endOrphanTurns();
    return touched;
  }

  /** Publish a `turn.end` for every retained `turn.start` that has none. */
  private endOrphanTurns(): void {
    const open = new Map<string, { sessionId: string; turnId: string }>();
    for (const ev of this.deps.retained()) {
      if (ev.kind === 'turn.start') open.set(ev.turnId, { sessionId: ev.sessionId, turnId: ev.turnId });
      else if (ev.kind === 'turn.end') open.delete(ev.turnId);
    }
    const running = new Set([...this.active.values()].map((t) => t.turnId));
    for (const { sessionId, turnId } of open.values()) {
      if (running.has(turnId) || this.unsentEnds.has(turnId) || this.heldEnds.has(turnId)) continue;
      this.publishEnd({ kind: 'turn.end', sessionId, turnId, stats: this.statsFor(sessionId, turnId) });
    }
  }

  /** Stats of a clean transcript turn-end, or zeros when the turn did not finish. */
  private statsFor(sessionId: string, turnId: string): TurnStats {
    if (!this.get(sessionId)) return { ...ZERO_STATS };
    const log = this.deps.transcripts.get(sessionId).log;
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry.kind !== 'turn' || entry.turnId !== turnId) continue;
      return finishedStats(entry.events) ?? { ...ZERO_STATS };
    }
    return { ...ZERO_STATS };
  }

  /** Append a `turn.end`. One the event log refuses is kept and retried until it lands. */
  private publishEnd(ev: TurnEndEvent): void {
    this.unsentEnds.set(ev.turnId, ev);
    this.sendEnds(ev.sessionId);
  }

  /** Retry held `turn.end`s (one session's, or all). True when none of them is left. */
  private sendEnds(sessionId?: string): boolean {
    let left = false;
    for (const [turnId, ev] of [...this.unsentEnds]) {
      if (sessionId !== undefined && ev.sessionId !== sessionId) continue;
      try {
        this.deps.emit(ev);
        this.unsentEnds.delete(turnId);
      } catch (err) {
        left = true;
        this.deps.log.error('turn.end-unrecorded', err, { sessionId: ev.sessionId, turnId });
      }
    }
    this.armEndRetry();
    return !left;
  }

  private needsRelease(sessionId: string): boolean {
    for (const held of this.heldEnds.values()) if (held.ev.sessionId === sessionId && !held.released) return true;
    return false;
  }

  private shouldWake(session: SessionRecord): boolean {
    if ((this.queues.get(session.id)?.length ?? 0) > 0) return true;
    return session.kind === 'orchestrator' && this.deps.peekNotices().length > 0;
  }

  private releaseTurn(session: SessionRecord): Promise<boolean> {
    const existing = this.releasing.get(session.id);
    if (existing) return existing;
    let resolve: (ok: boolean) => void = () => undefined;
    const job = new Promise<boolean>((r) => {
      resolve = r;
    });
    this.releasing.set(session.id, job);
    void this.finishRelease(session).then(
      (ok) => {
        if (this.releasing.get(session.id) === job) this.releasing.delete(session.id);
        resolve(ok);
      },
      (err) => {
        if (this.releasing.get(session.id) === job) this.releasing.delete(session.id);
        this.deps.log.error('turn.end-failed', err, { sessionId: session.id });
        resolve(false);
      },
    );
    return job;
  }

  private async finishRelease(session: SessionRecord): Promise<boolean> {
    const held = [...this.heldEnds.values()].find((h) => h.ev.sessionId === session.id && !h.released);
    if (!held) return true;
    if (!held.landed) {
      try {
        this.deps.transcripts.commit(session.id);
        held.landed = true;
      } catch (err) {
        this.deps.log.error('turn.end-failed', err, { sessionId: session.id });
        return false;
      }
    }
    if (!held.finalized) {
      held.finalized = true;
      if (this.deps.onTurnEnd) {
        try {
          await this.deps.onTurnEnd(session, held.outcome);
        } catch (err) {
          this.deps.log.error('turn.end-hook-failed', err, { sessionId: session.id });
        }
      }
    }
    const previousStatus = session.status;
    const previousHandoff = session.handoff;
    if (session.status !== 'closed') session.status = held.status;
    delete session.handoff;
    try {
      this.deps.sessions.commit();
    } catch (err) {
      session.status = previousStatus;
      if (previousHandoff) session.handoff = previousHandoff;
      else delete session.handoff;
      this.deps.log.error('turn.end-failed', err, { sessionId: session.id });
      return false;
    }
    held.released = true;
    this.heldEnds.delete(held.ev.turnId);
    this.publishEnd(held.ev);
    return true;
  }

  private afterHeld(session: SessionRecord, ok: boolean): void {
    if (!ok || this.endHeld(session.id)) {
      this.blockedStarts.add(session.id);
      this.armEndRetry();
      return;
    }
    this.blockedStarts.delete(session.id);
    if (session.status === 'closed' || !this.accepting || this.active.has(session.id) || !this.canStart(session)) return;
    if (this.shouldWake(session) && this.startTurn(session) === null) {
      this.blockedStarts.add(session.id);
      this.armEndRetry();
    }
  }

  private async retryHeld(): Promise<void> {
    const ids = new Set<string>(this.blockedStarts);
    for (const held of this.heldEnds.values()) if (!held.released) ids.add(held.ev.sessionId);
    for (const sessionId of ids) {
      const session = this.get(sessionId);
      if (session && this.needsRelease(sessionId)) await this.releaseTurn(session);
    }
    this.sendEnds();
    for (const sessionId of [...this.blockedStarts]) {
      if (this.endHeld(sessionId)) continue;
      this.blockedStarts.delete(sessionId);
      const session = this.get(sessionId);
      if (!session || session.status === 'closed' || !this.accepting || this.active.has(sessionId) || !this.canStart(session)) continue;
      if (this.shouldWake(session) && this.startTurn(session) === null) this.blockedStarts.add(sessionId);
    }
    this.armEndRetry();
  }

  private armEndRetry(): void {
    if (this.unsentEnds.size === 0 && this.blockedStarts.size === 0 && this.heldEnds.size === 0) {
      if (this.endTimer) clearTimeout(this.endTimer);
      this.endTimer = null;
      return;
    }
    if (this.endTimer) return;
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      void this.retryHeld();
    }, this.deps.endRetryMs ?? END_RETRY_MS);
    this.endTimer.unref?.();
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
      const resumeText = this.deps.resumeText ? this.deps.resumeText(session) : RESUME_PROMPT;
      if (handoff && !handoff.handedOff) {
        if (handoff.inputs.length && !startsWithInputs(queue, handoff.inputs)) queue.unshift(...handoff.inputs.map(copyInput));
      } else if (resumeText !== null && !queue.some((item) => item.author === 'system' && item.text === resumeText)) {
        queue.unshift({ text: resumeText, author: 'system' });
      }
      delete session.handoff;
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
      if (session.status === 'closed' || this.active.has(session.id) || !this.canStart(session)) continue;
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
   * Queue an input. Starts a turn right away when the session is idle and
   * its previous end has been released, including `turn.end`; otherwise
   * the input waits.
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
    if (this.needsRelease(sessionId)) {
      this.blockedStarts.add(sessionId);
      void this.releaseTurn(session).then((ok) => this.afterHeld(session, ok));
      this.armEndRetry();
      this.upsert(session);
      return { queued: true };
    }
    if (this.endHeld(sessionId)) {
      this.blockedStarts.add(sessionId);
      this.armEndRetry();
      this.upsert(session);
      return { queued: true };
    }
    if (!this.canStart(session)) {
      this.upsert(session);
      return { queued: true };
    }
    const turnId = this.startTurn(session);
    if (turnId === null) {
      this.blockedStarts.add(sessionId);
      this.armEndRetry();
      this.upsert(session);
      return { queued: true };
    }
    return { queued: false, turnId };
  }

  private endHeld(sessionId: string): boolean {
    if (this.needsRelease(sessionId)) return true;
    for (const ev of this.unsentEnds.values()) if (ev.sessionId === sessionId) return true;
    return false;
  }

  /**
   * Start a turn on an idle session when it has input: queued text, or for
   * the orchestrator, pending notices alone. Returns the turn id, or null
   * when nothing started.
   */
  kick(sessionId: string): string | null {
    const session = this.get(sessionId);
    if (!session || session.status === 'closed' || !this.accepting) return null;
    if (this.active.has(sessionId) || !this.canStart(session)) return null;
    if (!this.shouldWake(session)) return null;
    return this.startTurn(session);
  }

  /** Inputs waiting behind (or instead of) a running turn. */
  queueLength(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  /** The last `last` transcript entries of a session. */
  transcriptPage(sessionId: string, last: number): TranscriptEntry[] {
    return this.deps.transcripts.get(sessionId).log.slice(-Math.max(1, last));
  }

  /** Drop every queued input of a session (a cancelled work item). */
  clearQueue(sessionId: string): void {
    const session = this.get(sessionId);
    if (!session) return;
    this.queues.set(sessionId, []);
    this.persistQueue(session);
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** The turn running on a session, if any. */
  activeTurnId(sessionId: string): string | null {
    return this.active.get(sessionId)?.turnId ?? null;
  }

  interrupt(sessionId: string, reason: InterruptReason = 'user'): boolean {
    const turn = this.active.get(sessionId);
    if (!turn) return false;
    turn.interrupted = true;
    turn.reason ??= reason;
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

  /** Interrupt every running turn for a shutdown or upgrade, and wait for all of them to end. */
  async interruptAll(): Promise<void> {
    for (const sessionId of [...this.active.keys()]) this.interrupt(sessionId, 'restart');
    await this.idle();
  }

  /** Resolves once no turn is running and no end release is in flight (queued inputs still start turns while accepting). */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.active.values()].map((t) => t.done);
      const settling = [...this.releasing.values()];
      if (pending.length === 0 && settling.length === 0) return;
      await Promise.allSettled([...pending, ...settling]);
    }
  }

  answer(
    sessionId: string,
    askId: string,
    answers: Record<string, string> | null,
    by: 'user' | 'orchestrator' = 'user',
  ): boolean {
    const ask = this.asks.get(askId);
    if (!ask || ask.sessionId !== sessionId) return false;
    this.closeAsk(askId, answers, by);
    return true;
  }

  /** Attach a note to an open question and emit it with the original questions. */
  annotateAsk(askId: string, note: string): void {
    const ask = this.asks.get(askId);
    const text = note.trim();
    if (!ask || !text) return;
    ask.note = text;
    const entry = this.deps.transcripts.turn(ask.sessionId, ask.turnId);
    if (entry) {
      for (const event of entry.events) {
        if (event.kind === 'ask' && event.askId === askId) event.note = text;
      }
      this.deps.transcripts.saveSoon(ask.sessionId);
    }
    this.emitSafe({
      kind: 'turn.event',
      sessionId: ask.sessionId,
      turnId: ask.turnId,
      event: { kind: 'ask', askId, questions: ask.questions, note: text, ts: this.now() },
    });
  }

  /** Hand an open question to someone else (the orchestrator escalating to the user). */
  routeAsk(askId: string, to: 'user' | 'orchestrator'): boolean {
    const ask = this.asks.get(askId);
    if (!ask) return false;
    if (ask.routedTo !== to) {
      ask.routedTo = to;
      this.emitSafe({ kind: 'ask.routed', sessionId: ask.sessionId, askId, to });
    }
    return true;
  }

  /** An open question's questions, or null once it closed. */
  openAsk(askId: string): { sessionId: string; questions: AskQuestion[]; routedTo: 'user' | 'orchestrator'; note?: string } | null {
    const ask = this.asks.get(askId);
    return ask ? { sessionId: ask.sessionId, questions: ask.questions, routedTo: ask.routedTo, ...(ask.note ? { note: ask.note } : {}) } : null;
  }

  /**
   * Close a question. An answer is recorded first (`onAskClosed` journals
   * it): if the journal refuses, the question stays open, nothing is
   * recorded or emitted, the worker keeps waiting, and the refusal is
   * thrown. A cancellation (the turn is ending) always closes.
   */
  private closeAsk(askId: string, answers: Record<string, string> | null, by: AskCloser): void {
    const ask = this.asks.get(askId);
    if (!ask) return;
    const session = this.get(ask.sessionId);
    let recorded = false;
    if (by !== 'cancelled' && session && this.deps.onAskClosed) {
      try {
        this.deps.onAskClosed(session, askId, by);
      } catch (err) {
        if (err instanceof JournalError) throw err;
        this.deps.log.error('ask.closed-failed', err, { sessionId: ask.sessionId });
      }
      recorded = true;
    }
    this.asks.delete(askId);
    const entry = this.deps.transcripts.turn(ask.sessionId, ask.turnId);
    if (entry && recordAskAnswer(entry, askId, answers)) this.deps.transcripts.saveSoon(ask.sessionId);
    this.emitSafe({ kind: 'ask.closed', sessionId: ask.sessionId, askId, answers, by });
    if (!recorded && session && this.deps.onAskClosed) {
      try {
        this.deps.onAskClosed(session, askId, by);
      } catch (err) {
        this.deps.log.error('ask.closed-failed', err, { sessionId: ask.sessionId });
      }
    }
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
      routedTo: a.routedTo,
      ...(a.note ? { note: a.note } : {}),
    }));
  }

  private startTurn(session: SessionRecord): string | null {
    const running = this.active.get(session.id);
    if (running) return running.turnId;
    if (this.needsRelease(session.id)) {
      void this.releaseTurn(session).then((ok) => this.afterHeld(session, ok));
      return null;
    }
    // The event log must close the previous turn before this one is allocated.
    // The inputs stay queued for a later start.
    if (!this.sendEnds(session.id)) {
      this.blockedStarts.add(session.id);
      this.armEndRetry();
      this.deps.log.error('turn.start-failed', undefined, { sessionId: session.id, reason: 'previous turn.end unrecorded' });
      return null;
    }
    const turnId = newId('trn', this.now());
    const turn: ActiveTurn = {
      turnId,
      startedAt: this.now(),
      started: false,
      interrupted: false,
      reason: null,
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
        const chain = turn.started && !!next?.length && this.accepting && session.status !== 'closed' && this.canStart(session);
        if (chain) {
          if (this.startTurn(session) !== null) return;
          this.blockedStarts.add(session.id);
          this.armEndRetry();
        }
        try {
          this.upsert(session);
        } catch (err) {
          this.deps.log.error('turn.event-failed', err, { sessionId: session.id });
        }
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
    const record: TurnEntry = { kind: 'turn', turnId: turn.turnId, ts: at, events: [] };
    let startWritten = false;
    const failStart = (err: unknown): void => {
      this.dropTurnEntry(session.id, turn.turnId);
      this.abortUnhanded(session, inputs);
      if (startWritten) this.publishEnd({ kind: 'turn.end', sessionId: session.id, turnId: turn.turnId, stats: { ...ZERO_STATS } });
      log.error('turn.start-failed', err, { sessionId: session.id });
    };
    try {
      this.recordDurable(session, inputs, notices, at);
      transcripts.append(session.id, record);
      this.upsert(session);
      emit({ kind: 'turn.start', sessionId: session.id, turnId: turn.turnId });
      startWritten = true;
      log.info('turn.start', {
        sessionId: session.id,
        turnId: turn.turnId,
        agent: session.agent,
        harness: session.harness,
        resume: !!session.resumeId,
      });
    } catch (err) {
      failStart(err);
      return;
    }

    let ended = false;
    let thinking = false;
    let lastError: string | null = null;
    let stats: TurnStats = { ...ZERO_STATS };
    const forward = (event: HarnessEvent): void => {
      const now = this.now();
      if (event.kind === 'thinking') thinking = event.active;
      if (event.kind === 'error') lastError = event.message;
      if (event.kind === 'turn-end') {
        if (ended) return; // one turn-end per turn, whatever the adapter does
        ended = true;
        stats = event.stats;
      }
      const stamped: HarnessEvent = event.kind === 'thinking' ? event : { ...event, ts: now };
      if (recordEvent(record, event, now)) transcripts.saveSoon(session.id);
      this.emitSafe({ kind: 'turn.event', sessionId: session.id, turnId: turn.turnId, event: stamped });
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
        if (i === 0) {
          this.markHandedOff(session);
          if (notices.length) this.deps.commitNotices(notices.length);
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
      if (!turn.started) failStart(err);
      else forward({ kind: 'error', message: errText(err) });
    } finally {
      if (turn.started) {
        this.cancelAsks(session.id);
        if (!ended) {
          if (thinking) forward({ kind: 'thinking', active: false });
          forward({ kind: 'turn-end', stats: { ...ZERO_STATS, durationMs: this.now() - turn.startedAt } });
        }
        const tokens = stats.inputTokens + stats.outputTokens;
        if (tokens > 0) session.lastTurnTokens = tokens;
        if (typeof stats.costUsd === 'number') session.costUsd += stats.costUsd;
        session.lastActiveAt = this.now();
        const t = transcripts.get(session.id);
        t.turns = session.turns;
        t.lastTurnTokens = session.lastTurnTokens;
        t.lastActiveAt = session.lastActiveAt;
        // Cut off by shutdown or upgrade: the next boot resumes it.
        const held: HeldEnd = {
          ev: { kind: 'turn.end', sessionId: session.id, turnId: turn.turnId, stats },
          status: turn.reason === 'restart' ? 'interrupted' : 'idle',
          outcome: {
            turnId: turn.turnId,
            error: turn.interrupted ? null : lastError,
            interrupted: turn.interrupted ? turn.reason ?? 'user' : null,
            entry: record,
            notices,
          },
          landed: false,
          finalized: false,
          released: false,
        };
        this.heldEnds.set(turn.turnId, held);
        try {
          transcripts.commit(session.id);
          held.landed = true;
        } catch (err) {
          log.error('turn.end-failed', err, { sessionId: session.id });
        }
        log.info('turn.end', {
          sessionId: session.id,
          turnId: turn.turnId,
          ms: this.now() - turn.startedAt,
          interrupted: turn.interrupted,
          inputTokens: stats.inputTokens,
          outputTokens: stats.outputTokens,
        });
        if (!held.landed) {
          this.blockedStarts.add(session.id);
          this.armEndRetry();
        } else {
          const released = await this.releaseTurn(session);
          if (!released) {
            this.blockedStarts.add(session.id);
            this.armEndRetry();
          }
        }
      }
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

  private dropTurnEntry(sessionId: string, turnId: string): void {
    const log = this.deps.transcripts.get(sessionId).log;
    for (let i = log.length - 1; i >= 0; i--) {
      const entry = log[i];
      if (entry.kind === 'turn' && entry.turnId === turnId) {
        log.splice(i, 1);
        try {
          this.deps.transcripts.commit(sessionId);
        } catch (err) {
          this.deps.log.error('turn.start-failed', err, { sessionId });
        }
        return;
      }
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

  /**
   * Record this turn's notice and user lines in the transcript before
   * publishing them. Lines a failed attempt left durable are reused, and
   * republished first when the event log does not hold them yet.
   */
  private recordDurable(session: SessionRecord, inputs: QueuedInput[], notices: Notice[], at: number): void {
    if (inputs.length === 0 && notices.length === 0) return;
    const { transcripts, emit } = this.deps;
    const log = transcripts.get(session.id).log;
    const tail = userTail(log);
    const durable = durableInputs(tail.map(copyInput), inputs);
    const missing = inputs.slice(durable);
    const recordedNotice = notices.length > 0 ? log.find((entry) => entry.kind === 'notice' && sameNotices(entry.notices, notices)) : undefined;
    const noticeMissing = notices.length > 0 && !recordedNotice;
    const reused: TranscriptEntry[] = tail.slice(tail.length - durable);
    if (recordedNotice) reused.push(recordedNotice);
    if (reused.length) this.republish(session.id, log, reused);
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
    for (let i = 0; i < added.length; i++) {
      const entry = added[i];
      try {
        if (entry.kind === 'notice') emit({ kind: 'turn.notice', sessionId: session.id, entry });
        else if (entry.kind === 'user') emit({ kind: 'turn.user', sessionId: session.id, entry });
      } catch (err) {
        const removed = log.splice(start + i);
        try {
          transcripts.commit(session.id);
        } catch (commitErr) {
          // The lines stay durable, so keep them in memory too; the next
          // delivery reuses them and publishes the ones the log lacks.
          log.push(...removed);
          this.deps.log.error('turn.start-failed', commitErr, { sessionId: session.id });
        }
        throw err;
      }
    }
  }

  /** Publish, in transcript order, each reused line the event log does not already hold. */
  private republish(sessionId: string, log: TranscriptEntry[], reused: TranscriptEntry[]): void {
    const unused = this.deps.retained().filter((ev) => 'sessionId' in ev && ev.sessionId === sessionId);
    const take = (entry: TranscriptEntry): boolean => {
      const index = unused.findIndex((ev) => {
        if (ev.kind === 'turn.user' && entry.kind === 'user') {
          return ev.entry.ts === entry.ts && ev.entry.text === entry.text && ev.entry.author === entry.author;
        }
        return ev.kind === 'turn.notice' && entry.kind === 'notice' && sameNotices(ev.entry.notices, entry.notices);
      });
      if (index < 0) return false;
      unused.splice(index, 1);
      return true;
    };
    for (const entry of log) {
      if (entry.kind !== 'user' && entry.kind !== 'notice') continue;
      const matched = take(entry);
      if (!reused.includes(entry) || matched) continue;
      if (entry.kind === 'notice') this.deps.emit({ kind: 'turn.notice', sessionId, entry });
      else this.deps.emit({ kind: 'turn.user', sessionId, entry });
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
      const routedTo = this.deps.routeAsk ? this.deps.routeAsk(session, askId, questions) : 'user';
      this.asks.set(askId, { sessionId: session.id, turnId: turn.turnId, questions, routedTo, resolve });
      forward({ kind: 'ask', askId, questions });
      this.emitSafe({ kind: 'ask.routed', sessionId: session.id, askId, to: routedTo });
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

/**
 * The user lines recorded for turn `turnId`: those just before its turn
 * entry (notices between are skipped), or, while it has no entry yet, the
 * lines after the last turn entry.
 */
function turnLines(log: TranscriptEntry[], turnId: string): UserEntry[] {
  const at = log.findIndex((entry) => entry.kind === 'turn' && entry.turnId === turnId);
  const lines: UserEntry[] = [];
  for (let i = (at < 0 ? log.length : at) - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind === 'notice') continue;
    if (entry.kind !== 'user') break;
    lines.unshift(entry);
  }
  return lines;
}

/** User lines of the in-flight turn. A finished turn ends the tail; a restart-closed one does not. */
function userTail(log: TranscriptEntry[]): UserEntry[] {
  const lines: UserEntry[] = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (entry.kind === 'notice') continue;
    if (entry.kind === 'turn') {
      if (sawProvider(entry.events) || finishedTurn(entry.events)) break;
      continue;
    }
    if (entry.kind !== 'user') break;
    lines.unshift(entry);
  }
  return lines;
}

function finishedTurn(events: TurnEntry['events']): boolean {
  return finishedStats(events) !== null;
}

function finishedStats(events: TurnEntry['events']): TurnStats | null {
  const ended = events.some((event) => event.kind === 'turn-end');
  const restarted = events.some((event) => event.kind === 'error' && event.message === RESTART_ERROR);
  if (!ended || restarted) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'turn-end') return { ...event.stats };
  }
  return null;
}

/** How many of `inputs`, from the front, the tail already records (as its last lines). */
function durableInputs(tail: QueuedInput[], inputs: QueuedInput[]): number {
  if (tail.length <= inputs.length && startsWithInputs(inputs, tail)) return tail.length;
  if (tail.length >= inputs.length && startsWithInputs(tail.slice(tail.length - inputs.length), inputs)) return inputs.length;
  return 0;
}

function sameNotices(recorded: Notice[], notices: Notice[]): boolean {
  return recorded.length === notices.length && recorded.every((notice, i) => notice.id === notices[i].id);
}
