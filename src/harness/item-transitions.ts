/**
 * The work-item state machine, shared by the daemon (which enforces it) and
 * the renderer's dev fixture (which mimics it).
 *
 * TRANSITIONS is the complete set of status changes. Anything not in it is
 * refused with `invalid-state`, whoever asks (a client, an orchestrator
 * tool, or the daemon itself). Only `running` and `needs-input` hold one of
 * the assigned agent's slots.
 *
 * Rows that go beyond the plain lifecycle, and are deliberate:
 *   - `restart` also takes `needs-input` back to `queued`: the question
 *     died with the turn that asked it, and the resumed session asks again.
 *   - `assign` from `queued` to `queued` re-assigns a waiting item.
 *   - `accept` takes every status except `done` to `done`. A merged pull
 *     request is the work shipped, including after a follow-up, a failure
 *     or a cancellation. `running` and `needs-input` release their slot.
 */

import type { ItemStatus } from './daemon-protocol';

export type ItemTrigger =
  | 'assign'
  | 'unassign'
  | 'dispatch'
  | 'ask'
  | 'answer'
  | 'finish'
  | 'interrupt'
  | 'error'
  | 'error-final'
  | 'restart'
  | 'cancel'
  | 'follow-up'
  | 'accept'
  | 'retry'
  | 'delete';

export type SlotEffect = 'acquires' | 'keeps' | 'releases' | null;

export interface Transition {
  from: readonly ItemStatus[];
  trigger: ItemTrigger;
  to: ItemStatus | 'removed';
  slot: SlotEffect;
}

export const TRANSITIONS: readonly Transition[] = [
  { from: ['backlog'], trigger: 'assign', to: 'queued', slot: null },
  { from: ['queued'], trigger: 'assign', to: 'queued', slot: null },
  { from: ['queued'], trigger: 'unassign', to: 'backlog', slot: null },
  { from: ['queued'], trigger: 'dispatch', to: 'running', slot: 'acquires' },
  { from: ['running'], trigger: 'ask', to: 'needs-input', slot: 'keeps' },
  { from: ['needs-input'], trigger: 'answer', to: 'running', slot: 'keeps' },
  { from: ['running'], trigger: 'finish', to: 'review', slot: 'releases' },
  { from: ['running'], trigger: 'interrupt', to: 'review', slot: 'releases' },
  { from: ['running'], trigger: 'error', to: 'queued', slot: 'releases' },
  { from: ['running'], trigger: 'error-final', to: 'failed', slot: 'releases' },
  { from: ['running', 'needs-input'], trigger: 'restart', to: 'queued', slot: 'releases' },
  { from: ['running', 'needs-input', 'queued', 'backlog', 'review'], trigger: 'cancel', to: 'cancelled', slot: 'releases' },
  { from: ['review'], trigger: 'follow-up', to: 'queued', slot: null },
  { from: ['backlog', 'queued', 'review', 'failed', 'cancelled'], trigger: 'accept', to: 'done', slot: null },
  { from: ['running', 'needs-input'], trigger: 'accept', to: 'done', slot: 'releases' },
  { from: ['failed', 'cancelled'], trigger: 'retry', to: 'queued', slot: null },
  { from: ['backlog', 'done', 'failed', 'cancelled'], trigger: 'delete', to: 'removed', slot: null },
];

export const SLOT_STATUSES: readonly ItemStatus[] = ['running', 'needs-input'];

export function holdsSlot(status: ItemStatus): boolean {
  return SLOT_STATUSES.includes(status);
}

export class ItemStateError extends Error {
  readonly code = 'invalid-state';
}

const VERB: Record<ItemTrigger, string> = {
  assign: 'assign',
  unassign: 'unassign',
  dispatch: 'start',
  ask: 'pause for a question',
  answer: 'resume',
  finish: 'finish',
  interrupt: 'interrupt',
  error: 'requeue',
  'error-final': 'fail',
  restart: 'requeue',
  cancel: 'cancel',
  'follow-up': 'send a follow-up to',
  accept: 'accept',
  retry: 'retry',
  delete: 'delete',
};

/** The status a trigger leads to from `status`, or an ItemStateError naming why not. */
export function nextStatus(status: ItemStatus, trigger: ItemTrigger): ItemStatus | 'removed' {
  const row = TRANSITIONS.find((t) => t.trigger === trigger && t.from.includes(status));
  if (!row) throw new ItemStateError(`Cannot ${VERB[trigger]} an item that is ${status}.`);
  return row.to;
}
