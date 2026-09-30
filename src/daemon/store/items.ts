/**
 * items.json: the environment's tickets. `order` is the total priority
 * order the scheduler walks; `nextNumber` hands out the human W-<n> ids,
 * which are never reused. It is a checkpoint of the delivery journal
 * (src/daemon/delivery/journal.ts): `journalSeq` is the last journal line
 * it holds, and boot rolls it forward from there. Records hold no steps or
 * rounds; those live in delivery/tables.json.
 */

import * as path from 'node:path';
import type { ItemOutcome, ItemStatus, ItemStatusV1, Reference, StepKind, TicketAsk, WorkItem } from '../../harness/daemon-protocol';
import { JsonStore } from './store';

/**
 * Why a queued implement step that already has a worker session waits,
 * which decides what its next dispatch sends and whether it counts as an
 * attempt: error (counts, continue input), restart (does not count; work.ts
 * sends a continue, or the full worker prompt if that session never
 * received one), follow-up (a new request: input already queued), retry (a
 * fresh count).
 */
export type RequeueReason = 'error' | 'restart' | 'follow-up' | 'retry';

/** A ticket as the daemon stores it: the protocol shape without its workflow, plus daemon-only fields. */
export interface ItemRecord extends Omit<WorkItem, 'workflow'> {
  requeue: RequeueReason | null;
  /** The sha last pushed to GitHub, recorded even when opening the pull request then failed. */
  pushedSha: string | null;
  /** Protocol 1's status, kept by the format-2 migration as provenance. */
  legacyStatus?: ItemStatusV1;
  /** Its workflow in delivery/tables.json, once it has one. */
  workflowId: string | null;
  /** Every open ask, oldest first; `needsInput` and the ask counts derive from it. */
  asks: TicketAsk[];
  /** Marks a record in format 2, so a migration that ran twice leaves it alone. */
  recordFormat: 2;
}

export interface ItemsFile {
  nextNumber: number;
  order: string[];
  items: Record<string, ItemRecord>;
  /** The last journal line this checkpoint holds. */
  journalSeq: number;
}

const STATUSES: readonly ItemStatus[] = ['todo', 'in-progress', 'done'];
const OUTCOMES: readonly ItemOutcome[] = ['merged', 'accepted', 'failed', 'cancelled'];
const STAGES: readonly StepKind[] = ['decompose', 'implement', 'checks', 'review', 'publish', 'ci', 'merge'];
const REQUEUE: readonly RequeueReason[] = ['error', 'restart', 'follow-up', 'retry'];

function readAsks(raw: unknown): TicketAsk[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (a): a is TicketAsk => !!a && typeof a === 'object' && typeof (a as TicketAsk).askId === 'string' && ((a as TicketAsk).routedTo === 'user' || (a as TicketAsk).routedTo === 'orchestrator'),
  );
}

function readReferences(raw: unknown): Reference[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is Reference => !!r && typeof r === 'object' && typeof (r as Reference).id === 'string' && typeof (r as Reference).kind === 'string');
}

/** A format-2 record with `??` defaults for fields a newer daemon added. */
export function normalizeItem(id: string, raw: Partial<ItemRecord>): ItemRecord | null {
  if (typeof raw.title !== 'string' || typeof raw.number !== 'number') return null;
  const status = raw.status && STATUSES.includes(raw.status) ? raw.status : 'todo';
  const asks = readAsks(raw.asks);
  return {
    id,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    status,
    stage: status === 'in-progress' && raw.stage && STAGES.includes(raw.stage) ? raw.stage : null,
    outcome: status === 'done' ? (raw.outcome && OUTCOMES.includes(raw.outcome) ? raw.outcome : 'accepted') : null,
    agent: raw.agent ?? null,
    repo: raw.repo ?? null,
    createdBy: raw.createdBy === 'orchestrator' || raw.createdBy === 'pipeline' ? raw.createdBy : 'user',
    createdAt: raw.createdAt ?? 0,
    updatedAt: raw.updatedAt ?? 0,
    closedAt: status === 'done' ? (raw.closedAt ?? raw.updatedAt ?? 0) : null,
    attempts: raw.attempts ?? 0,
    sessionId: raw.sessionId ?? null,
    branch: raw.branch ?? null,
    worktree: raw.worktree ?? null,
    base: raw.base ?? null,
    result: raw.result ? { ...raw.result, head: typeof raw.result.head === 'string' ? raw.result.head : '' } : null,
    references: readReferences(raw.references),
    lastError: raw.lastError ?? null,
    cancelReason: typeof raw.cancelReason === 'string' ? raw.cancelReason : null,
    acceptNote: typeof raw.acceptNote === 'string' ? raw.acceptNote : null,
    needsInput: raw.needsInput ?? null,
    oldestUserAsk: raw.oldestUserAsk ?? null,
    openAsks: typeof raw.openAsks === 'number' ? raw.openAsks : asks.length,
    userAsks: typeof raw.userAsks === 'number' ? raw.userAsks : asks.filter((a) => a.routedTo === 'user').length,
    delivery: null,
    requeue: raw.requeue && REQUEUE.includes(raw.requeue) ? raw.requeue : null,
    pushedSha: typeof raw.pushedSha === 'string' ? raw.pushedSha : null,
    ...(raw.legacyStatus ? { legacyStatus: raw.legacyStatus } : {}),
    workflowId: typeof raw.workflowId === 'string' ? raw.workflowId : null,
    asks,
    recordFormat: 2,
  };
}

export function emptyItems(): ItemsFile {
  return { nextNumber: 1, order: [], items: Object.create(null) as Record<string, ItemRecord>, journalSeq: 0 };
}

function normalize(raw: unknown): ItemsFile {
  const file = raw && typeof raw === 'object' ? (raw as Partial<ItemsFile>) : {};
  const items: Record<string, ItemRecord> = Object.create(null) as Record<string, ItemRecord>;
  let maxNumber = 0;
  for (const [id, value] of Object.entries(file.items ?? {})) {
    if (!value || typeof value !== 'object') continue;
    const item = normalizeItem(id, value);
    if (!item) continue;
    items[id] = item;
    maxNumber = Math.max(maxNumber, item.number);
  }
  // The order holds every item exactly once; stragglers go to the bottom.
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of Array.isArray(file.order) ? file.order : []) {
    if (typeof id === 'string' && id in items && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const id of Object.keys(items)) if (!seen.has(id)) order.push(id);
  const next = typeof file.nextNumber === 'number' && Number.isInteger(file.nextNumber) ? file.nextNumber : 1;
  const journalSeq = typeof file.journalSeq === 'number' && Number.isInteger(file.journalSeq) && file.journalSeq >= 0 ? file.journalSeq : 0;
  return { nextNumber: Math.max(next, maxNumber + 1), order, items, journalSeq };
}

export function itemsStore(stateDir: string): JsonStore<ItemsFile> {
  return new JsonStore(path.join(stateDir, 'items.json'), emptyItems, normalize);
}
