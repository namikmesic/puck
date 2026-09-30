import { describe, expect, it, vi } from 'vitest';
import type { StepState } from '../../src/harness/daemon-protocol';
import { nullLogger } from '../../src/daemon/log';
import { capacityOf, pickDispatches, Scheduler, type SchedulerStep, type SchedulerView, type Timers } from '../../src/daemon/scheduler';

// The scheduler decides which steps run. Pin its order (verification first,
// then started tickets, then new ones, each in backlog order), its limits,
// that one busy agent never blocks another, and when it must do nothing at all.

type Item = SchedulerStep;
let order = 0;
const item = (id: string, agent: string | null, state: StepState = 'queued', over: Partial<SchedulerStep> = {}): Item => ({
  id,
  itemId: `itm_${id}`,
  kind: 'implement',
  state,
  agent,
  tier: 2,
  order: order++,
  ...over,
});

function view(steps: Item[], assignments: Record<string, number> = { impl: 1, rev: 1 }, maxWorkers = 8): SchedulerView {
  return { steps, assignments, maxWorkers };
}

describe('pickDispatches', () => {
  it('starts queued implement steps in backlog order, up to each agent’s maxParallel', () => {
    const v = view([item('a', 'impl'), item('b', 'impl'), item('c', 'impl')], { impl: 2 });
    expect(pickDispatches(v)).toEqual(['a', 'b']);
  });

  it('counts running and needs-input implement steps against the slots', () => {
    const v = view([item('r', 'impl', 'running'), item('n', 'impl', 'needs-input'), item('q', 'impl')], { impl: 2 });
    expect(pickDispatches(v)).toEqual([]);
    expect(capacityOf(v, false)).toEqual({ agents: { impl: { running: 2, max: 2 } }, workers: { running: 2, max: 8 }, paused: false, verifying: 0 });
  });

  it('never lets a busy agent block another agent further down', () => {
    const v = view([item('r', 'impl', 'running'), item('q1', 'impl'), item('q2', 'impl'), item('x', 'rev')]);
    expect(pickDispatches(v)).toEqual(['x']);
  });

  it('stops at maxWorkers across agents', () => {
    const v = view([item('a', 'impl'), item('b', 'rev'), item('c', 'third')], { impl: 5, rev: 5, third: 5 }, 2);
    expect(pickDispatches(v)).toEqual(['a', 'b']);
    const full = view([item('r', 'impl', 'running'), item('s', 'rev', 'needs-input'), item('c', 'third')], { impl: 5, rev: 5, third: 5 }, 2);
    expect(pickDispatches(full)).toEqual([]);
  });

  it('skips steps without an agent, for an unassigned agent, or not queued', () => {
    const v = view([item('a', null), item('b', 'gone'), item('c', 'impl', 'waiting'), item('d', 'impl', 'pending'), item('e', 'impl')]);
    expect(pickDispatches(v)).toEqual(['e']);
  });

  it('is deterministic: tier, then order, alone decide', () => {
    const z = item('z', 'impl', 'queued', { order: 1 });
    const a = item('a', 'impl', 'queued', { order: 2 });
    expect(pickDispatches(view([z, a]))).toEqual(['z']);
    expect(pickDispatches(view([a, z]))).toEqual(['z']);
  });

  it('starts a started ticket’s step (a fix round, a retry, a restart) before a new ticket’s', () => {
    const v = view([item('new', 'impl', 'queued', { tier: 2, order: 0 }), item('again', 'impl', 'queued', { tier: 1, order: 5 })]);
    expect(pickDispatches(v)).toEqual(['again']);
  });

  it('gives every freed slot to verification before any implement step', () => {
    const v = view(
      [item('impl1', 'impl', 'queued', { tier: 1, order: 0 }), item('rev1', 'rev', 'queued', { kind: 'review', tier: 0, order: 9 }), item('chk', null, 'queued', { kind: 'checks', tier: 0, order: 3 })],
      { impl: 5, rev: 5 },
      2,
    );
    expect(pickDispatches(v)).toEqual(['chk', 'rev1']);
  });

  it('counts a running checks step in the total only', () => {
    const v = view([item('chk', null, 'running', { kind: 'checks', tier: 0 }), item('r', 'rev', 'running', { kind: 'review', tier: 0 }), item('q', 'impl')], { impl: 1, rev: 1 }, 3);
    const cap = capacityOf(v, false);
    expect(cap.workers.running).toBe(2);
    expect(cap.verifying).toBe(2);
    expect(cap.agents.rev?.running).toBe(1);
    expect(pickDispatches(v)).toEqual(['q']);
  });
});

/** Timers the test fires by hand. */
function manualTimers() {
  let seq = 0;
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  const timers: Timers = {
    setTimeout: (fn) => {
      timeouts.set(++seq, fn);
      return seq;
    },
    clearTimeout: (h) => timeouts.delete(h as number),
    setInterval: (fn) => {
      intervals.set(++seq, fn);
      return seq;
    },
    clearInterval: (h) => intervals.delete(h as number),
  };
  const flush = (): void => {
    const due = [...timeouts.values()];
    timeouts.clear();
    due.forEach((fn) => fn());
  };
  return { timers, timeouts, intervals, flush };
}

describe('Scheduler', () => {
  function setup(items: Item[], opts: { ready?: boolean } = {}) {
    const t = manualTimers();
    const state = { ready: opts.ready ?? true, items };
    const dispatch = vi.fn((id: string) => {
      const it = state.items.find((i) => i.id === id);
      if (it) it.state = 'running';
    });
    const scheduler = new Scheduler({
      view: () => view(state.items),
      canRun: () => state.ready,
      start: dispatch,
      log: nullLogger,
      timers: t.timers,
    });
    return { scheduler, dispatch, state, ...t };
  }

  it('coalesces tick requests and dispatches through the pure pick', () => {
    const { scheduler, dispatch, timeouts, flush } = setup([item('a', 'impl'), item('b', 'rev')]);
    scheduler.request();
    scheduler.request();
    scheduler.request();
    expect(timeouts.size).toBe(1);
    flush();
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('does nothing while paused, and resume ticks', () => {
    const { scheduler, dispatch, flush } = setup([item('a', 'impl')]);
    scheduler.pause();
    expect(scheduler.tick()).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    scheduler.resume();
    flush();
    expect(dispatch).toHaveBeenCalledWith('a');
  });

  it('does nothing while the environment is not ready (or a reprovision waits)', () => {
    const { scheduler, dispatch, state } = setup([item('a', 'impl')], { ready: false });
    expect(scheduler.tick()).toEqual([]);
    state.ready = true;
    expect(scheduler.tick()).toEqual(['a']);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('runs a safety-net interval once started, and stop clears it', () => {
    const { scheduler, intervals, dispatch, state } = setup([]);
    scheduler.start();
    expect(intervals.size).toBe(1);
    state.items.push(item('late', 'impl'));
    [...intervals.values()][0]();
    expect(dispatch).toHaveBeenCalledWith('late');
    scheduler.stop();
    expect(intervals.size).toBe(0);
  });

  it('keeps going when one dispatch throws', () => {
    const t = manualTimers();
    const dispatch = vi.fn((id: string) => {
      if (id === 'a') throw new Error('boom');
    });
    const scheduler = new Scheduler({
      view: () => view([item('a', 'impl'), item('b', 'rev')]),
      canRun: () => true,
      start: dispatch,
      log: nullLogger,
      timers: t.timers,
    });
    expect(scheduler.tick()).toEqual(['b']);
  });
});
