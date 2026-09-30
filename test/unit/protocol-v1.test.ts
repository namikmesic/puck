import { describe, expect, it } from 'vitest';
import type { Capacity, DaemonEvent, ItemStatusV1, Snapshot, WorkItem, WorkItemV1 } from '../../src/harness/daemon-protocol';
import { OPS } from '../../src/harness/daemon-protocol';
import { upgradeV1Item } from '../../src/harness/workflow';
import { projectEvent, projectItem, projectResult, projectSnapshot, V1_EVENT_KINDS, V1_OPS } from '../../src/daemon/protocol-v1';

// What a protocol-1 connection sees of a protocol-2 daemon (12.2), table by table.

function v1(over: Partial<WorkItemV1> & Pick<WorkItemV1, 'status'>): WorkItemV1 {
  return {
    id: 'itm_01J0000000000000000000000A',
    number: 3,
    title: 'Fix it',
    body: 'b',
    agent: 'implementer',
    repo: 'app',
    createdBy: 'orchestrator',
    createdAt: 1,
    updatedAt: 2,
    attempts: 1,
    sessionId: 'ses_1',
    branch: 'puck/W-3',
    worktree: '/w',
    base: { branch: 'main', sha: 'a' },
    result: null,
    pr: null,
    source: null,
    lastError: null,
    cancelReason: null,
    acceptNote: null,
    pendingAsk: null,
    ...over,
  };
}

const CAP: Capacity = { agents: { implementer: { running: 1, max: 2 } }, workers: { running: 1, max: 3 }, paused: false, verifying: 0 };

