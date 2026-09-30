/**
 * The one reducer from journal events to state. The live stores, a
 * transaction's working copy and boot's roll-forward all apply events
 * through these functions, so a rebuild cannot differ from what ran.
 * Events set fields to values, so applying a transaction twice is
 * harmless. Time comes from the journal line (`at`), never the clock.
 *
 * items.json is changed by the `ticket.*` events only; delivery/tables.json
 * by every kind that concerns workflows, ticket facts or merges.
 */

import type {
  Gate,
  ImplementPurpose,
  ItemOutcome,
  ItemStatus,
  MergeObserved,
  Reference,
  Step,
  StepState,
} from '../../harness/daemon-protocol';
import type { TicketState, TicketTrigger } from '../../harness/item-transitions';
import { workflowIdOf } from '../../harness/workflow';
import type { ItemRecord, ItemsFile } from '../store/items';
import { mergeKey, type TablesFile, type WorkflowRecord } from '../store/delivery';
import type { JournalEvent, Transaction } from './journal';

/** Who acted, as the journal records it. */
export interface JournalActor {
  kind: 'agent' | 'orchestrator' | 'user' | 'pipeline';
  agent: string | null;
  sessionId: string | null;
  reviewId: string | null;
}

export const PIPELINE: JournalActor = { kind: 'pipeline', agent: null, sessionId: null, reviewId: null };

export function actor(kind: JournalActor['kind'], agent: string | null = null, sessionId: string | null = null): JournalActor {
  return { kind, agent, sessionId, reviewId: null };
}

/** Field changes of a ticket record; identity and number never change. */
export type TicketChange = Partial<Omit<ItemRecord, 'id' | 'number'>>;

export type LedgerEvent =
  | { kind: 'ticket.created'; item: ItemRecord; position: number; nextNumber: number; legacy?: true }
  | {
      kind: 'ticket.status';
      itemId: string;
      number: number;
      title: string;
      agent: string | null;
      from: TicketState;
      to: TicketState;
      closedAt: number | null;
      trigger: TicketTrigger;
      change: TicketChange;
      by: JournalActor;
      reason: string | null;
      legacy?: true;
    }
  | { kind: 'ticket.patch'; itemId: string; change: TicketChange; position?: number }
  | { kind: 'ticket.removed'; itemId: string; number: number; title: string; status: ItemStatus; outcome: ItemOutcome | null }
  | { kind: 'ticket.reference'; itemId: string; op: 'add' | 'update' | 'remove'; reference: Reference }
  | { kind: 'step.changed'; itemId: string; step: Step; from: StepState | null; trigger: string }
  | { kind: 'round.opened'; itemId: string; roundId: string; round: number; purpose: ImplementPurpose; reason: string }
  | { kind: 'round.settled'; itemId: string; roundId: string; round: number; gate: Gate; outcome: 'settled' | 'superseded' | 'cancelled'; obligations: string[] }
  | {
      kind: 'step.input';
      itemId: string;
      stepId: string;
      sessionId: string;
      author: 'system' | 'user' | 'orchestrator';
      text: string;
      attachment: { path: string; bytes: number; sha256: string } | null;
    }
  | ({ kind: 'merge.observed' } & MergeObserved)
  | { kind: 'journal.bootstrap'; format: 2; tickets: number };

export type LedgerKind = LedgerEvent['kind'];

/** Kinds kept in the journal only: clients get item.upsert, item.removed and backlog.order projected from them. */
export const JOURNAL_ONLY: ReadonlySet<LedgerKind> = new Set<LedgerKind>(['ticket.created', 'ticket.status', 'ticket.patch', 'step.input', 'journal.bootstrap']);

export function asLedgerEvents(tx: Transaction): LedgerEvent[] {
  return tx.events as unknown as LedgerEvent[];
}

export function asJournalEvents(events: readonly LedgerEvent[]): JournalEvent[] {
  return events as unknown as JournalEvent[];
}

/** What applying events to items.json changed. */
export interface ItemsDelta {
  changed: Set<string>;
  removed: Set<string>;
  order: boolean;
}

export function emptyDelta(): ItemsDelta {
  return { changed: new Set(), removed: new Set(), order: false };
}

function place(order: string[], itemId: string, position: number): string[] {
  const next = order.filter((id) => id !== itemId);
  next.splice(Math.max(0, Math.min(position, next.length)), 0, itemId);
  return next;
}

function assignRecord(rec: ItemRecord, change: TicketChange): void {
  Object.assign(rec, change);
}

