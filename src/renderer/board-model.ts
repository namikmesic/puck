/**
 * The board's model, pure: which column each item status lands in, how
 * each column orders its cards, which actions a card's menu offers, and
 * which drags are allowed.
 *
 * - Columns follow the item state machine: Backlog (backlog), Ready
 *   (queued), In progress (running and needs-input, the questions first),
 *   Review, Done, and Closed (failed and cancelled). Nothing is filtered
 *   out: every status has a column.
 * - Card actions are the ones the daemon's state machine allows from the
 *   status (a unit test holds this table to its transitions). Delete, and
 *   cancelling work that has started, arm on first click. A queued item
 *   that already has a session is not offered Unassign, and an assign
 *   picker offers only that session's agent.
 * - Drags only where a transition or a reorder exists: within Backlog or
 *   Ready (reorder), Backlog → Ready (assign), Ready → Backlog (unassign,
 *   only when the item has no session yet).
 */

import type { Capacity, ItemStatus, WorkItem } from '../harness/daemon-protocol';
import { ordinal } from './format';

export type ColumnId = 'backlog' | 'ready' | 'progress' | 'review' | 'done' | 'closed';

export interface Column {
  id: ColumnId;
  title: string;
  /** What lands here, for an empty column. */
  hint: string;
}

export const COLUMNS: readonly Column[] = [
  { id: 'backlog', title: 'Backlog', hint: 'New and imported items wait here until an agent is assigned.' },
  { id: 'ready', title: 'Ready', hint: 'Assigned items queue here until their agent has a free slot.' },
  { id: 'progress', title: 'In progress', hint: 'Agents pick up ready items and work them here.' },
  { id: 'review', title: 'Review', hint: 'Finished work waits here for you to accept or publish.' },
  { id: 'done', title: 'Done', hint: 'Accepted and merged work.' },
  { id: 'closed', title: 'Closed', hint: 'Failed and cancelled items. Retry one to queue it again.' },
];

const COLUMN_OF: Record<ItemStatus, ColumnId> = {
  backlog: 'backlog',
  queued: 'ready',
  running: 'progress',
  'needs-input': 'progress',
  review: 'review',
  done: 'done',
  failed: 'closed',
  cancelled: 'closed',
};

export function columnOf(status: ItemStatus): ColumnId {
  return COLUMN_OF[status];
}

/**
 * A column's cards. `items` come in backlog order; Backlog and Ready keep
 * it (it is the dispatch order), In progress puts questions first and then
 * the longest running, and the rest show the latest change first.
 */
export function columnItems(items: readonly WorkItem[], column: ColumnId, startedAt: (item: WorkItem) => number = (i) => i.updatedAt): WorkItem[] {
  const mine = items.filter((i) => COLUMN_OF[i.status] === column);
  if (column === 'backlog' || column === 'ready') return mine;
  if (column === 'progress') {
    const rank = (i: WorkItem): number => (i.status === 'needs-input' ? (i.pendingAsk?.routedTo === 'user' ? 0 : 1) : 2);
    return mine.sort((a, b) => rank(a) - rank(b) || startedAt(a) - startedAt(b));
  }
  return mine.sort((a, b) => b.updatedAt - a.updatedAt);
}

export type CardAction = 'assign' | 'unassign' | 'stop' | 'accept' | 'publish' | 'retry' | 'cancel' | 'delete';

/** The "…" menu per status, in menu order (Assign expands to one entry per agent). */
export const CARD_ACTIONS: Record<ItemStatus, readonly CardAction[]> = {
  backlog: ['assign', 'cancel', 'delete'],
  queued: ['assign', 'unassign', 'cancel'],
  running: ['stop', 'cancel'],
  'needs-input': ['cancel'],
  review: ['accept', 'publish', 'cancel'],
  done: ['delete'],
  failed: ['retry', 'delete'],
  cancelled: ['retry', 'delete'],
};

/** Actions that ask for a second click: deleting, and cancelling work an agent started. */
export function armsFirst(action: CardAction, status: ItemStatus): boolean {
  if (action === 'delete') return true;
  return action === 'cancel' && (status === 'running' || status === 'needs-input' || status === 'review');
}

