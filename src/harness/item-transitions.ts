/**
 * The ticket state machine, shared by the daemon (which enforces it), the
 * board's menus (which offer only what it allows) and the renderer's dev
 * fixture (which mimics it). A ticket's status is Todo, In progress or
 * Done, and a Done ticket's `outcome` says how it ended. Its steps have
 * their own table in `src/harness/workflow.ts`; the daemon applies a
 * ticket's transition and every step change it causes in one journal
 * transaction.
 *
 * TICKET_TRANSITIONS is the complete set over (status, outcome). Anything
 * not in it is refused with `invalid-state`, whoever asks (a client, an
 * orchestrator tool, or the daemon itself), naming the status and outcome.
 *
 * Rows that are deliberate:
 *   - `start` is the scheduler's, when the ticket's first step starts.
 *   - `merged` takes In progress, and every Done outcome but `merged`, to
 *     Done (merged): a merged pull request is the work shipped, including
 *     after an accept, a failure or a cancellation.
 *   - `retry` takes a failed or cancelled ticket to In progress, or back to
 *     Todo when no implement step of it ever started.
 *   - Assigning, unassigning, planning and reordering change a Todo
 *     ticket's steps or order, never its status.
 */

import type { ItemOutcome, ItemStatus } from './daemon-protocol';

export type TicketTrigger = 'start' | 'accept' | 'cancel' | 'delete' | 'merged' | 'fail' | 'retry';

/** A ticket's place: its status, and its outcome once done. */
export interface TicketState {
  status: ItemStatus;
  outcome: ItemOutcome | null;
}

export interface TicketTransition {
  from: ItemStatus;
  /** For `done`: the outcomes the row applies to. */
  outcomes?: readonly ItemOutcome[];
  trigger: TicketTrigger;
  /** `retry` resolves to `todo` or `in-progress` by whether an implement step ever started. */
  to: TicketState | 'removed' | 'retry';
}

const DONE = (outcome: ItemOutcome): TicketState => ({ status: 'done', outcome });

export const TICKET_TRANSITIONS: readonly TicketTransition[] = [
  { from: 'todo', trigger: 'start', to: { status: 'in-progress', outcome: null } },
  { from: 'todo', trigger: 'accept', to: DONE('accepted') },
  { from: 'todo', trigger: 'cancel', to: DONE('cancelled') },
  { from: 'todo', trigger: 'delete', to: 'removed' },
  { from: 'in-progress', trigger: 'merged', to: DONE('merged') },
  { from: 'in-progress', trigger: 'accept', to: DONE('accepted') },
  { from: 'in-progress', trigger: 'fail', to: DONE('failed') },
  { from: 'in-progress', trigger: 'cancel', to: DONE('cancelled') },
  { from: 'done', outcomes: ['failed', 'cancelled'], trigger: 'retry', to: 'retry' },
  { from: 'done', outcomes: ['accepted', 'failed', 'cancelled'], trigger: 'merged', to: DONE('merged') },
  { from: 'done', outcomes: ['merged', 'accepted', 'failed', 'cancelled'], trigger: 'delete', to: 'removed' },
];

export class ItemStateError extends Error {
  readonly code = 'invalid-state';
}

const VERB: Record<TicketTrigger, string> = {
  start: 'start',
  accept: 'accept',
  cancel: 'cancel',
  delete: 'delete',
  merged: 'mark as merged',
  fail: 'fail',
  retry: 'retry',
};

/** "in Todo", "in progress", "done (merged)". */
export function ticketPhrase(state: TicketState): string {
  if (state.status === 'todo') return 'in Todo';
  if (state.status === 'in-progress') return 'in progress';
  return state.outcome ? `done (${state.outcome})` : 'done';
}

export function findTicketTransition(state: TicketState, trigger: TicketTrigger): TicketTransition | null {
  return (
    TICKET_TRANSITIONS.find(
      (t) => t.trigger === trigger && t.from === state.status && (!t.outcomes || (state.outcome !== null && t.outcomes.includes(state.outcome))),
    ) ?? null
  );
}

/**
 * Where a trigger takes a ticket, or an ItemStateError naming why not.
 * `started` (retry only): some implement step of the ticket has started.
 */
export function nextTicket(state: TicketState, trigger: TicketTrigger, started = false): TicketState | 'removed' {
  const row = findTicketTransition(state, trigger);
  if (!row) throw new ItemStateError(`Cannot ${VERB[trigger]} a ticket that is ${ticketPhrase(state)}.`);
  if (row.to === 'retry') return { status: started ? 'in-progress' : 'todo', outcome: null };
  return row.to;
}

/** True when the trigger is allowed from this state. */
export function allows(state: TicketState, trigger: TicketTrigger): boolean {
  return findTicketTransition(state, trigger) !== null;
}