/** Apply one event to items.json, in place (live records keep their identity). */
export function applyItemEvent(file: ItemsFile, ev: LedgerEvent, at: number, delta: ItemsDelta): void {
  switch (ev.kind) {
    case 'ticket.created': {
      const existing = file.items[ev.item.id];
      if (existing) assignRecord(existing, structuredClone(ev.item));
      else file.items[ev.item.id] = structuredClone(ev.item);
      const before = file.order.indexOf(ev.item.id);
      file.order = place(file.order, ev.item.id, ev.position);
      if (before !== file.order.indexOf(ev.item.id)) delta.order = true;
      file.nextNumber = Math.max(file.nextNumber, ev.nextNumber);
      delta.changed.add(ev.item.id);
      delta.removed.delete(ev.item.id);
      return;
    }
    case 'ticket.status': {
      const rec = file.items[ev.itemId];
      if (!rec) return;
      assignRecord(rec, structuredClone(ev.change));
      rec.status = ev.to.status;
      rec.outcome = ev.to.outcome;
      rec.closedAt = ev.closedAt;
      if (!ev.legacy) rec.updatedAt = at;
      delta.changed.add(ev.itemId);
      return;
    }
    case 'ticket.patch': {
      const rec = file.items[ev.itemId];
      if (!rec) return;
      assignRecord(rec, structuredClone(ev.change));
      if (Object.keys(ev.change).length) rec.updatedAt = at;
      if (ev.position !== undefined) {
        file.order = place(file.order, ev.itemId, ev.position);
        delta.order = true;
      }
      delta.changed.add(ev.itemId);
      return;
    }
    case 'ticket.reference': {
      const rec = file.items[ev.itemId];
      if (!rec) return;
      const ref = structuredClone(ev.reference);
      const index = rec.references.findIndex((r) => r.id === ref.id);
      if (ev.op === 'remove') rec.references = rec.references.filter((r) => r.id !== ref.id);
      else if (index >= 0) rec.references = rec.references.map((r, i) => (i === index ? ref : r));
      else rec.references = [...rec.references, ref];
      rec.updatedAt = at;
      delta.changed.add(ev.itemId);
      return;
    }
    case 'ticket.removed': {
      if (!file.items[ev.itemId]) return;
      delete file.items[ev.itemId];
      file.order = file.order.filter((id) => id !== ev.itemId);
      delta.changed.delete(ev.itemId);
      delta.removed.add(ev.itemId);
      delta.order = true;
      return;
    }
    default:
      return;
  }
}

function workflowFor(tables: TablesFile, itemId: string): WorkflowRecord {
  let wf = tables.workflows[itemId];
  if (!wf) {
    wf = { id: workflowIdOf(itemId), itemId, rounds: [], steps: [], roundsAllowed: 0, extensions: [] };
    tables.workflows[itemId] = wf;
  }
  return wf;
}

/** Apply one event to delivery/tables.json, in place. */
export function applyTableEvent(tables: TablesFile, ev: LedgerEvent, at: number): void {
  switch (ev.kind) {
    case 'ticket.created': {
      const i = ev.item;
      tables.tickets[i.id] = {
        itemId: i.id,
        number: i.number,
        title: i.title,
        agent: i.agent,
        createdBy: i.createdBy,
        createdAt: i.createdAt,
        closedAt: i.closedAt,
        outcome: i.outcome,
        removed: false,
      };
      return;
    }
    case 'ticket.status': {
      const facts = tables.tickets[ev.itemId];
      if (!facts) return;
      facts.title = ev.title;
      facts.agent = ev.agent;
      facts.outcome = ev.to.outcome;
      facts.closedAt = ev.closedAt;
      return;
    }
    case 'ticket.patch': {
      const facts = tables.tickets[ev.itemId];
      if (!facts) return;
      if (typeof ev.change.title === 'string') facts.title = ev.change.title;
      if (ev.change.agent !== undefined) facts.agent = ev.change.agent;
      return;
    }
    case 'ticket.removed': {
      const facts = tables.tickets[ev.itemId];
      if (facts) facts.removed = true;
      return;
    }
    case 'round.opened': {
      const wf = workflowFor(tables, ev.itemId);
      if (wf.rounds.some((r) => r.roundId === ev.roundId)) return;
      wf.rounds.push({
        round: ev.round,
        roundId: ev.roundId,
        purpose: ev.purpose,
        headSha: null,
        gate: 'pending',
        settledGate: null,
        outcome: 'open',
        startedAt: at,
        settledAt: null,
      });
      return;
    }
    case 'round.settled': {
      const round = tables.workflows[ev.itemId]?.rounds.find((r) => r.roundId === ev.roundId);
      if (!round) return;
      round.gate = ev.gate;
      round.settledGate ??= ev.gate;
      round.outcome = ev.outcome;
      round.settledAt ??= at;
      return;
    }
    case 'step.changed': {
      const wf = workflowFor(tables, ev.itemId);
      const index = wf.steps.findIndex((s) => s.id === ev.step.id);
      const step = structuredClone(ev.step);
      if (index >= 0) wf.steps[index] = step;
      else wf.steps.push(step);
      return;
    }
    case 'merge.observed': {
      const { kind: _kind, ...row } = ev;
      void _kind;
      const key = mergeKey(ev.repo, ev.prNumber);
      if (!tables.merges[key]) tables.merges[key] = { ...structuredClone(row), at };
      return;
    }
    case 'journal.bootstrap':
      tables.bootstrap ??= { format: ev.format, tickets: ev.tickets, at };
      return;
    default:
      return;
  }
}

/** Apply a committed transaction to items.json. */
export function applyItems(file: ItemsFile, tx: Transaction, delta: ItemsDelta = emptyDelta()): ItemsDelta {
  for (const ev of asLedgerEvents(tx)) applyItemEvent(file, ev, tx.at, delta);
  file.journalSeq = Math.max(file.journalSeq, tx.last);
  return delta;
}

/** Apply a committed transaction to delivery/tables.json. */
export function applyTables(tables: TablesFile, tx: Transaction): void {
  for (const ev of asLedgerEvents(tx)) applyTableEvent(tables, ev, tx.at);
  tables.journalSeq = Math.max(tables.journalSeq, tx.last);
}

/** Boot: roll both checkpoints forward over every transaction they do not hold yet. */
export function rollForward(items: ItemsFile, tables: TablesFile, transactions: readonly Transaction[]): { items: number; tables: number } {
  let appliedItems = 0;
  let appliedTables = 0;
  for (const tx of transactions) {
    if (tx.last > items.journalSeq) {
      applyItems(items, tx);
      appliedItems += 1;
    }
    if (tx.last > tables.journalSeq) {
      applyTables(tables, tx);
      appliedTables += 1;
    }
  }
  return { items: appliedItems, tables: appliedTables };
}
