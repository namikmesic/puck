/**
 * What a protocol-1 connection sees of a protocol-2 daemon
 * (`docs/delivery-workflow-spec.md`, 12.2). The daemon serves protocol 1
 * for one more release, so an old app and an old runner keep working.
 *
 * - Records: a ticket's three states map to protocol 1's eight
 *   (`statusV1`, the shared mapping in `src/harness/workflow.ts`);
 *   `references` become `source` and `pr`; a question in `needsInput`
 *   becomes `pendingAsk`; every protocol-2 field is dropped.
 * - Every result that carries a ticket is projected, and `snapshot.get` is
 *   sent whole, as protocol 1 had it.
 * - The event stream keeps its sequence: an old client applies events
 *   strictly in `seq` order and resyncs on a gap, so no event is ever held
 *   back. An event of a kind protocol 1 does not know goes out with its own
 *   `seq` as a substitute of a kind it does know: an event about a ticket
 *   becomes that ticket's `item.upsert` from its current state (or
 *   `item.removed` once it is gone), anything else a `capacity` event. Both
 *   replace state, so a run of substitutes ends in the right state.
 *   Events from before the format boundary already have protocol 1's
 *   shapes and go out as they are.
 * - Ops protocol 1 did not have are refused as unknown.
 */

import type { Capacity, DaemonEvent, Op, Snapshot, SnapshotV1, WorkItem, WorkItemV1 } from '../harness/daemon-protocol';
import { deliveryPull, sourceIssue } from '../harness/references';
import { statusV1 } from '../harness/workflow';

/** The ops protocol 1 had. */
export const V1_OPS: ReadonlySet<Op> = new Set<Op>([
  'snapshot.get',
  'session.history',
  'chat.send',
  'session.interrupt',
  'ask.answer',
  'item.create',
  'item.update',
  'item.move',
  'item.assign',
  'item.cancel',
  'item.retry',
  'item.accept',
  'item.publish',
  'item.delete',
  'issue.import',
  'issue.search',
  'item.pr',
  'github.nudge',
  'definition.apply',
  'credentials.put',
  'credentials.get',
  'github.put',
  'secrets.put',
  'scheduler.pause',
  'scheduler.resume',
  'daemon.upgrade',
  'logs.tail',
]);

/** The event kinds protocol 1 had. */
export const V1_EVENT_KINDS: ReadonlySet<string> = new Set([
  'instance.status',
  'instance.definition',
  'github.auth',
  'session.upsert',
  'turn.user',
  'turn.notice',
  'turn.start',
  'turn.end',
  'turn.event',
  'ask.routed',
  'ask.closed',
  'item.upsert',
  'item.removed',
  'backlog.order',
  'capacity',
  'daemon.upgrading',
]);

/** The ops whose result is one ticket. */
const ITEM_RESULTS: ReadonlySet<Op> = new Set<Op>(['item.create', 'item.update', 'item.assign', 'item.cancel', 'item.retry', 'item.accept', 'issue.import']);

export function projectItem(item: WorkItem): WorkItemV1 {
  const pr = deliveryPull(item);
  const src = sourceIssue(item);
  const result = item.result
    ? (({ head: _head, ...rest }) => {
        void _head;
        return rest;
      })(item.result)
    : null;
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    status: statusV1(item),
    agent: item.agent,
    repo: item.repo,
    createdBy: item.createdBy === 'orchestrator' ? 'orchestrator' : 'user',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    attempts: item.attempts,
    sessionId: item.sessionId,
    branch: item.branch,
    worktree: item.worktree,
    base: item.base,
    result,
    pr: pr
      ? {
          number: pr.number,
          url: pr.url,
          draft: pr.draft,
          lastPushedSha: pr.lastPushedSha,
          ...(pr.state ? { state: pr.state } : {}),
          ...(pr.checks !== undefined ? { checks: pr.checks } : {}),
        }
      : null,
    source: src ? { kind: 'github-issue', repo: src.repo, number: src.number, url: src.url, updatedAt: src.updatedAt } : null,
    lastError: item.lastError,
    cancelReason: item.cancelReason,
    acceptNote: item.acceptNote,
    pendingAsk: item.needsInput?.kind === 'question' ? { askId: item.needsInput.askId, routedTo: item.needsInput.routedTo } : null,
  };
}

export function projectSnapshot(snapshot: Snapshot): SnapshotV1 {
  const { decisions: _decisions, items, daemon, ...rest } = snapshot;
  void _decisions;
  return { ...rest, daemon: { ...daemon, protocol: 1 }, items: items.map(projectItem) };
}

/** A command result as protocol 1 had it. */
export function projectResult(op: Op, result: unknown): unknown {
  if (ITEM_RESULTS.has(op) && result && typeof result === 'object') return projectItem(result as WorkItem);
  return result;
}

export interface ProjectionState {
  /** The ticket as it is now (protocol 2), or null once deleted. */
  item(itemId: string): WorkItem | null;
  capacity(): Capacity;
  /** Events at or below this seq hold protocol-1 shapes already. */
  formatBoundary: number;
}

/** A protocol-1 event (the shapes protocol 1 had). */
export type DaemonEventV1 = Exclude<DaemonEvent, { kind: 'item.upsert' }> | { kind: 'item.upsert'; item: WorkItemV1 };

function itemIdOf(ev: DaemonEvent): string | null {
  const id = (ev as { itemId?: unknown }).itemId;
  return typeof id === 'string' ? id : null;
}

/** One logged event as a protocol-1 connection receives it, with the same seq. */
export function projectEvent(seq: number, ev: DaemonEvent, state: ProjectionState): DaemonEventV1 {
  if (seq <= state.formatBoundary) return ev as DaemonEventV1;
  if (ev.kind === 'item.upsert') return { kind: 'item.upsert', item: projectItem(ev.item) };
  if (V1_EVENT_KINDS.has(ev.kind)) return ev as DaemonEventV1;
  if (ev.kind === 'ticket.removed') return { kind: 'item.removed', itemId: ev.itemId };
  const itemId = itemIdOf(ev);
  if (itemId) {
    const item = state.item(itemId);
    return item ? { kind: 'item.upsert', item: projectItem(item) } : { kind: 'item.removed', itemId };
  }
  return { kind: 'capacity', ...state.capacity() };
}
