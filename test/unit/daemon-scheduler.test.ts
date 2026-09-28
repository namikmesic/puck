import { describe, expect, it, vi } from 'vitest';
import type { ItemStatus } from '../../src/harness/daemon-protocol';
import { nullLogger } from '../../src/daemon/log';
import { capacityOf, pickDispatches, Scheduler, type SchedulerView, type Timers } from '../../src/daemon/scheduler';

// The scheduler decides who runs. Pin its order, its limits, that one busy
// agent never blocks another, and when it must do nothing at all.

type Item = { id: string; status: ItemStatus; agent: string | null };
const item = (id: string, agent: string | null, status: ItemStatus = 'queued'): Item => ({ id, status, agent });

function view(items: Item[], assignments: Record<string, number> = { impl: 1, rev: 1 }, maxWorkers = 8): SchedulerView {
  return { items, assignments, maxWorkers };
}

describe('pickDispatches', () => {
  it('starts queued items in backlog order, up to each agent’s maxParallel', () => {
    const v = view([item('a', 'impl'), item('b', 'impl'), item('c', 'impl')], { impl: 2 });
    expect(pickDispatches(v)).toEqual(['a', 'b']);
  });

  it('counts running and needs-input items against the slots', () => {
    const v = view([item('r', 'impl', 'running'), item('n', 'impl', 'needs-input'), item('q', 'impl')], { impl: 2 });
    expect(pickDispatches(v)).toEqual([]);
    expect(capacityOf(v, false)).toEqual({ agents: { impl: { running: 2, max: 2 } }, workers: { running: 2, max: 8 }, paused: false });
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

  it('skips items without an agent, for an unassigned agent, or not queued', () => {
    const v = view([item('a', null), item('b', 'gone'), item('c', 'impl', 'review'), item('d', 'impl', 'backlog'), item('e', 'impl')]);
    expect(pickDispatches(v)).toEqual(['e']);
  });

  it('is deterministic: the order alone decides', () => {
    const items = [item('z', 'impl'), item('a', 'impl')];
    expect(pickDispatches(view(items))).toEqual(['z']);
    expect(pickDispatches(view([...items].reverse()))).toEqual(['a']);
  });

  it('gives a follow-up its slot back when one is free', () => {
    // A reviewed item that got a follow-up is queued again; it competes like any other queued item.
    const v = view([item('done', 'impl', 'review'), item('followed-up', 'impl'), item('new', 'impl')]);
    expect(pickDispatches(v)).toEqual(['followed-up']);
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
      if (it) it.status = 'running';
    });
    const scheduler = new Scheduler({
      view: () => view(state.items),
      canRun: () => state.ready,
      dispatch,
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
      dispatch,
      log: nullLogger,
      timers: t.timers,
    });
    expect(scheduler.tick()).toEqual(['b']);
  });
});
