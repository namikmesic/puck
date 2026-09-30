/**
 * Notices and the orchestrator's wake loop.
 *
 * Daemon events the orchestrator should hear about (an item finished,
 * failed, was requeued or asks a question, a pull request was published,
 * the environment restarted, a definition was applied, the user changed
 * the backlog) become notices in notices.json. The next orchestrator turn
 * carries every pending notice at the top of its prompt.
 *
 * Wake: a new notice that wakes (`Notice.wake`, true unless the notice says
 * otherwise) opens a 3 s batching window; when it closes and the
 * orchestrator is idle, the daemon starts a turn for the pending notices. A
 * running turn keeps them until it ends, then a new window opens. A notice
 * with `wake: false` opens no window: it rides along with the next turn,
 * however that turn starts.
 *
 * Runaway guard: notice-started turns are counted over a sliding hour. At
 * `maxAutoTurnsPerHour` auto-wake pauses (the session reports
 * `autoWakePaused`); notices keep accumulating and ride along with the
 * next user message, which resumes auto-wake with a fresh count. With
 * `autoWake: false` notices only ever ride along with user messages.
 */

import { wakes, type Notice, type NoticeKind } from '../harness/transcript';
import { newId } from '../harness/ulid';
import type { Logger } from './log';
import { realTimers, type Timers } from './scheduler';
import type { JsonStore } from './store/store';
import type { NoticesFile } from './store/notices';
import type { SessionRecord } from './store/sessions';

export const WAKE_BATCH_MS = 3_000;
export const RUNAWAY_WINDOW_MS = 60 * 60_000;

/** The slice of the turn loop the wake loop drives. */
export interface WakeTurns {
  orchestrator(): SessionRecord | null;
  isRunning(sessionId: string): boolean;
  kick(sessionId: string): string | null;
  upsert(session: SessionRecord): void;
}

export interface OrchestratorDeps {
  notices: JsonStore<NoticesFile>;
  turns: WakeTurns;
  /** The definition's wake settings; null before one exists. */
  settings(): { autoWake: boolean; maxAutoTurnsPerHour: number } | null;
  /** True while the environment is ready and taking input. */
  canWake(): boolean;
  log: Logger;
  now?: () => number;
  timers?: Timers;
}

export class Orchestrator {
  private timer: unknown = null;
  private paused = false;
  private autoTurns: number[] = [];
  private readonly now: () => number;
  private readonly timers: Timers;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
  }

  /* ---------- Notices ---------- */

  push(kind: NoticeKind, text: string, itemId?: string, opts: { wake?: boolean } = {}): Notice {
    const notice: Notice = {
      id: newId('ntc', this.now()),
      kind,
      at: this.now(),
      text,
      ...(itemId ? { itemId } : {}),
      ...(opts.wake === false ? { wake: false } : {}),
    };
    this.deps.notices.get().pending.push(notice);
    this.deps.notices.commit();
    this.deps.log.info('notice.push', { kind, itemId });
    this.schedule();
    return notice;
  }

  pending(): Notice[] {
    return this.deps.notices.get().pending.slice();
  }

  /** Drop the first `count` pending notices once a turn has recorded them. */
  commit(count: number): void {
    if (count <= 0) return;
    const pending = this.deps.notices.get().pending;
    const removed = pending.splice(0, count);
    try {
      this.deps.notices.commit();
    } catch (err) {
      pending.unshift(...removed);
      throw err;
    }
  }

  /* ---------- Wake ---------- */

  autoWakePaused(): boolean {
    return this.paused;
  }

  /** True when a pending notice wakes the orchestrator. */
  private waking(): boolean {
    return this.deps.notices.get().pending.some(wakes);
  }

  /** Open a batching window if a notice that wakes waits and auto-wake may run. */
  schedule(): void {
    const settings = this.deps.settings();
    if (!settings?.autoWake || this.paused || this.timer !== null) return;
    if (!this.waking()) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.fire();
    }, WAKE_BATCH_MS);
  }

  /** The window closed: start a notice turn unless a turn runs or the guard trips. */
  fire(): void {
    const settings = this.deps.settings();
    const session = this.deps.turns.orchestrator();
    if (!settings?.autoWake || this.paused || !session || !this.deps.canWake()) return;
    if (this.deps.turns.isRunning(session.id)) return; // its end reschedules
    if (!this.waking()) return;
    const now = this.now();
    this.autoTurns = this.autoTurns.filter((at) => now - at < RUNAWAY_WINDOW_MS);
    if (this.autoTurns.length >= settings.maxAutoTurnsPerHour) {
      this.paused = true;
      this.deps.log.warn('orchestrator.auto-wake-paused', { turns: this.autoTurns.length });
      this.deps.turns.upsert(session);
      return;
    }
    if (this.deps.turns.kick(session.id)) this.autoTurns.push(now);
  }

  /** An orchestrator turn ended: notices that arrived meanwhile get their window. */
  turnEnded(): void {
    this.schedule();
  }

  /** A user message resumes a paused auto-wake. */
  userMessage(): void {
    if (!this.paused) return;
    this.paused = false;
    this.autoTurns = [];
    const session = this.deps.turns.orchestrator();
    if (session) this.deps.turns.upsert(session);
  }

  stop(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}
