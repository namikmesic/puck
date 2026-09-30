import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemStateError, nextTicket, TICKET_TRANSITIONS, type Backlog } from '../../src/daemon/items';
import * as shared from '../../src/harness/item-transitions';
import { deliveryStack, type Stack } from './daemon-fakes';

describe('state machine source', () => {
  it('is the shared table, not a daemon copy', () => {
    expect(TICKET_TRANSITIONS).toBe(shared.TICKET_TRANSITIONS);
    expect(nextTicket).toBe(shared.nextTicket);
    expect(ItemStateError).toBe(shared.ItemStateError);
  });
});

describe('backlog', () => {
  let dir: string;
  let stack: Stack;
  let backlog: Backlog;
  let now = 1_000;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-items-'));
    stack = deliveryStack(dir, { now: () => now++ });
    backlog = stack.backlog;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const make = (title: string, agent: string | null = null, position?: Parameters<Backlog['create']>[1]['position']) => {
    const tx = stack.workflow.begin('item.create');
    const item = backlog.create(tx, { title, body: '', agent, repo: null, createdBy: 'user', position });
    stack.workflow.commit(tx);
    return backlog.get(item.id) as NonNullable<ReturnType<Backlog['get']>>;
  };

  it('numbers tickets W-1, W-2…, all in Todo', () => {
    const a = make('First');
    const b = make('Second', 'implementer');
    expect([a.number, a.status, b.number, b.status]).toEqual([1, 'todo', 2, 'todo']);
    expect(backlog.find('W-2')?.id).toBe(b.id);
    expect(backlog.find('w-1')?.id).toBe(a.id);
    expect(backlog.find(b.id)?.number).toBe(2);
    expect(backlog.find('W-9')).toBeNull();
    expect(stack.events.filter((e) => e.kind === 'item.upsert')).toHaveLength(2);
  });

  it('places tickets top, bottom, before and after, and moves them', () => {
    const a = make('A');
    const b = make('B', null, 'top');
    const c = make('C', null, { after: b.id });
    const d = make('D', null, { before: a.id });
    expect(backlog.list().map((i) => i.title)).toEqual(['B', 'C', 'D', 'A']);
    const move = (item: typeof a, position: Parameters<Backlog['move']>[2]): string[] => {
      const tx = stack.workflow.begin('item.move');
      backlog.move(tx, item, position);
      stack.workflow.commit(tx);
      return backlog.order();
    };
    expect(move(a, 'top')).toEqual([a.id, b.id, c.id, d.id]);
    expect(move(a, { after: d.id })).toEqual([b.id, c.id, d.id, a.id]);
    expect(backlog.positionOf(d.id)).toBe(3);
    expect(stack.events.at(-1)).toEqual({ kind: 'backlog.order', order: [b.id, c.id, d.id, a.id] });
    expect(() => make('E', null, { before: 'itm_01J0000000000000000000000Z' })).toThrow(ItemStateError);
    expect(backlog.list()).toHaveLength(4);
  });

  it('persists through a reload, never reusing a number, and keeps a tombstone on delete', () => {
    const a = make('A');
    make('B');
    const tx = stack.workflow.begin('item.delete');
    backlog.remove(tx, a);
    stack.workflow.commit(tx);
    expect(stack.events.some((e) => e.kind === 'item.removed' && e.itemId === a.id)).toBe(true);
    expect(stack.events.some((e) => e.kind === 'ticket.removed' && e.itemId === a.id)).toBe(true);
    expect(stack.tables.get().tickets[a.id]?.removed).toBe(true);
    stack.journal.close();
    const reloaded = deliveryStack(dir);
    expect(reloaded.backlog.list().map((i) => i.title)).toEqual(['B']);
    const tx2 = reloaded.workflow.begin('item.create');
    expect(reloaded.backlog.create(tx2, { title: 'C', body: '', agent: null, repo: null, createdBy: 'orchestrator' }).number).toBe(3);
  });

  it('keeps daemon-only fields out of what clients see', () => {
    const a = make('A', 'implementer');
    const tx = stack.workflow.begin('patch');
    tx.push({ kind: 'ticket.patch', itemId: a.id, change: { requeue: 'restart', pushedSha: 'f'.repeat(40) } });
    stack.workflow.commit(tx);
    const seen = stack.pub(a) as unknown as Record<string, unknown>;
    for (const key of ['requeue', 'pushedSha', 'legacyStatus', 'workflowId', 'asks', 'recordFormat']) expect(seen[key], key).toBeUndefined();
    expect(seen.status).toBe('todo');
  });
});
