/**
 * Work items: the backlog that stores them. The state machine they move
 * through is `src/harness/item-transitions.ts`, re-exported here.
 */

import type { DaemonEvent, IssueSource, ItemPosition, WorkItem } from '../harness/daemon-protocol';
import { ItemStateError, nextStatus, type ItemTrigger } from '../harness/item-transitions';
import { newId } from '../harness/ulid';
import type { JsonStore } from './store/store';
import type { ItemRecord, ItemsFile } from './store/items';

export {
  holdsSlot,
  ItemStateError,
  nextStatus,
  SLOT_STATUSES,
  TRANSITIONS,
  type ItemTrigger,
  type SlotEffect,
  type Transition,
} from '../harness/item-transitions';

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

  /** Items linked to a GitHub issue (`owner/name`, number), newest last. */
  byIssue(repo: string, number: number): ItemRecord[] {
    const key = repo.toLowerCase();
    return this.list()
      .filter((i) => i.source?.number === number && i.source.repo.toLowerCase() === key)
      .sort((a, b) => a.createdAt - b.createdAt);
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
    source?: IssueSource | null;
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
      source: init.source ?? null,
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
