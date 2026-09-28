/**
 * Work items: the state machine and the backlog that stores them.
 *
 * TRANSITIONS is the complete set of status changes. Anything not in it is
 * refused with `invalid-state`, whoever asks (a client, an orchestrator
 * tool, or the daemon itself). Only `running` and `needs-input` hold one of
 * the assigned agent's slots.
 *
 * Two rows go beyond the plain lifecycle and are deliberate:
 *   - `restart` also takes `needs-input` back to `queued`: the question
 *     died with the turn that asked it, and the resumed session asks again.
 *   - `assign` from `queued` to `queued` re-assigns a waiting item.
 */

import type { DaemonEvent, ItemPosition, ItemStatus, WorkItem } from '../harness/daemon-protocol';
import { newId } from '../harness/ulid';
import type { JsonStore } from './store/store';
import type { ItemRecord, ItemsFile } from './store/items';

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
  { from: ['review'], trigger: 'accept', to: 'done', slot: null },
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

export function itemLabel(item: Pick<WorkItem, 'number'>): string {
  return `W-${item.number}`;
}

/** The client-facing shape (daemon-only fields dropped). */
export function publicItem(item: ItemRecord): WorkItem {
  const { requeue: _requeue, pushedSha: _pushed, ...rest } = item;
  void _requeue;
  void _pushed;
  return { ...rest };
}

export interface BacklogDeps {
  store: JsonStore<ItemsFile>;
  emit(ev: DaemonEvent): void;
  now?: () => number;
}

/** Items in priority order, persisted in items.json, with every change emitted. */
export class Backlog {
  private readonly now: () => number;

  constructor(private readonly deps: BacklogDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get file(): ItemsFile {
    return this.deps.store.get();
  }

  list(): ItemRecord[] {
    return this.file.order.map((id) => this.file.items[id]).filter(Boolean);
  }

  order(): string[] {
    return this.file.order.slice();
  }

  get(itemId: string): ItemRecord | null {
    return Object.prototype.hasOwnProperty.call(this.file.items, itemId) ? this.file.items[itemId] : null;
  }

  /** Accepts an item id (`itm_…`) or its human id (`W-12`, `12`). */
  find(ref: string): ItemRecord | null {
    const m = /^(?:W-)?(\d{1,9})$/i.exec(ref.trim());
    if (m) return this.list().find((i) => i.number === Number(m[1])) ?? null;
    return this.get(ref.trim());
  }

  bySession(sessionId: string): ItemRecord | null {
    return this.list().find((i) => i.sessionId === sessionId) ?? null;
  }

  create(init: {
    title: string;
    body: string;
    agent: string | null;
    repo: string | null;
    createdBy: 'user' | 'orchestrator';
    position?: ItemPosition;
  }): ItemRecord {
    const pos = init.position;
    if (pos && typeof pos === 'object' && !this.get('before' in pos ? pos.before : pos.after)) {
      throw new ItemStateError('The item to place it next to is not in the backlog.');
    }
    const at = this.now();
    const item: ItemRecord = {
      id: newId('itm', at),
      number: this.file.nextNumber,
      title: init.title,
      body: init.body,
      status: init.agent ? 'queued' : 'backlog',
      agent: init.agent,
      repo: init.repo,
      createdBy: init.createdBy,
      createdAt: at,
      updatedAt: at,
      attempts: 0,
      sessionId: null,
      branch: null,
      worktree: null,
      base: null,
      result: null,
      pr: null,
      lastError: null,
      cancelReason: null,
      acceptNote: null,
      pendingAsk: null,
      requeue: null,
      pushedSha: null,
    };
    this.file.nextNumber += 1;
    this.file.items[item.id] = item;
    this.file.order.push(item.id);
    if (init.position && init.position !== 'bottom') this.place(item.id, init.position);
    this.deps.store.commit();
    this.upsert(item);
    this.emitOrder();
    return item;
  }

  /** Mutate an item (not its status) and persist. No-op when the id is already gone. */
  patch(item: ItemRecord, change: Partial<Omit<ItemRecord, 'id' | 'number' | 'status'>>): ItemRecord {
    if (!this.get(item.id)) return item;
    Object.assign(item, change, { updatedAt: this.now() });
    this.deps.store.commit();
    this.upsert(item);
    return item;
  }

  /**
   * Apply a trigger through the state machine (throws ItemStateError when it
   * is not allowed), with any field changes in the same write.
   */
  transition(item: ItemRecord, trigger: ItemTrigger, change: Partial<Omit<ItemRecord, 'id' | 'number' | 'status'>> = {}): ItemRecord {
    const to = nextStatus(item.status, trigger);
    if (to === 'removed') {
      this.remove(item);
      return item;
    }
    Object.assign(item, change, { status: to, updatedAt: this.now() });
    this.deps.store.commit();
    this.upsert(item);
    return item;
  }

  private remove(item: ItemRecord): void {
    delete this.file.items[item.id];
    this.file.order = this.file.order.filter((id) => id !== item.id);
    this.deps.store.commit();
    this.deps.emit({ kind: 'item.removed', itemId: item.id });
    this.emitOrder();
  }

  move(item: ItemRecord, position: ItemPosition): string[] {
    this.place(item.id, position);
    this.deps.store.commit();
    this.emitOrder();
    return this.order();
  }

  /** The 1-based position of an item in the order. */
  positionOf(itemId: string): number {
    return this.file.order.indexOf(itemId) + 1;
  }

  private place(itemId: string, position: ItemPosition): void {
    const order = this.file.order.filter((id) => id !== itemId);
    let at: number;
    if (position === 'top') at = 0;
    else if (position === 'bottom') at = order.length;
    else {
      const anchor = 'before' in position ? position.before : position.after;
      const index = order.indexOf(anchor);
      if (index < 0 || anchor === itemId) throw new ItemStateError('The item to place it next to is not in the backlog.');
      at = 'before' in position ? index : index + 1;
    }
    order.splice(at, 0, itemId);
    this.file.order = order;
  }

  private upsert(item: ItemRecord): void {
    this.deps.emit({ kind: 'item.upsert', item: publicItem(item) });
  }

  private emitOrder(): void {
    this.deps.emit({ kind: 'backlog.order', order: this.order() });
  }
}
