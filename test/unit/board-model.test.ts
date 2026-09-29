/**
 * The board's model: every status has a column, the card menu offers
 * exactly what the daemon's state machine allows, and drags exist only
 * where a transition (or a reorder) does.
 */

import { describe, expect, it } from 'vitest';
import { nextStatus, TRANSITIONS, type ItemTrigger } from '../../src/daemon/items';
import type { ItemStatus } from '../../src/harness/daemon-protocol';
import {
  armsFirst,
  assignable,
  canUnassign,
  CARD_ACTIONS,
  capacityText,
  columnItems,
  columnOf,
  COLUMNS,
  dropAction,
  liveWork,
  parseIssueRef,
  queueLine,
  type CardAction,
  type ColumnId,
} from '../../src/renderer/board-model';
import { item } from './v2-fixtures';

const STATUSES: ItemStatus[] = ['backlog', 'queued', 'running', 'needs-input', 'review', 'done', 'failed', 'cancelled'];

/** The daemon trigger behind each card action (Stop and Publish are not status transitions). */
const TRIGGER: Partial<Record<CardAction, ItemTrigger>> = {
  assign: 'assign',
  unassign: 'unassign',
  accept: 'accept',
  retry: 'retry',
  cancel: 'cancel',
  delete: 'delete',
};

describe('board columns', () => {
  it('maps every status to a stage of the state machine, closed ones included', () => {
    expect(Object.fromEntries(STATUSES.map((s) => [s, columnOf(s)]))).toEqual({
      backlog: 'backlog',
      queued: 'ready',
      running: 'progress',
      'needs-input': 'progress',
      review: 'review',
      done: 'done',
      failed: 'closed',
      cancelled: 'closed',
    });
    expect(COLUMNS.map((c) => c.id)).toEqual(['backlog', 'ready', 'progress', 'review', 'done', 'closed']);
    // Every status the daemon knows lands in a column: nothing is filtered away.
    for (const status of new Set(TRANSITIONS.flatMap((t) => t.from))) expect(COLUMNS.some((c) => c.id === columnOf(status))).toBe(true);
  });

  it('orders each column: backlog order for Backlog and Ready, questions first in progress, newest first after', () => {
    const items = [
      item({ number: 1, status: 'queued', updatedAt: 1 }),
      item({ number: 2, status: 'running', updatedAt: 50 }),
      item({ number: 3, status: 'needs-input', pendingAsk: { askId: 'a', routedTo: 'orchestrator' }, updatedAt: 60 }),
      item({ number: 4, status: 'needs-input', pendingAsk: { askId: 'b', routedTo: 'user' }, updatedAt: 70 }),
      item({ number: 5, status: 'running', updatedAt: 10 }),
      item({ number: 6, status: 'queued', updatedAt: 9 }),
      item({ number: 7, status: 'review', updatedAt: 5 }),
      item({ number: 8, status: 'review', updatedAt: 8 }),
      item({ number: 9, status: 'cancelled', updatedAt: 3 }),
      item({ number: 10, status: 'failed', updatedAt: 4 }),
    ];
    const ids = (col: ColumnId) => columnItems(items, col).map((i) => i.number);
    expect(ids('ready')).toEqual([1, 6]);
    expect(ids('progress')).toEqual([4, 3, 5, 2]);
    expect(ids('review')).toEqual([8, 7]);
    expect(ids('closed')).toEqual([10, 9]);
  });
});

