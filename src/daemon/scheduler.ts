/**
 * The scheduler: starts queued steps whenever their agent has a free slot.
 *
 * Selection is a pure function of the steps that hold or want a slot
 * (implement, checks and review steps not done): the `queued` ones are
 * walked by `(tier, order)` — verification of work already done first
 * (tier 0: checks and reviews, by queue time), then implement steps of
 * tickets already in progress (tier 1: fix rounds, retries, restarts),
 * then those of Todo tickets (tier 2), each by backlog position. A step
 * starts when its agent's running count (steps for which `stepHoldsSlot`
 * is true) is below the assignment's `maxParallel` and the environment's
 * total is below `maxWorkers`. Scanning continues past a step that cannot
 * start, so one busy agent never blocks another, and because the order is
 * total the choice is deterministic.
 *
 * Ticks are requested on every event that can free or create work (item
 * create, assign, move and retry; a released slot; a definition applied;
 * resume; the end of boot reconciliation) and coalesced; a 30 s interval
 * is the safety net. The scheduler does nothing while the environment is
 * not ready, while it is paused, or while a reprovision waits.
 */

import type { Capacity, StepState } from '../harness/daemon-protocol';
import { stepHoldsSlot } from '../harness/workflow';
import type { Logger } from './log';

export const SCHEDULER_INTERVAL_MS = 30_000;

export interface SchedulerStep {
  id: string;
  itemId: string;
  kind: 'implement' | 'checks' | 'review';
  state: StepState;
  agent: string | null;
  /** 0: checks and review; 1: implement of an in-progress ticket; 2: implement of a todo ticket. */
  tier: 0 | 1 | 2;
  /** Tier 0: queuedAt; tiers 1 and 2: the ticket's backlog position. */
  order: number;
}

export interface SchedulerView {
  /** Steps that hold or want a slot: implement, checks and review steps not done. */
  steps: ReadonlyArray<SchedulerStep>;
  /** Assigned agents (workers and reviewers) and their maxParallel. */
  assignments: Readonly<Record<string, number>>;
  maxWorkers: number;
}

/** Running counts per agent and in total (slot-holding steps only; a checks step counts in the total only). */
export function runningCounts(view: SchedulerView): { perAgent: Record<string, number>; total: number; verifying: number } {
  const perAgent: Record<string, number> = {};
  let total = 0;
  let verifying = 0;
  for (const step of view.steps) {
    if (!stepHoldsSlot(step)) continue;
    total += 1;
    if (step.kind !== 'implement') verifying += 1;
    if (step.agent && step.kind !== 'checks') perAgent[step.agent] = (perAgent[step.agent] ?? 0) + 1;
  }
  return { perAgent, total, verifying };
}

/** The steps to start now, in the order they start. */
export function pickDispatches(view: SchedulerView): string[] {
  const { perAgent, total } = runningCounts(view);
  let running = total;
  const picked: string[] = [];
  const queued = view.steps.filter((s) => s.state === 'queued').sort((a, b) => a.tier - b.tier || a.order - b.order);
  for (const step of queued) {
    if (running >= view.maxWorkers) break;
    if (step.kind !== 'checks') {
      if (!step.agent) continue;
      const max = view.assignments[step.agent];
      if (max === undefined) continue; // no longer assigned in this environment
      if ((perAgent[step.agent] ?? 0) >= max) continue;
      perAgent[step.agent] = (perAgent[step.agent] ?? 0) + 1;
    }
    running += 1;
    picked.push(step.id);
  }
  return picked;
}

export function capacityOf(view: SchedulerView | null, paused: boolean): Capacity {
  const agents: Capacity['agents'] = {};
  if (!view) return { agents, workers: { running: 0, max: 0 }, paused, verifying: 0 };
  const { perAgent, total, verifying } = runningCounts(view);
  for (const [agent, max] of Object.entries(view.assignments)) agents[agent] = { running: perAgent[agent] ?? 0, max };
  return { agents, workers: { running: total, max: view.maxWorkers }, paused, verifying };
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
  /** The steps and assignments now; null before a definition exists. */
  view(): SchedulerView | null;
  /** True while the environment is ready and no reprovision waits. */
  canRun(): boolean;
  /** Start one step. Must move it out of `queued` before returning. */
  start(stepId: string): void;
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

  /** Start whatever can start now. Returns the steps started. */
  tick(): string[] {
    if (this.paused || !this.deps.canRun()) return [];
    const view = this.deps.view();
    if (!view) return [];
    const started: string[] = [];
    for (const stepId of pickDispatches(view)) {
      try {
        this.deps.start(stepId);
        started.push(stepId);
      } catch (err) {
        this.deps.log.error('scheduler.dispatch-failed', err, { stepId });
      }
    }
    return started;
  }
}
