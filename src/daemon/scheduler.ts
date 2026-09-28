/**
 * The scheduler: starts queued work items in backlog order whenever the
 * assigned agent has a free slot.
 *
 * Selection is a pure function of the backlog: walk the order from the
 * top; a `queued` item starts when its agent's running count (items in
 * `running` or `needs-input`) is below the assignment's `maxParallel` and
 * the environment's total is below `maxWorkers`. Scanning continues past
 * an item that cannot start, so one busy agent never blocks another, and
 * because the order is total the choice is deterministic.
 *
 * Ticks are requested on every event that can free or create work (item
 * create, assign, move and retry; a released slot; a definition applied;
 * resume; the end of boot reconciliation) and coalesced; a 30 s interval
 * is the safety net. The scheduler does nothing while the environment is
 * not ready, while it is paused, or while a reprovision waits.
 */

import type { Capacity, ItemStatus } from '../harness/daemon-protocol';
import { holdsSlot } from './items';
import type { Logger } from './log';

export const SCHEDULER_INTERVAL_MS = 30_000;

export interface SchedulerView {
  /** Items in backlog order. */
  items: ReadonlyArray<{ id: string; status: ItemStatus; agent: string | null }>;
  /** Assigned agents and their maxParallel. */
  assignments: Readonly<Record<string, number>>;
  maxWorkers: number;
}

/** Running counts per assigned agent and in total (slot-holding items only). */
export function runningCounts(view: SchedulerView): { perAgent: Record<string, number>; total: number } {
  const perAgent: Record<string, number> = {};
  let total = 0;
  for (const item of view.items) {
    if (!holdsSlot(item.status)) continue;
    total += 1;
    if (item.agent) perAgent[item.agent] = (perAgent[item.agent] ?? 0) + 1;
  }
  return { perAgent, total };
}

/** The items to start now, in the order they start. */
export function pickDispatches(view: SchedulerView): string[] {
  const { perAgent, total } = runningCounts(view);
  let running = total;
  const picked: string[] = [];
  for (const item of view.items) {
    if (running >= view.maxWorkers) break;
    if (item.status !== 'queued' || !item.agent) continue;
    const max = view.assignments[item.agent];
    if (max === undefined) continue; // no longer assigned in this environment
    if ((perAgent[item.agent] ?? 0) >= max) continue;
    perAgent[item.agent] = (perAgent[item.agent] ?? 0) + 1;
    running += 1;
    picked.push(item.id);
  }
  return picked;
}

export function capacityOf(view: SchedulerView | null, paused: boolean): Capacity {
  const agents: Capacity['agents'] = {};
  if (!view) return { agents, workers: { running: 0, max: 0 }, paused };
  const { perAgent, total } = runningCounts(view);
  for (const [agent, max] of Object.entries(view.assignments)) agents[agent] = { running: perAgent[agent] ?? 0, max };
  return { agents, workers: { running: total, max: view.maxWorkers }, paused };
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface SchedulerDeps {
  /** The backlog and assignments now; null before a definition exists. */
  view(): SchedulerView | null;
  /** True while the environment is ready and no reprovision waits. */
  canRun(): boolean;
  /** Start one item. Must move it out of `queued` before returning. */
  dispatch(itemId: string): void;
  log: Logger;
  timers?: Timers;
  intervalMs?: number;
}

export class Scheduler {
  private paused = false;
  private pending: unknown = null;
  private interval: unknown = null;
  private readonly timers: Timers;

  constructor(private readonly deps: SchedulerDeps) {
    this.timers = deps.timers ?? realTimers;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Begin the safety-net interval and run a first tick. */
  start(): void {
    if (this.interval === null) {
      this.interval = this.timers.setInterval(() => this.tick(), this.deps.intervalMs ?? SCHEDULER_INTERVAL_MS);
    }
    this.request();
  }

  stop(): void {
    if (this.interval !== null) this.timers.clearInterval(this.interval);
    if (this.pending !== null) this.timers.clearTimeout(this.pending);
    this.interval = null;
    this.pending = null;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.request();
  }

  /** Ask for a tick soon; several requests in a row make one tick. */
  request(): void {
    if (this.pending !== null) return;
    this.pending = this.timers.setTimeout(() => {
      this.pending = null;
      this.tick();
    }, 0);
  }

  /** Start whatever can start now. Returns the items started. */
  tick(): string[] {
    if (this.paused || !this.deps.canRun()) return [];
    const view = this.deps.view();
    if (!view) return [];
    const started: string[] = [];
    for (const itemId of pickDispatches(view)) {
      try {
        this.deps.dispatch(itemId);
        started.push(itemId);
      } catch (err) {
        this.deps.log.error('scheduler.dispatch-failed', err, { itemId });
      }
    }
    return started;
  }
}
