/**
 * The board's model: three columns by status, the Done filter, the card
 * menu held to the ticket and step tables, the stage line, and drags only
 * within Todo.
 */

import { describe, expect, it } from 'vitest';
import type { ItemStatus, WorkItem } from '../../src/harness/daemon-protocol';
import { allows, TICKET_TRANSITIONS, type TicketTrigger } from '../../src/harness/item-transitions';
import {
  armsFirst,
  assignable,
  canUnassign,
  capacityText,
  cardActions,
  columnItems,
  columnOf,
  COLUMNS,
  doneCounts,
  doneEmptyText,
  doneMatches,
  dropAction,
  liveWork,
  outcomeChip,
  parseIssueRef,
  queueLine,
  readDoneFilter,
  saveDoneFilter,
  stageLine,
  type CardAction,
  type ColumnId,
} from '../../src/renderer/board-model';
import { item } from './v2-fixtures';

const PLACES = ['backlog', 'queued', 'running', 'needs-input', 'review', 'done', 'failed', 'cancelled'] as const;

/** The ticket trigger behind each card action (Stop and Publish are no ticket transition). */
const TRIGGER: Partial<Record<CardAction, TicketTrigger>> = {
  accept: 'accept',
  retry: 'retry',
  cancel: 'cancel',
  delete: 'delete',
};

describe('board columns', () => {
  it('has exactly three columns, one per status', () => {
    expect(COLUMNS.map((c) => [c.id, c.title])).toEqual([
      ['todo', 'Todo'],
      ['progress', 'In progress'],
      ['done', 'Done'],
    ]);
    const statuses: ItemStatus[] = ['todo', 'in-progress', 'done'];
    expect(statuses.map(columnOf)).toEqual(['todo', 'progress', 'done']);
    for (const t of TICKET_TRANSITIONS) expect(COLUMNS.some((c) => c.id === columnOf(t.from))).toBe(true);
  });

  it('puts every protocol-1 place in the column its status maps to', () => {
    expect(Object.fromEntries(PLACES.map((p) => [p, columnOf(item({ status: p }).status)]))).toEqual({
      backlog: 'todo',
      queued: 'todo',
      running: 'progress',
      'needs-input': 'progress',
      review: 'progress',
      done: 'done',
      failed: 'done',
      cancelled: 'done',
    });
  });

  it('orders In progress: asks for you first (oldest first), then the orchestrator’s, then running work by start, then the rest', () => {
    const items = [
      item({ number: 1, status: 'queued', updatedAt: 1 }),
      item({ number: 2, status: 'running', updatedAt: 50 }),
      item({ number: 3, status: 'needs-input', pendingAsk: { askId: 'a', routedTo: 'orchestrator' }, updatedAt: 60 }),
      item({ number: 4, status: 'needs-input', pendingAsk: { askId: 'b', routedTo: 'user' }, updatedAt: 70 }),
      item({ number: 5, status: 'running', updatedAt: 10 }),
      item({ number: 6, status: 'queued', updatedAt: 9 }),
      item({ number: 7, status: 'review', updatedAt: 5 }),
      item({ number: 8, status: 'needs-input', pendingAsk: { askId: 'c', routedTo: 'user' }, updatedAt: 65 }),
    ];
    const ids = (col: ColumnId) => columnItems(items, col).map((i) => i.number);
    expect(ids('todo')).toEqual([1, 6]);
    expect(ids('progress')).toEqual([8, 4, 3, 5, 2, 7]);
  });

  it('orders Done newest closed first, through the filter', () => {
    const items = [
      item({ number: 1, status: 'done', updatedAt: 5 }),
      item({ number: 2, status: 'failed', updatedAt: 9 }),
      item({ number: 3, status: 'cancelled', updatedAt: 7 }),
      item({ number: 4, status: 'done', pr: { number: 9, url: 'u', draft: false, lastPushedSha: 'x', state: 'merged' }, updatedAt: 8 }),
    ];
    expect(columnItems(items, 'done', undefined, 'all').map((i) => i.number)).toEqual([2, 4, 3, 1]);
    expect(columnItems(items, 'done', undefined, 'delivered').map((i) => i.number)).toEqual([4, 1]);
    expect(columnItems(items, 'done', undefined, 'failed').map((i) => i.number)).toEqual([2]);
    expect(columnItems(items, 'done', undefined, 'cancelled').map((i) => i.number)).toEqual([3]);
  });
});