describe('card actions', () => {
  it('offer exactly what the daemon allows from each status', () => {
    for (const status of STATUSES) {
      for (const action of CARD_ACTIONS[status]) {
        const trigger = TRIGGER[action];
        if (trigger) expect(() => nextStatus(status, trigger), `${action} from ${status}`).not.toThrow();
      }
      // Assign, Unassign, Cancel, Retry and Delete show wherever the state machine allows them.
      for (const action of ['assign', 'unassign', 'cancel', 'retry', 'delete'] as const) {
        const allowed = TRANSITIONS.some((t) => t.trigger === TRIGGER[action] && t.from.includes(status));
        expect(CARD_ACTIONS[status].includes(action), `${action} on ${status}`).toBe(allowed);
      }
    }
    expect(CARD_ACTIONS.running).toEqual(['stop', 'cancel']);
    expect(CARD_ACTIONS.review).toEqual(['accept', 'publish', 'cancel']);
    expect(CARD_ACTIONS.cancelled).toEqual(['retry', 'delete']);
  });

  it('arm on the first click for Delete, and for cancelling started work', () => {
    for (const status of STATUSES) expect(armsFirst('delete', status)).toBe(true);
    expect(STATUSES.filter((s) => armsFirst('cancel', s))).toEqual(['running', 'needs-input', 'review']);
    expect(armsFirst('retry', 'failed')).toBe(false);
  });

  it('assign to the definition agents, keeping an agent that already has a session', () => {
    const agents = ['implementer', 'reviewer'];
    expect(assignable(item({ status: 'backlog' }), agents)).toEqual(agents);
    expect(assignable(item({ status: 'queued', agent: 'implementer' }), agents)).toEqual(['reviewer']);
    expect(assignable(item({ status: 'backlog', agent: 'reviewer', sessionId: 's' }), agents)).toEqual(['reviewer']);
    expect(assignable(item({ status: 'queued', agent: 'reviewer', sessionId: 's' }), agents)).toEqual([]);
    expect(assignable(item({ status: 'backlog', sessionId: 's' }), agents)).toEqual([]);
    expect(assignable(item({ status: 'backlog', sessionId: 's' }), agents, 'reviewer')).toEqual(['reviewer']);
    expect(assignable(item({ status: 'queued', sessionId: 's' }), agents, 'reviewer')).toEqual([]);
    expect(assignable(item({ status: 'running', agent: 'reviewer' }), agents)).toEqual([]);
  });
});

describe('drag and drop', () => {
  it('allows only reorders within Backlog and Ready, and assign and unassign between them', () => {
    const allowed: string[] = [];
    for (const status of STATUSES) {
      for (const col of COLUMNS) {
        const action = dropAction(status, col.id);
        if (action) allowed.push(`${status}→${col.id}:${action}`);
      }
    }
    expect(allowed).toEqual(['backlog→backlog:reorder', 'backlog→ready:assign', 'queued→backlog:unassign', 'queued→ready:reorder']);
    // A queued item that already has a session stays in Ready: it can reorder, not unassign.
    expect(dropAction('queued', 'backlog', 'ses')).toBeNull();
    expect(dropAction('queued', 'ready', 'ses')).toBe('reorder');
    expect(canUnassign(item({ status: 'queued' }))).toBe(true);
    expect(canUnassign(item({ status: 'queued', sessionId: 'ses' }))).toBe(false);
    // Each drop that changes status is a real transition.
    expect(nextStatus('backlog', 'assign')).toBe('queued');
    expect(nextStatus('queued', 'unassign')).toBe('backlog');
  });
});

describe('card text', () => {
  it('says where a queued item stands in its agent’s line', () => {
    const all = [
      item({ number: 1, status: 'queued', agent: 'implementer' }),
      item({ number: 2, status: 'queued', agent: 'reviewer' }),
      item({ number: 3, status: 'queued', agent: 'implementer' }),
      item({ number: 4, status: 'queued', agent: null }),
    ];
    expect(all.map((i) => queueLine(i, all))).toEqual(['Next for implementer', 'Next for reviewer', '2nd for implementer', 'Waiting for an agent']);
  });

  it('summarizes live work for the chat header', () => {
    const items = [
      item({ number: 1, status: 'needs-input', pendingAsk: { askId: 'a', routedTo: 'user' } }),
      item({ number: 2, status: 'needs-input', pendingAsk: { askId: 'b', routedTo: 'orchestrator' } }),
      item({ number: 3, status: 'running' }),
      item({ number: 4, status: 'review' }),
      item({ number: 5, status: 'backlog' }),
    ];
    expect(liveWork(items)).toEqual({ text: '1 needs input · 2 running · 1 in review', needs: 1, running: 2, review: 1 });
    expect(liveWork([]).text).toBe('');
  });

  it('describes capacity per agent and in total', () => {
    expect(capacityText({ agents: { reviewer: { running: 0, max: 1 }, implementer: { running: 2, max: 2 } }, workers: { running: 2, max: 3 }, paused: false })).toBe(
      'implementer 2 of 2 · reviewer 0 of 1 · 2 of 3 workers busy',
    );
  });

  it('parses issue references', () => {
    expect(parseIssueRef('octo/web#12')).toEqual({ repo: 'octo/web', number: 12 });
    expect(parseIssueRef('octo/web 12')).toBeNull();
    expect(parseIssueRef(' octo/web # 7 ')).toEqual({ repo: 'octo/web', number: 7 });
    expect(parseIssueRef('https://github.com/octo/web/issues/9#issuecomment-1')).toEqual({ repo: 'octo/web', number: 9 });
    expect(parseIssueRef('fix the login')).toBeNull();
  });
});
