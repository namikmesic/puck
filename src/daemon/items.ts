/**
 * Tickets: the backlog that holds them, in priority order. Reads come from
 * items.json (a checkpoint of the delivery journal); every change is an
 * event in a transaction (`src/daemon/workflow.ts`), journaled before it is
 * applied. The ticket table is `src/harness/item-transitions.ts`.
 */

import type { ItemPosition, Reference, WorkItem } from '../harness/daemon-protocol';
import { ItemStateError } from '../harness/item-transitions';
import { deliveryPull, sourceIssue } from '../harness/references';
import { newId } from '../harness/ulid';
import type { ItemRecord, ItemsFile } from './store/items';
import type { JsonStore } from './store/store';
import type { Tx } from './workflow';

export { ItemStateError, nextTicket, TICKET_TRANSITIONS, type TicketTrigger } from '../harness/item-transitions';

export function itemLabel(item: Pick<WorkItem, 'number'>): string {
  return `W-${item.number}`;
}

export interface BacklogDeps {
  store: JsonStore<ItemsFile>;
  now?: () => number;
}

/** The 0-based index an ItemPosition names in an order (without the ticket itself). */
export function positionIndex(order: readonly string[], itemId: string, position: ItemPosition): number {
  const rest = order.filter((id) => id !== itemId);
  if (position === 'top') return 0;
  if (position === 'bottom') return rest.length;
  const anchor = 'before' in position ? position.before : position.after;
  const index = rest.indexOf(anchor);
  if (index < 0 || anchor === itemId) throw new ItemStateError('The item to place it next to is not in the backlog.');
  return 'before' in position ? index : index + 1;
}

/** Tickets in priority order, persisted in items.json. */
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

  /** Tickets linked to a GitHub issue (`owner/name`, number), newest last. */
  byIssue(repo: string, number: number): ItemRecord[] {
    const key = repo.toLowerCase();
    return this.list()
      .filter((i) => {
        const src = sourceIssue(i);
        return src?.number === number && src.repo.toLowerCase() === key;
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** The ticket whose delivery pull request this is. */
  byPull(repo: string, number: number): ItemRecord | null {
    const key = repo.toLowerCase();
    return this.list().find((i) => {
      const pr = deliveryPull(i);
      return pr?.number === number && pr.repo.toLowerCase() === key;
    }) ?? null;
  }

  bySession(sessionId: string): ItemRecord | null {
    return this.list().find((i) => i.sessionId === sessionId) ?? null;
  }

  /** The 1-based position of an item in the order. */
  positionOf(itemId: string): number {
    return this.file.order.indexOf(itemId) + 1;
  }

  /* ---------- Changes, as events of a transaction ---------- */

  /** A new ticket in Todo; `ticket.created` carries everything needed to rebuild it. */
  create(
    tx: Tx,
    init: {
      title: string;
      body: string;
      agent: string | null;
      repo: string | null;
      createdBy: ItemRecord['createdBy'];
      position?: ItemPosition;
      references?: Reference[];
    },
  ): ItemRecord {
    const pos = init.position;
    if (pos && typeof pos === 'object' && !tx.item('before' in pos ? pos.before : pos.after)) {
      throw new ItemStateError('The item to place it next to is not in the backlog.');
    }
    const at = tx.at;
    const item: ItemRecord = {
      id: newId('itm', at),
      number: tx.nextNumber(),
      title: init.title,
      body: init.body,
      status: 'todo',
      stage: null,
      outcome: null,
      agent: init.agent,
      repo: init.repo,
      createdBy: init.createdBy,
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      attempts: 0,
      sessionId: null,
      branch: null,
      worktree: null,
      base: null,
      result: null,
      references: init.references ?? [],
      lastError: null,
      cancelReason: null,
      acceptNote: null,
      needsInput: null,
      oldestUserAsk: null,
      openAsks: 0,
      userAsks: 0,
      delivery: null,
      requeue: null,
      pushedSha: null,
      workflowId: null,
      asks: [],
      recordFormat: 2,
    };
    const order = tx.order();
    const position = init.position && init.position !== 'bottom' ? positionIndex([...order, item.id], item.id, init.position) : order.length;
    tx.push({ kind: 'ticket.created', item, position, nextNumber: item.number + 1 });
    return tx.item(item.id) as ItemRecord;
  }

  move(tx: Tx, item: ItemRecord, position: ItemPosition): void {
    tx.push({ kind: 'ticket.patch', itemId: item.id, change: {}, position: positionIndex(tx.order(), item.id, position) });
  }

  remove(tx: Tx, item: ItemRecord): void {
    tx.push({ kind: 'ticket.removed', itemId: item.id, number: item.number, title: item.title, status: item.status, outcome: item.outcome });
  }

  reference(tx: Tx, item: ItemRecord, op: 'add' | 'update' | 'remove', reference: Reference): void {
    tx.push({ kind: 'ticket.reference', itemId: item.id, op, reference });
  }

  nowMs(): number {
    return this.now();
  }
}