describe('the Done filter', () => {
  const items = [
    item({ number: 1, status: 'done' }),
    item({ number: 2, status: 'failed' }),
    item({ number: 3, status: 'failed' }),
    item({ number: 4, status: 'cancelled' }),
    item({ number: 5, status: 'running' }),
  ];

  it('counts delivered, failed, cancelled and all', () => {
    expect(doneCounts(items)).toEqual({ delivered: 1, failed: 2, cancelled: 1, all: 4 });
    expect(doneMatches(item({ status: 'done' }), 'delivered')).toBe(true);
    expect(doneMatches(item({ status: 'running' }), 'all')).toBe(false);
  });

  it('says what the filter hides when it hides everything', () => {
    const onlyFailed = [item({ number: 1, status: 'failed' }), item({ number: 2, status: 'failed' })];
    expect(doneEmptyText('delivered', doneCounts(onlyFailed))).toBe('No delivered tickets yet. 2 failed are behind the filter.');
    expect(doneEmptyText('delivered', doneCounts([item({ status: 'failed' })]))).toBe('No delivered tickets yet. 1 failed is behind the filter.');
    expect(doneEmptyText('delivered', doneCounts(items))).toBeNull();
    expect(doneEmptyText('delivered', doneCounts([]))).toBeNull();
  });

  it('is remembered per environment, Delivered by default', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    expect(readDoneFilter(storage, 'env_a')).toBe('delivered');
    saveDoneFilter(storage, 'env_a', 'failed');
    expect(readDoneFilter(storage, 'env_a')).toBe('failed');
    expect(readDoneFilter(storage, 'env_b')).toBe('delivered');
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readDoneFilter(broken, 'env_a')).toBe('delivered');
    expect(() => saveDoneFilter(broken, 'env_a', 'all')).not.toThrow();
  });
});

describe('card actions', () => {
  it('offer only what the ticket table allows, and every such action', () => {
    for (const place of PLACES) {
      const it = item({ status: place });
      const state = { status: it.status, outcome: it.outcome };
      const actions = cardActions(it);
      for (const action of actions) {
        const trigger = TRIGGER[action];
        if (trigger) expect(allows(state, trigger), `${action} on ${place}`).toBe(true);
      }
      for (const action of ['retry', 'cancel', 'delete'] as const) {
        expect(actions.includes(action), `${action} on ${place}`).toBe(allows(state, TRIGGER[action] as TicketTrigger));
      }
    }
  });

  it('follow the ticket’s steps: Stop while its worker runs, Publish and Accept once it finished', () => {
    expect(cardActions(item({ status: 'backlog' }))).toEqual(['assign', 'cancel', 'delete']);
    expect(cardActions(item({ status: 'queued' }))).toEqual(['assign', 'cancel', 'delete']);
    expect(cardActions(item({ status: 'running' }))).toEqual(['stop', 'accept', 'cancel']);
    expect(cardActions(item({ status: 'needs-input' }))).toEqual(['accept', 'cancel']);
    expect(cardActions(item({ status: 'queued', sessionId: 's' }))).toEqual(['accept', 'cancel']);
    expect(cardActions(item({ status: 'review' }))).toEqual(['publish', 'accept', 'cancel']);
    expect(cardActions(item({ status: 'done' }))).toEqual(['delete']);
    expect(cardActions(item({ status: 'failed' }))).toEqual(['retry', 'delete']);
    expect(cardActions(item({ status: 'cancelled' }))).toEqual(['retry', 'delete']);
  });

  it('arm on the first click for Delete, and for cancelling a started ticket', () => {
    for (const place of PLACES) expect(armsFirst('delete', item({ status: place }))).toBe(true);
    expect(PLACES.filter((p) => armsFirst('cancel', item({ status: p })))).toEqual(['running', 'needs-input', 'review']);
    expect(armsFirst('retry', item({ status: 'failed' }))).toBe(false);
  });

  it('assign a Todo ticket to the definition agents, keeping an agent that already has a session', () => {
    const agents = ['implementer', 'reviewer'];
    expect(assignable(item({ status: 'backlog' }), agents)).toEqual(agents);
    expect(assignable(item({ status: 'queued', agent: 'implementer' }), agents)).toEqual(['reviewer']);
    expect(assignable(item({ status: 'backlog', sessionId: 's' }), agents)).toEqual([]);
    expect(assignable(item({ status: 'backlog', sessionId: 's' }), agents, 'reviewer')).toEqual(['reviewer']);
    expect(assignable(item({ status: 'running', agent: 'reviewer' }), agents)).toEqual([]);
    expect(assignable(item({ status: 'review' }), agents)).toEqual([]);
    expect(canUnassign(item({ status: 'queued' }))).toBe(true);
    expect(canUnassign(item({ status: 'backlog' }))).toBe(false);
    expect(canUnassign(item({ status: 'running' }))).toBe(false);
  });
});

describe('drag and drop', () => {
  it('allows only reordering within Todo', () => {
    const allowed: string[] = [];
    for (const status of ['todo', 'in-progress', 'done'] as ItemStatus[]) {
      for (const col of COLUMNS) {
        const action = dropAction(status, col.id);
        if (action) allowed.push(`${status}→${col.id}:${action}`);
      }
    }
    expect(allowed).toEqual(['todo→todo:reorder']);
  });
});

