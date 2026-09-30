import { describe, expect, it } from 'vitest';
import type { ItemOutcome } from '../../src/harness/daemon-protocol';
import { allows, ItemStateError, nextTicket, TICKET_TRANSITIONS, type TicketState, type TicketTrigger } from '../../src/harness/item-transitions';

// The ticket state machine is the complete set of (status, outcome) changes:
// every row below is allowed, and every other pair is refused with
// invalid-state, naming the ticket's status and outcome, so the daemon can
// never drift into an undefined state.

const OUTCOMES: ItemOutcome[] = ['merged', 'accepted', 'failed', 'cancelled'];
const STATES: TicketState[] = [
  { status: 'todo', outcome: null },
  { status: 'in-progress', outcome: null },
  ...OUTCOMES.map((outcome) => ({ status: 'done' as const, outcome })),
];
const TRIGGERS: TicketTrigger[] = ['start', 'accept', 'cancel', 'delete', 'merged', 'fail', 'retry'];

const key = (s: TicketState): string => (s.outcome ? `${s.status}(${s.outcome})` : s.status);
const done = (outcome: ItemOutcome): TicketState => ({ status: 'done', outcome });

/** The ticket table as the design writes it (4.3): [from, trigger, to]. Retry resolves by whether an implement step started. */
const EXPECTED: Array<[TicketState, TicketTrigger, TicketState | 'removed' | 'retry']> = [
  [{ status: 'todo', outcome: null }, 'start', { status: 'in-progress', outcome: null }],
  [{ status: 'todo', outcome: null }, 'accept', done('accepted')],
  [{ status: 'todo', outcome: null }, 'cancel', done('cancelled')],
  [{ status: 'todo', outcome: null }, 'delete', 'removed'],
  [{ status: 'in-progress', outcome: null }, 'merged', done('merged')],
  [{ status: 'in-progress', outcome: null }, 'accept', done('accepted')],
  [{ status: 'in-progress', outcome: null }, 'fail', done('failed')],
  [{ status: 'in-progress', outcome: null }, 'cancel', done('cancelled')],
  [done('failed'), 'retry', 'retry'],
  [done('cancelled'), 'retry', 'retry'],
  [done('accepted'), 'merged', done('merged')],
  [done('failed'), 'merged', done('merged')],
  [done('cancelled'), 'merged', done('merged')],
  [done('merged'), 'delete', 'removed'],
  [done('accepted'), 'delete', 'removed'],
  [done('failed'), 'delete', 'removed'],
  [done('cancelled'), 'delete', 'removed'],
];

describe('ticket state machine', () => {
  it('has exactly the designed transitions', () => {
    const table = TICKET_TRANSITIONS.flatMap((t) =>
      (t.from === 'done' ? (t.outcomes ?? OUTCOMES) : [null]).map((outcome) => [key({ status: t.from, outcome }), t.trigger, typeof t.to === 'string' ? t.to : key(t.to)]),
    );
    expect(table.sort()).toEqual(EXPECTED.map(([from, trigger, to]) => [key(from), trigger, typeof to === 'string' ? to : key(to)]).sort());
  });

  it.each(EXPECTED.map(([from, trigger, to]) => [key(from), trigger, typeof to === 'string' ? to : key(to), from, to] as const))('%s --%s--> %s', (_f, trigger, _t, from, to) => {
    if (to === 'retry') {
      expect(nextTicket(from, trigger, true)).toEqual({ status: 'in-progress', outcome: null });
      expect(nextTicket(from, trigger, false)).toEqual({ status: 'todo', outcome: null });
    } else expect(nextTicket(from, trigger)).toEqual(to);
    expect(allows(from, trigger)).toBe(true);
  });

  const allowed = new Set(EXPECTED.map(([from, trigger]) => `${key(from)}:${trigger}`));
  const forbidden = STATES.flatMap((s) => TRIGGERS.map((t) => [s, t] as const)).filter(([s, t]) => !allowed.has(`${key(s)}:${t}`));

  it.each(forbidden.map(([s, t]) => [key(s), t, s] as const))('%s refuses %s', (_k, trigger, state) => {
    expect(() => nextTicket(state, trigger)).toThrow(ItemStateError);
    expect(allows(state, trigger)).toBe(false);
    try {
      nextTicket(state, trigger);
    } catch (err) {
      expect((err as ItemStateError).code).toBe('invalid-state');
    }
  });

  it('names the status and outcome when it refuses', () => {
    expect(() => nextTicket(done('merged'), 'retry')).toThrow('Cannot retry a ticket that is done (merged).');
    expect(() => nextTicket({ status: 'in-progress', outcome: null }, 'delete')).toThrow('Cannot delete a ticket that is in progress.');
    expect(() => nextTicket({ status: 'todo', outcome: null }, 'fail')).toThrow('Cannot fail a ticket that is in Todo.');
  });
});
