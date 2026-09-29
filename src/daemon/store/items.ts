/**
 * items.json: the environment's backlog. `order` is the total priority
 * order the scheduler walks; `nextNumber` hands out the human W-<n> ids,
 * which are never reused.
 */

import * as path from 'node:path';
import type { IssueSource, ItemStatus, WorkItem } from '../../harness/daemon-protocol';
import { JsonStore } from './store';

/**
 * Why a queued item that already has a worker session waits, which decides
 * what its next dispatch sends and whether it counts as an attempt:
 * error (counts, continue input), restart (does not count; work.ts sends
 * a continue, or the full worker prompt if that session never received one),
 * follow-up (a new request: input already queued), retry (a fresh count).
 */
export type RequeueReason = 'error' | 'restart' | 'follow-up' | 'retry';

/** A work item as the daemon stores it: the protocol shape plus daemon-only fields. */
export interface ItemRecord extends WorkItem {
  requeue: RequeueReason | null;
  /** The sha last pushed to GitHub, recorded even when opening the pull request then failed. */
  pushedSha: string | null;
}

export interface ItemsFile {
  nextNumber: number;
  order: string[];
  items: Record<string, ItemRecord>;
}

const STATUSES: readonly ItemStatus[] = ['backlog', 'queued', 'running', 'needs-input', 'review', 'done', 'failed', 'cancelled'];
const REQUEUE: readonly RequeueReason[] = ['error', 'restart', 'follow-up', 'retry'];

function readSource(raw: unknown): IssueSource | null {
  const s = raw as Partial<IssueSource> | null | undefined;
  if (!s || s.kind !== 'github-issue' || typeof s.repo !== 'string' || typeof s.number !== 'number') return null;
  return { kind: 'github-issue', repo: s.repo, number: s.number, url: typeof s.url === 'string' ? s.url : '', updatedAt: s.updatedAt ?? 0 };
}

function normalizeItem(id: string, raw: Partial<ItemRecord>): ItemRecord | null {
  if (typeof raw.title !== 'string' || typeof raw.number !== 'number') return null;
  return {
    id,
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    status: raw.status && STATUSES.includes(raw.status) ? raw.status : 'backlog',
    agent: raw.agent ?? null,
    repo: raw.repo ?? null,
    createdBy: raw.createdBy === 'orchestrator' ? 'orchestrator' : 'user',
    createdAt: raw.createdAt ?? 0,
    updatedAt: raw.updatedAt ?? 0,
    attempts: raw.attempts ?? 0,
    sessionId: raw.sessionId ?? null,
    branch: raw.branch ?? null,
    worktree: raw.worktree ?? null,
    base: raw.base ?? null,
    result: raw.result ?? null,
    pr: raw.pr ?? null,
    source: readSource(raw.source),
    lastError: raw.lastError ?? null,
    cancelReason: typeof raw.cancelReason === 'string' ? raw.cancelReason : null,
    acceptNote: typeof raw.acceptNote === 'string' ? raw.acceptNote : null,
    pendingAsk: raw.pendingAsk ?? null,
    requeue: raw.requeue && REQUEUE.includes(raw.requeue) ? raw.requeue : null,
    pushedSha: typeof raw.pushedSha === 'string' ? raw.pushedSha : null,
  };
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
  return { nextNumber: Math.max(next, maxNumber + 1), order, items };
}

export function itemsStore(stateDir: string): JsonStore<ItemsFile> {
  return new JsonStore(
    path.join(stateDir, 'items.json'),
    () => ({ nextNumber: 1, order: [], items: Object.create(null) as Record<string, ItemRecord> }),
    normalize,
  );
}