describe('card text', () => {
  it('says where a queued ticket stands in its agent’s line, started tickets first', () => {
    const all = [
      item({ number: 1, status: 'queued', agent: 'implementer' }),
      item({ number: 2, status: 'queued', agent: 'reviewer' }),
      item({ number: 3, status: 'queued', agent: 'implementer' }),
      item({ number: 4, status: 'backlog' }),
      item({ number: 5, status: 'queued', agent: 'implementer', sessionId: 's' }),
    ];
    expect(all.map((i) => queueLine(i, all))).toEqual(['2nd for implementer', 'Next for reviewer', '3rd for implementer', 'Waiting for an agent', 'Next for implementer']);
  });

  it('says where an In progress ticket is, a question for you first', () => {
    const all = [item({ number: 9, status: 'queued', agent: 'implementer', sessionId: 's' })];
    expect(stageLine(item({ status: 'running' }), all)).toEqual({ text: 'Implementing', tone: 'busy' });
    expect(stageLine(all[0] as WorkItem, all)).toEqual({ text: 'Queued: next for implementer', tone: 'off' });
    expect(stageLine(item({ status: 'review' }), all)).toEqual({ text: 'Finished · waiting for you to accept or merge', tone: 'wait' });
    expect(stageLine(item({ status: 'needs-input', pendingAsk: { askId: 'a', routedTo: 'user' } }), all)).toEqual({ text: 'Needs your input', tone: 'ask' });
    expect(stageLine(item({ status: 'needs-input', pendingAsk: { askId: 'a', routedTo: 'orchestrator' } }), all)).toEqual({ text: 'Waiting for the orchestrator', tone: 'wait' });
    const stopped = item({ status: 'review', result: { summary: '', commits: [], diffStat: { files: 0, insertions: 0, deletions: 0, text: '' }, uncommitted: [], interrupted: true, endedAt: 1, head: '' } });
    expect(stageLine(stopped, all).text).toBe('Stopped by you · waiting for you to accept or merge');
    const round2 = item({ status: 'running' });
    expect(stageLine({ ...round2, workflow: round2.workflow ? { ...round2.workflow, round: 2 } : null }, all).text).toBe('Round 2 · Implementing');
  });

  it('counts a mixed ticket by its asks for the user: the halo, the badge, the Board tab', () => {
    // An older question for the orchestrator and a newer one for the user.
    const mixed = {
      ...item({ number: 1, status: 'needs-input', pendingAsk: { askId: 'old', routedTo: 'orchestrator' } }),
      oldestUserAsk: { askId: 'new', kind: 'question' as const, roundId: 'r', stepId: 's', since: 5 },
      openAsks: 2,
      userAsks: 1,
    };
    expect(mixed.needsInput?.routedTo).toBe('orchestrator');
    expect(stageLine(mixed, [mixed]).tone).toBe('ask');
    expect(liveWork([mixed]).needs).toBe(1);
    expect(columnItems([item({ number: 2, status: 'needs-input', pendingAsk: { askId: 'x', routedTo: 'orchestrator' } }), mixed], 'progress').map((i) => i.number)).toEqual([1, 2]);
  });

  it('gives a Done card its outcome chip', () => {
    expect(outcomeChip(item({ status: 'done', pr: { number: 48, url: 'u', draft: false, lastPushedSha: 'x', state: 'merged' } }), 48)).toEqual({ text: 'Merged #48', tone: 'merged' });
    expect(outcomeChip(item({ status: 'done' }), null)).toEqual({ text: 'Accepted', tone: 'accepted' });
    expect(outcomeChip(item({ status: 'failed' }), null)).toEqual({ text: 'Failed', tone: 'failed' });
    expect(outcomeChip(item({ status: 'cancelled' }), null)).toEqual({ text: 'Cancelled', tone: 'cancelled' });
    expect(outcomeChip(item({ status: 'running' }), null)).toBeNull();
  });

  it('summarizes live work for the chat header', () => {
    const items = [
      item({ number: 1, status: 'needs-input', pendingAsk: { askId: 'a', routedTo: 'user' } }),
      item({ number: 2, status: 'needs-input', pendingAsk: { askId: 'b', routedTo: 'orchestrator' } }),
      item({ number: 3, status: 'running' }),
      item({ number: 4, status: 'review' }),
      item({ number: 5, status: 'backlog' }),
    ];
    expect(liveWork(items)).toEqual({ text: '1 needs you · 3 in progress', needs: 1, progress: 3, verifying: 0 });
    expect(liveWork([]).text).toBe('');
  });

  it('describes capacity per agent and in total', () => {
    expect(capacityText({ agents: { reviewer: { running: 0, max: 1 }, implementer: { running: 2, max: 2 } }, workers: { running: 2, max: 3 }, paused: false })).toBe(
      'implementer 2 of 2 · reviewer 0 of 1 · 2 of 3 workers busy',
    );
    expect(capacityText({ agents: {}, workers: { running: 1, max: 3 }, paused: false, verifying: 1 })).toBe('1 of 3 workers busy · 1 verifying');
  });

  it('parses issue references', () => {
    expect(parseIssueRef('octo/web#12')).toEqual({ repo: 'octo/web', number: 12 });
    expect(parseIssueRef('octo/web 12')).toBeNull();
    expect(parseIssueRef(' octo/web # 7 ')).toEqual({ repo: 'octo/web', number: 7 });
    expect(parseIssueRef('https://github.com/octo/web/issues/9#issuecomment-1')).toEqual({ repo: 'octo/web', number: 9 });
    expect(parseIssueRef('fix the login')).toBeNull();
  });
});