/**
 * The agents an item can be assigned to. An item with a session keeps that
 * agent (`sessionAgent` when the item's own agent was cleared): a queued
 * one is already on it, and a backlog one, or a queued one that lost its
 * agent, can only be assigned back to it.
 */
export function assignable(item: Pick<WorkItem, 'status' | 'agent' | 'sessionId'>, agents: readonly string[], sessionAgent: string | null = null): string[] {
  if (item.status !== 'backlog' && item.status !== 'queued') return [];
  if (item.sessionId) {
    if (item.status === 'queued' && item.agent) return [];
    const agent = item.agent ?? sessionAgent;
    if (!agent) return [];
    return agents.filter((a) => a === agent);
  }
  return agents.filter((a) => !(item.status === 'queued' && a === item.agent));
}

/** Ready → Backlog. A queued item that already has a session is not offered this. */
export function canUnassign(item: Pick<WorkItem, 'status' | 'sessionId'>): boolean {
  return item.status === 'queued' && !item.sessionId;
}

export type DropAction = 'reorder' | 'assign' | 'unassign';

export function canDrag(status: ItemStatus): boolean {
  return status === 'backlog' || status === 'queued';
}

/** What dropping an item on a column does, or null when no transition allows it. */
export function dropAction(status: ItemStatus, target: ColumnId, sessionId: string | null = null): DropAction | null {
  const from = COLUMN_OF[status];
  if (!canDrag(status)) return null;
  if (from === target) return 'reorder';
  if (from === 'backlog' && target === 'ready') return 'assign';
  if (from === 'ready' && target === 'backlog' && canUnassign({ status, sessionId })) return 'unassign';
  return null;
}

/** "Next for implementer", "3rd for implementer", or "Waiting for an agent" when unassigned. */
export function queueLine(item: WorkItem, all: readonly WorkItem[]): string {
  if (!item.agent) return 'Waiting for an agent';
  const line = all.filter((i) => i.status === 'queued' && i.agent === item.agent);
  const at = line.findIndex((i) => i.id === item.id) + 1;
  return at <= 1 ? `Next for ${item.agent}` : `${ordinal(at)} for ${item.agent}`;
}

/** Each agent's slots, alphabetically: the board header's capacity pips. */
export function capacitySlots(cap: Capacity): { agent: string; running: number; max: number }[] {
  return Object.entries(cap.agents)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, c]) => ({ agent, running: c.running, max: c.max }));
}

/** "implementer 2 of 2 · reviewer 0 of 1 · 2 of 3 workers busy", for the capacity tooltip. */
export function capacityText(cap: Capacity): string {
  const agents = capacitySlots(cap).map((c) => `${c.agent} ${c.running} of ${c.max}`);
  return [...agents, `${cap.workers.running} of ${cap.workers.max} workers busy`].join(' · ');
}

export function diffText(item: WorkItem): string {
  const d = item.result?.diffStat;
  return d ? `+${d.insertions} −${d.deletions}` : '';
}

/** `owner/name#12`, `owner/name 12`, or a github.com issue URL. */
export function parseIssueRef(text: string): { repo: string; number: number } | null {
  const t = text.trim();
  const url = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/issues\/(\d{1,9})(?:[/?#].*)?$/.exec(t);
  if (url) return { repo: url[1] as string, number: Number(url[2]) };
  const short = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\s*#\s*(\d{1,9})$/.exec(t);
  if (short) return { repo: short[1] as string, number: Number(short[2]) };
  return null;
}

/** The live-work summary in the chat header: "1 needs input · 2 running · 3 in review". */
export function liveWork(items: readonly WorkItem[]): { text: string; needs: number; running: number; review: number } {
  const needs = items.filter((i) => i.status === 'needs-input' && i.pendingAsk?.routedTo === 'user').length;
  const waiting = items.filter((i) => i.status === 'needs-input' && i.pendingAsk?.routedTo !== 'user').length;
  const running = items.filter((i) => i.status === 'running').length + waiting;
  const review = items.filter((i) => i.status === 'review').length;
  const parts: string[] = [];
  if (needs) parts.push(`${needs} need${needs === 1 ? 's' : ''} input`);
  if (running) parts.push(`${running} running`);
  if (review) parts.push(`${review} in review`);
  return { text: parts.join(' · '), needs, running, review };
}
