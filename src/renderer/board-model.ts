/**
 * The board's model, pure: which column each ticket lands in, how each
 * column orders its cards, the Done filter, which actions a card's menu
 * offers, what a card's stage line says, and which drags are allowed.
 *
 * - Three columns follow the ticket's status: Todo, In progress and Done
 *   (`docs/delivery-workflow-spec.md`, 9.1). Every step of the work (the
 *   implement step, a fix round, the wait to accept or merge) happens inside
 *   In progress; failed and cancelled tickets are Done, behind the filter.
 * - The Done filter: Delivered (merged and accepted, the default), Failed,
 *   Cancelled, All, each with its count.
 * - Card actions (`cardActions`) are a function of the ticket's status,
 *   outcome and current steps, held to the ticket and step tables by a
 *   unit test. Delete, cancelling a started ticket, and merging arm on the
 *   first click.
 * - Drag only reorders within Todo: the scheduler moves a ticket to In
 *   progress, and its workflow moves it to Done.
 */

import type { Capacity, ItemOutcome, ItemStatus, StepSummary, WorkItem } from '../harness/daemon-protocol';
import { allows } from '../harness/item-transitions';
import { ordinal } from './format';

export type ColumnId = 'todo' | 'progress' | 'done';

export interface Column {
  id: ColumnId;
  title: string;
  /** What lands here, for an empty column. */
  hint: string;
}

/** What the board, the sheet and Chat say against a daemon that predates protocol 2: tickets are read-only (12.3). */
export const LEGACY_READ_ONLY = "This environment's daemon predates the three-column board. Update it to work here.";

export const COLUMNS: readonly Column[] = [
  { id: 'todo', title: 'Todo', hint: 'New and imported tickets wait here. Assign an agent, or let the orchestrator plan them.' },
  { id: 'progress', title: 'In progress', hint: 'Agents work, checks run and reviewers review here: one card per ticket, every step inside it.' },
  { id: 'done', title: 'Done', hint: 'Merged and accepted tickets. Failed and cancelled ones are behind the filter.' },
];

const COLUMN_OF: Record<ItemStatus, ColumnId> = {
  todo: 'todo',
  'in-progress': 'progress',
  done: 'done',
};

export function columnOf(status: ItemStatus): ColumnId {
  return COLUMN_OF[status];
}

export type DoneFilter = 'delivered' | 'failed' | 'cancelled' | 'all';

