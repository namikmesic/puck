import { describe, expect, it } from 'vitest';
import type { ItemStatus } from '../../src/harness/daemon-protocol';
import { holdsSlot, ItemStateError, nextStatus, TRANSITIONS, type ItemTrigger } from '../../src/harness/item-transitions';

// The work-item state machine is the complete set of status changes: every
// row below is allowed, and every other (status, trigger) pair is refused
// with invalid-state, so the daemon can never drift into an undefined state.

const STATUSES: ItemStatus[] = ['backlog', 'queued', 'running', 'needs-input', 'review', 'done', 'failed', 'cancelled'];
const TRIGGERS: ItemTrigger[] = [
  'assign',
  'unassign',
  'dispatch',
  'ask',
  'answer',
  'finish',
  'interrupt',
  'error',
  'error-final',
  'restart',
  'cancel',
  'follow-up',
  'accept',
  'retry',
  'delete',
];

/** The transition table as written in the design: [from, trigger, to, slot]. */
const EXPECTED: Array<[ItemStatus, ItemTrigger, ItemStatus | 'removed', 'acquires' | 'keeps' | 'releases' | null]> = [
  ['backlog', 'assign', 'queued', null],
  ['queued', 'assign', 'queued', null],
  ['queued', 'unassign', 'backlog', null],
  ['queued', 'dispatch', 'running', 'acquires'],
  ['running', 'ask', 'needs-input', 'keeps'],
  ['needs-input', 'answer', 'running', 'keeps'],
  ['running', 'finish', 'review', 'releases'],
  ['running', 'interrupt', 'review', 'releases'],
  ['running', 'error', 'queued', 'releases'],
  ['running', 'error-final', 'failed', 'releases'],
  ['running', 'restart', 'queued', 'releases'],
  ['needs-input', 'restart', 'queued', 'releases'],
  ['running', 'cancel', 'cancelled', 'releases'],
  ['needs-input', 'cancel', 'cancelled', 'releases'],
  ['queued', 'cancel', 'cancelled', 'releases'],
  ['backlog', 'cancel', 'cancelled', 'releases'],
  ['review', 'cancel', 'cancelled', 'releases'],
  ['review', 'follow-up', 'queued', null],
  ['backlog', 'accept', 'done', null],
  ['review', 'accept', 'done', null],
  ['queued', 'accept', 'done', null],
  ['running', 'accept', 'done', 'releases'],
  ['needs-input', 'accept', 'done', 'releases'],
  ['failed', 'accept', 'done', null],
  ['cancelled', 'accept', 'done', null],
  ['failed', 'retry', 'queued', null],
  ['cancelled', 'retry', 'queued', null],
  ['backlog', 'delete', 'removed', null],
  ['done', 'delete', 'removed', null],
  ['failed', 'delete', 'removed', null],
  ['cancelled', 'delete', 'removed', null],
];

describe('work item state machine', () => {
  it('has exactly the designed transitions', () => {
    const table = TRANSITIONS.flatMap((t) => t.from.map((from) => [from, t.trigger, t.to]));
    expect(table.sort()).toEqual(EXPECTED.map(([from, trigger, to]) => [from, trigger, to]).sort());
  });

  it.each(EXPECTED)('%s --%s--> %s', (from, trigger, to, slot) => {
    expect(nextStatus(from, trigger)).toBe(to);
    const held = holdsSlot(from);
    const after = to === 'removed' ? false : holdsSlot(to);
    if (slot === 'acquires') expect([held, after]).toEqual([false, true]);
    if (slot === 'keeps') expect([held, after]).toEqual([true, true]);
    if (slot === 'releases' && held) expect(after).toBe(false);
    if (slot === null) expect(held || after).toBe(false);
  });

  const allowed = new Set(EXPECTED.map(([from, trigger]) => `${from}:${trigger}`));
  const forbidden = STATUSES.flatMap((s) => TRIGGERS.map((t) => [s, t] as const)).filter(([s, t]) => !allowed.has(`${s}:${t}`));

  it.each(forbidden)('refuses %s --%s', (from, trigger) => {
    expect(() => nextStatus(from, trigger)).toThrow(ItemStateError);
    try {
      nextStatus(from, trigger);
    } catch (err) {
      expect((err as ItemStateError).code).toBe('invalid-state');
    }
  });

  it('holds a slot only in running and needs-input', () => {
    expect(STATUSES.filter(holdsSlot)).toEqual(['running', 'needs-input']);
  });
});