describe('the protocol-1 projection', () => {
  // Records: every protocol-2 place projects to the protocol-1 status it came from.
  const PLACES: Array<[string, WorkItem, ItemStatusV1]> = [
    ['todo without an agent', upgradeV1Item(v1({ status: 'backlog', agent: null, sessionId: null })), 'backlog'],
    ['todo with one', upgradeV1Item(v1({ status: 'queued', sessionId: null })), 'queued'],
    ['in progress, implement running', upgradeV1Item(v1({ status: 'running' })), 'running'],
    ['in progress, implement needs-input', upgradeV1Item(v1({ status: 'needs-input' })), 'needs-input'],
    ['in progress, implement queued', upgradeV1Item(v1({ status: 'queued' })), 'queued'],
    ['in progress, the merge step waiting', upgradeV1Item(v1({ status: 'review' })), 'review'],
    ['done (accepted)', upgradeV1Item(v1({ status: 'done' })), 'done'],
    ['done (merged)', upgradeV1Item(v1({ status: 'done', pr: { number: 4, url: 'https://github.com/octo/app/pull/4', draft: false, lastPushedSha: 'x', state: 'merged' } })), 'done'],
    ['done (failed)', upgradeV1Item(v1({ status: 'failed' })), 'failed'],
    ['done (cancelled)', upgradeV1Item(v1({ status: 'cancelled' })), 'cancelled'],
  ];

  it.each(PLACES)('%s → %s', (_name, item, want) => {
    expect(projectItem(item).status).toBe(want);
  });

  it('turns references into source and pr, a question into pendingAsk, and drops every protocol-2 field', () => {
    const original = v1({
      status: 'needs-input',
      source: { kind: 'github-issue', repo: 'octo/app', number: 12, url: 'https://github.com/octo/app/issues/12', updatedAt: 9 },
      pr: { number: 40, url: 'https://github.com/octo/app/pull/40', draft: true, lastPushedSha: 'c', state: 'open', checks: null },
      pendingAsk: { askId: 'ask_1', routedTo: 'user' },
      result: { summary: 's', commits: [], diffStat: { files: 0, insertions: 0, deletions: 0, text: '' }, uncommitted: [], interrupted: false, endedAt: 3 },
    });
    const up = upgradeV1Item(original);
    // A related link stays out of protocol 1's view.
    up.references.push({ id: 'ref_x', role: 'related', kind: 'url', url: 'https://example.com', label: null });
    const back = projectItem(up);
    expect(back).toEqual(original);
    for (const key of ['stage', 'outcome', 'closedAt', 'workflow', 'references', 'needsInput', 'oldestUserAsk', 'openAsks', 'userAsks', 'delivery']) {
      expect(back, key).not.toHaveProperty(key);
    }
    expect(back.result).not.toHaveProperty('head');
    // A pipeline-created ticket reads as the user's.
    expect(projectItem({ ...up, createdBy: 'pipeline' }).createdBy).toBe('user');
    // A decision is not a question.
    expect(projectItem({ ...up, needsInput: { askId: 'd', kind: 'decision', roundId: 'r', stepId: null, routedTo: 'user', since: 1 } }).pendingAsk).toBeNull();
  });

  it('projects every result that carries a ticket, and the whole snapshot', () => {
    const item = upgradeV1Item(v1({ status: 'review' }));
    for (const op of ['item.create', 'item.update', 'item.assign', 'item.cancel', 'item.retry', 'item.accept', 'issue.import'] as const) {
      expect((projectResult(op, item) as WorkItemV1).status, op).toBe('review');
    }
    expect(projectResult('item.move', { order: ['a'] })).toEqual({ order: ['a'] });
    const snapshot: Snapshot = {
      envId: 'env_1',
      name: 'n',
      daemon: { version: 'v', build: 'b', protocol: 2 },
      head: 5,
      instance: { status: 'ready', pin: null, sha: null },
      github: { state: 'ok' },
      sessions: [],
      orchestratorSessionId: null,
      items: [item],
      order: [item.id],
      capacity: CAP,
      inflight: [],
      asks: [],
      decisions: [],
    };
    const old = projectSnapshot(snapshot);
    expect(old.items.map((i) => i.status)).toEqual(['review']);
    expect(old).not.toHaveProperty('decisions');
    expect(old.daemon.protocol).toBe(1);
  });

  it('keeps the event sequence: every kind protocol 1 lacks becomes a substitute it knows', () => {
    const item = upgradeV1Item(v1({ status: 'running' }));
    const state = { item: (id: string) => (id === item.id ? item : null), capacity: () => CAP, formatBoundary: 10 };
    const step = { id: 's', kind: 'implement', round: 1, state: 'running', result: null } as never;
    const events: DaemonEvent[] = [
      { kind: 'step.changed', itemId: item.id, step, from: 'queued', trigger: 'start' },
      { kind: 'round.opened', itemId: item.id, roundId: 'r', round: 2, purpose: 'changes', reason: 'm' },
      { kind: 'round.settled', itemId: item.id, roundId: 'r', round: 1, gate: 'pending', outcome: 'settled', obligations: [] },
      { kind: 'ticket.reference', itemId: item.id, op: 'add', reference: { id: 'x', role: 'related', kind: 'url', url: 'https://e', label: null } },
      { kind: 'step.changed', itemId: 'itm_gone', step, from: null, trigger: 'create' },
    ];
    const projected = events.map((ev, i) => projectEvent(11 + i, ev, state));
    expect(projected.slice(0, 4)).toEqual(Array.from({ length: 4 }, () => ({ kind: 'item.upsert', item: projectItem(item) })));
    expect(projected[4]).toEqual({ kind: 'item.removed', itemId: 'itm_gone' });
    expect(projectEvent(20, { kind: 'ticket.removed', itemId: item.id, number: 3, title: 't', status: 'done', outcome: 'cancelled' }, state)).toEqual({ kind: 'item.removed', itemId: item.id });
    expect(projectEvent(21, { kind: 'merge.observed', itemId: 'itm_gone' } as never, state)).toEqual({ kind: 'item.removed', itemId: 'itm_gone' });
    // A new kind that is about no ticket becomes the current capacity.
    expect(projectEvent(22, { kind: 'from-the-future' } as unknown as DaemonEvent, state)).toEqual({ kind: 'capacity', ...CAP });
    // Known kinds keep their shape; item.upsert is projected.
    expect(projectEvent(23, { kind: 'item.upsert', item }, state)).toEqual({ kind: 'item.upsert', item: projectItem(item) });
    expect(projectEvent(24, { kind: 'backlog.order', order: ['a'] }, state)).toEqual({ kind: 'backlog.order', order: ['a'] });
    // Events at or before the format boundary already hold protocol-1 shapes.
    const legacy = { kind: 'item.upsert', item: v1({ status: 'review' }) } as unknown as DaemonEvent;
    expect(projectEvent(10, legacy, state)).toBe(legacy);
  });

  it('knows exactly protocol 1’s ops and event kinds', () => {
    expect(V1_OPS.size).toBe(27);
    for (const op of V1_OPS) expect(OPS).toContain(op);
    for (const op of ['snapshot.part', 'item.link', 'item.unlink', 'item.workflow', 'item.records'] as const) expect(V1_OPS.has(op)).toBe(false);
    expect(V1_EVENT_KINDS.size).toBe(16);
    for (const kind of ['step.changed', 'round.opened', 'round.settled', 'ticket.removed', 'ticket.reference', 'merge.observed']) expect(V1_EVENT_KINDS.has(kind)).toBe(false);
  });
});
