import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonEvent } from '../../src/harness/daemon-protocol';
import { Backlog, ItemStateError, nextStatus, publicItem, TRANSITIONS } from '../../src/daemon/items';
import * as shared from '../../src/harness/item-transitions';
import { itemsStore } from '../../src/daemon/store/items';

describe('state machine source', () => {
  it('is the shared table, not a daemon copy', () => {
    expect(TRANSITIONS).toBe(shared.TRANSITIONS);
    expect(nextStatus).toBe(shared.nextStatus);
    expect(ItemStateError).toBe(shared.ItemStateError);
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
    expect(() => backlog.transition(a, 'finish')).toThrow(/Cannot finish an item that is backlog/);
    expect(backlog.get(a.id)?.status).toBe('backlog');
  });

  it('does not write back an item that was already deleted', () => {
    const a = make('A');
    backlog.transition(a, 'delete');
    const before = events.length;
    backlog.patch(a, { title: 'zombie', acceptNote: 'back' });
    expect(events.slice(before)).toEqual([]);
    expect(backlog.get(a.id)).toBeNull();
    expect(backlog.list()).toEqual([]);
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
