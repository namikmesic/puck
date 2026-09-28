import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonEvent, ItemStatus } from '../../src/harness/daemon-protocol';
import {
  Backlog,
  holdsSlot,
  ItemStateError,
  nextStatus,
  publicItem,
  TRANSITIONS,
  type ItemTrigger,
} from '../../src/daemon/items';
import { itemsStore } from '../../src/daemon/store/items';

// The work-item state machine is the complete set of status changes: every
// row below is allowed, and every other (status, trigger) pair is refused
// with invalid-state, so the daemon can never drift into an undefined state.

const STATUSES: ItemStatus[] = ['backlog', 'queued', 'running', 'needs-input', 'review', 'done', 'failed', 'cancelled'];
const TRIGGERS: ItemTrigger[] = [
  'assign',
  'unassign',
  'dispatch',
  'ask',
  'answer',
  'finish',
  'interrupt',
  'error',
  'error-final',
  'restart',
  'cancel',
  'follow-up',
  'accept',
  'retry',
  'delete',
];

/** The transition table as written in the design: [from, trigger, to, slot]. */
const EXPECTED: Array<[ItemStatus, ItemTrigger, ItemStatus | 'removed', 'acquires' | 'keeps' | 'releases' | null]> = [
  ['backlog', 'assign', 'queued', null],
  ['queued', 'assign', 'queued', null],
  ['queued', 'unassign', 'backlog', null],
  ['queued', 'dispatch', 'running', 'acquires'],
  ['running', 'ask', 'needs-input', 'keeps'],
  ['needs-input', 'answer', 'running', 'keeps'],
  ['running', 'finish', 'review', 'releases'],
  ['running', 'interrupt', 'review', 'releases'],
  ['running', 'error', 'queued', 'releases'],
  ['running', 'error-final', 'failed', 'releases'],
  ['running', 'restart', 'queued', 'releases'],
  ['needs-input', 'restart', 'queued', 'releases'],
  ['running', 'cancel', 'cancelled', 'releases'],
  ['needs-input', 'cancel', 'cancelled', 'releases'],
  ['queued', 'cancel', 'cancelled', 'releases'],
  ['backlog', 'cancel', 'cancelled', 'releases'],
  ['review', 'cancel', 'cancelled', 'releases'],
  ['review', 'follow-up', 'queued', null],
  ['review', 'accept', 'done', null],
  ['failed', 'retry', 'queued', null],
  ['cancelled', 'retry', 'queued', null],
  ['backlog', 'delete', 'removed', null],
  ['done', 'delete', 'removed', null],
  ['failed', 'delete', 'removed', null],
  ['cancelled', 'delete', 'removed', null],
];

describe('work item state machine', () => {
  it('has exactly the designed transitions', () => {
    const table = TRANSITIONS.flatMap((t) => t.from.map((from) => [from, t.trigger, t.to]));
    expect(table.sort()).toEqual(EXPECTED.map(([from, trigger, to]) => [from, trigger, to]).sort());
  });

  it.each(EXPECTED)('%s --%s--> %s', (from, trigger, to, slot) => {
    expect(nextStatus(from, trigger)).toBe(to);
    const held = holdsSlot(from);
    const after = to === 'removed' ? false : holdsSlot(to);
    if (slot === 'acquires') expect([held, after]).toEqual([false, true]);
    if (slot === 'keeps') expect([held, after]).toEqual([true, true]);
    if (slot === 'releases' && held) expect(after).toBe(false);
    if (slot === null) expect(held || after).toBe(false);
  });

  const allowed = new Set(EXPECTED.map(([from, trigger]) => `${from}:${trigger}`));
  const forbidden = STATUSES.flatMap((s) => TRIGGERS.map((t) => [s, t] as const)).filter(([s, t]) => !allowed.has(`${s}:${t}`));

  it.each(forbidden)('refuses %s --%s', (from, trigger) => {
    expect(() => nextStatus(from, trigger)).toThrow(ItemStateError);
    try {
      nextStatus(from, trigger);
    } catch (err) {
      expect((err as ItemStateError).code).toBe('invalid-state');
    }
  });

  it('holds a slot only in running and needs-input', () => {
    expect(STATUSES.filter(holdsSlot)).toEqual(['running', 'needs-input']);
  });
});

describe('backlog', () => {
  let dir: string;
  let events: DaemonEvent[];
  let backlog: Backlog;
  let now = 1_000;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-items-'));
    events = [];
    backlog = new Backlog({ store: itemsStore(dir), emit: (ev) => events.push(ev), now: () => now++ });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const make = (title: string, agent: string | null = null, position?: Parameters<Backlog['create']>[0]['position']) =>
    backlog.create({ title, body: '', agent, repo: null, createdBy: 'user', position });

  it('numbers items W-1, W-2… and queues only assigned ones', () => {
    const a = make('First');
    const b = make('Second', 'implementer');
    expect([a.number, a.status, b.number, b.status]).toEqual([1, 'backlog', 2, 'queued']);
    expect(backlog.find('W-2')?.id).toBe(b.id);
    expect(backlog.find('w-1')?.id).toBe(a.id);
    expect(backlog.find(b.id)?.number).toBe(2);
    expect(backlog.find('W-9')).toBeNull();
    expect(events.filter((e) => e.kind === 'item.upsert')).toHaveLength(2);
  });

  it('places items top, bottom, before and after, and moves them', () => {
    const a = make('A');
    const b = make('B', null, 'top');
    const c = make('C', null, { after: b.id });
    const d = make('D', null, { before: a.id });
    expect(backlog.list().map((i) => i.title)).toEqual(['B', 'C', 'D', 'A']);
    expect(backlog.move(a, 'top')).toEqual([a.id, b.id, c.id, d.id]);
    expect(backlog.move(a, { after: d.id })).toEqual([b.id, c.id, d.id, a.id]);
    expect(backlog.positionOf(d.id)).toBe(3);
    expect(events.at(-1)).toEqual({ kind: 'backlog.order', order: [b.id, c.id, d.id, a.id] });
    expect(() => make('E', null, { before: 'itm_01J0000000000000000000000Z' })).toThrow(ItemStateError);
    expect(backlog.list()).toHaveLength(4);
  });

  it('persists through a reload, never reusing a number, and removes on delete', () => {
    const a = make('A');
    make('B');
    backlog.transition(a, 'delete');
    expect(events.some((e) => e.kind === 'item.removed' && e.itemId === a.id)).toBe(true);
    const reloaded = new Backlog({ store: itemsStore(dir), emit: () => undefined });
    expect(reloaded.list().map((i) => i.title)).toEqual(['B']);
    expect(reloaded.create({ title: 'C', body: '', agent: null, repo: null, createdBy: 'orchestrator' }).number).toBe(3);
  });

  it('refuses a transition the table does not allow and leaves the item alone', () => {
    const a = make('A');
    expect(() => backlog.transition(a, 'accept')).toThrow(/Cannot accept an item that is backlog/);
    expect(backlog.get(a.id)?.status).toBe('backlog');
  });

  it('keeps daemon-only fields out of what clients see', () => {
    const a = make('A', 'implementer');
    backlog.transition(a, 'dispatch', { requeue: null, pushedSha: 'f'.repeat(40) });
    const seen = publicItem(a) as unknown as Record<string, unknown>;
    expect(seen.requeue).toBeUndefined();
    expect(seen.pushedSha).toBeUndefined();
    expect(seen.status).toBe('running');
  });
});