export const DONE_FILTERS: readonly { id: DoneFilter; label: string }[] = [
  { id: 'delivered', label: 'Delivered' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
];

const FILTER_OUTCOMES: Record<Exclude<DoneFilter, 'all'>, readonly ItemOutcome[]> = {
  delivered: ['merged', 'accepted'],
  failed: ['failed'],
  cancelled: ['cancelled'],
};

export function doneMatches(item: Pick<WorkItem, 'status' | 'outcome'>, filter: DoneFilter): boolean {
  if (item.status !== 'done') return false;
  return filter === 'all' || (item.outcome !== null && FILTER_OUTCOMES[filter].includes(item.outcome));
}

/** The Done filter's counts. */
export function doneCounts(items: readonly WorkItem[]): Record<DoneFilter, number> {
  const done = items.filter((i) => i.status === 'done');
  return {
    delivered: done.filter((i) => doneMatches(i, 'delivered')).length,
    failed: done.filter((i) => i.outcome === 'failed').length,
    cancelled: done.filter((i) => i.outcome === 'cancelled').length,
    all: done.length,
  };
}

/** The empty Done column's text when the filter hides everything. */
export function doneEmptyText(filter: DoneFilter, counts: Record<DoneFilter, number>): string | null {
  if (counts[filter] > 0) return null;
  if (filter === 'delivered' && counts.failed > 0) {
    return `No delivered tickets yet. ${counts.failed} failed ${counts.failed === 1 ? 'is' : 'are'} behind the filter.`;
  }
  if (filter === 'delivered' && counts.all > 0) return 'No delivered tickets yet. The rest are behind the filter.';
  return null;
}

const FILTER_KEY = 'puck.board.done.';

/** The Done filter an environment showed last (a per-viewer convenience). */
export function readDoneFilter(storage: Pick<Storage, 'getItem'> | null | undefined, envId: string | null): DoneFilter {
  try {
    const v = storage?.getItem(FILTER_KEY + (envId ?? ''));
    return v === 'failed' || v === 'cancelled' || v === 'all' ? v : 'delivered';
  } catch {
    return 'delivered';
  }
}

export function saveDoneFilter(storage: Pick<Storage, 'setItem'> | null | undefined, envId: string | null, filter: DoneFilter): void {
  try {
    storage?.setItem(FILTER_KEY + (envId ?? ''), filter);
  } catch {
    /* a convenience */
  }
}

/** The ticket's implement step that is not done, if its current round has one. */
export function activeImplement(item: Pick<WorkItem, 'workflow'>): StepSummary | null {
  return item.workflow?.steps.find((s) => s.kind === 'implement' && s.state !== 'done') ?? null;
}

/** True while the ticket's worker runs (or waits on its own question). */
export function isRunning(item: Pick<WorkItem, 'workflow'>): boolean {
  const step = activeImplement(item);
  return step?.state === 'running' || step?.state === 'needs-input';
}

/** The ticket waits for a person: a user-routed ask is open. */
export function needsYou(item: Pick<WorkItem, 'userAsks'>): boolean {
  return item.userAsks > 0;
}

/**
 * A column's cards. `items` come in backlog order; Todo keeps it (it is
 * the dispatch order). In progress puts tickets with a user-routed ask
 * first (the oldest ask first), then those waiting only on the
 * orchestrator, then running work by start time, then work waiting on
 * GitHub or on you. Done shows the newest `closedAt` first, through the
 * filter.
 */
export function columnItems(
  items: readonly WorkItem[],
  column: ColumnId,
  startedAt: (item: WorkItem) => number = (i) => i.updatedAt,
  filter: DoneFilter = 'all',
): WorkItem[] {
  const mine = items.filter((i) => COLUMN_OF[i.status] === column);
  if (column === 'todo') return mine;
  if (column === 'done') return mine.filter((i) => doneMatches(i, filter)).sort((a, b) => (b.closedAt ?? b.updatedAt) - (a.closedAt ?? a.updatedAt));
  const rank = (i: WorkItem): number => (i.userAsks > 0 ? 0 : i.openAsks > 0 ? 1 : isRunning(i) ? 2 : 3);
  const tie = (i: WorkItem): number => (i.userAsks > 0 ? (i.oldestUserAsk?.since ?? 0) : i.openAsks > 0 ? (i.needsInput?.since ?? 0) : startedAt(i));
  return mine.sort((a, b) => rank(a) - rank(b) || tie(a) - tie(b));
}

export type CardAction = 'assign' | 'stop' | 'publish' | 'accept' | 'retry' | 'cancel' | 'delete';

/**
 * The "…" menu of a ticket, in menu order (Assign expands to one entry per
 * agent): a function of its status, outcome and current steps.
 *   Todo: Assign, Cancel, Delete.
 *   In progress: Stop (its worker runs), Publish (its worker finished),
 *   Accept, Cancel.
 *   Done: Retry (failed, cancelled), Delete.
 */
export function cardActions(item: Pick<WorkItem, 'status' | 'outcome' | 'workflow'>): CardAction[] {
  const state = { status: item.status, outcome: item.outcome };
  const out: CardAction[] = [];
  if (item.status === 'todo') out.push('assign');
  if (item.status === 'in-progress') {
    const step = activeImplement(item);
    if (step?.state === 'running') out.push('stop');
    if (!step) out.push('publish');
  }
  if (allows(state, 'accept') && item.status === 'in-progress') out.push('accept');
  if (allows(state, 'retry')) out.push('retry');
  if (allows(state, 'cancel')) out.push('cancel');
  if (allows(state, 'delete')) out.push('delete');
  return out;
}

/** Actions that ask for a second click: deleting, and cancelling a ticket that started. */
export function armsFirst(action: CardAction, item: Pick<WorkItem, 'status'>): boolean {
  if (action === 'delete') return true;
  return action === 'cancel' && item.status === 'in-progress';
}

/**
 * The agents a Todo ticket can be assigned to. A ticket with a session
 * keeps that agent (`sessionAgent` when the ticket's own agent was
 * cleared): it can only be assigned back to it.
 */
export function assignable(item: Pick<WorkItem, 'status' | 'agent' | 'sessionId'>, agents: readonly string[], sessionAgent: string | null = null): string[] {
  if (item.status !== 'todo') return [];
  if (item.sessionId) {
    if (item.agent) return [];
    const agent = sessionAgent;
    if (!agent) return [];
    return agents.filter((a) => a === agent);
  }
  return agents.filter((a) => a !== item.agent);
}

/** A Todo ticket with an agent and no session yet can go back to unassigned. */
export function canUnassign(item: Pick<WorkItem, 'status' | 'sessionId' | 'agent'>): boolean {
  return item.status === 'todo' && !!item.agent && !item.sessionId;
}

export type DropAction = 'reorder';

export function canDrag(status: ItemStatus): boolean {
  return status === 'todo';
}

/** What dropping a ticket on a column does, or null: only reordering within Todo. */
export function dropAction(status: ItemStatus, target: ColumnId): DropAction | null {
  return canDrag(status) && target === 'todo' ? 'reorder' : null;
}

/** Whether the ticket's implement step waits for a slot. */
function queued(item: WorkItem): boolean {
  return activeImplement(item)?.state === 'queued';
}

/**
 * "Next for implementer", "3rd for implementer", or "Waiting for an agent"
 * when unassigned. The line is the scheduler's: tickets already in
 * progress go before Todo ones, each in backlog order.
 */
export function queueLine(item: WorkItem, all: readonly WorkItem[]): string {
  if (!item.agent) return 'Waiting for an agent';
  const line = all
    .map((i, index) => ({ i, index }))
    .filter(({ i }) => queued(i) && i.agent === item.agent)
    .sort((a, b) => (a.i.status === 'in-progress' ? 0 : 1) - (b.i.status === 'in-progress' ? 0 : 1) || a.index - b.index)
    .map(({ i }) => i);
  const at = line.findIndex((i) => i.id === item.id) + 1;
  return at <= 1 ? `Next for ${item.agent}` : `${ordinal(at)} for ${item.agent}`;
}

export type StageTone = 'ask' | 'busy' | 'wait' | 'bad' | 'off';

/**
 * Where an In progress ticket is, in words (9.2): the card's stage line.
 * A question for the user comes first, whatever the step.
 */
export function stageLine(item: WorkItem, all: readonly WorkItem[]): { text: string; tone: StageTone } {
  if (item.userAsks > 0) return { text: item.userAsks > 1 ? `Needs your input (${item.userAsks})` : 'Needs your input', tone: 'ask' };
  if (item.openAsks > 0) return { text: 'Waiting for the orchestrator', tone: 'wait' };
  const round = item.workflow && item.workflow.round > 1 ? `Round ${item.workflow.round} · ` : '';
  const step = activeImplement(item);
  if (step?.state === 'queued') {
    const q = queueLine(item, all);
    return { text: `${round}Queued: ${q.charAt(0).toLowerCase()}${q.slice(1)}`, tone: 'off' };
  }
  if (step?.state === 'running' || step?.state === 'needs-input') return { text: `${round}Implementing`, tone: 'busy' };
  const merge = item.workflow?.steps.find((s) => s.kind === 'merge' && s.state === 'waiting');
  if (merge) {
    const stopped = item.workflow?.steps.some((s) => s.kind === 'implement' && s.result === 'cancelled' && /stopped/i.test(s.detail));
    return { text: stopped ? 'Stopped by you · waiting for you to accept or merge' : 'Finished · waiting for you to accept or merge', tone: 'wait' };
  }
  return { text: item.stage ? `${round}${item.stage}` : 'In progress', tone: 'off' };
}

/** The outcome chip of a Done card. */
export function outcomeChip(item: WorkItem, prNumber: number | null): { text: string; tone: 'merged' | 'accepted' | 'failed' | 'cancelled' } | null {
  switch (item.outcome) {
    case 'merged':
      return { text: prNumber ? `Merged #${prNumber}` : 'Merged', tone: 'merged' };
    case 'accepted':
      return { text: 'Accepted', tone: 'accepted' };
    case 'failed':
      return { text: 'Failed', tone: 'failed' };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'cancelled' };
    default:
      return null;
  }
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
  const verifying = cap.verifying ? [`${cap.verifying} verifying`] : [];
  return [...agents, `${cap.workers.running} of ${cap.workers.max} workers busy`, ...verifying].join(' · ');
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

/**
 * The live-work summary in the chat header: "2 need you · 3 in progress".
 * `needs` counts tickets with an ask routed to the user (questions and
 * decisions alike): the Board tab's count.
 */
export function liveWork(items: readonly WorkItem[]): { text: string; needs: number; progress: number; verifying: number } {
  const needs = items.filter(needsYou).length;
  const progress = items.filter((i) => i.status === 'in-progress' && !needsYou(i)).length;
  const verifying = items.filter((i) => i.status === 'in-progress' && (i.stage === 'checks' || i.stage === 'review')).length;
  const parts: string[] = [];
  if (needs) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`);
  if (progress) parts.push(`${progress} in progress`);
  if (verifying) parts.push(`${verifying} verifying`);
  return { text: parts.join(' · '), needs, progress, verifying };
}
