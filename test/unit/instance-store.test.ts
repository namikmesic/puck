/**
 * The instance store applies daemon events once and in seq order, resyncs
 * from snapshots, and keeps what the panes read: items in backlog order,
 * sessions, capacity, open questions and live turn buffers.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '../../src/harness/daemon-protocol';
import { createInstanceStore, placeInOrder, recordLive, type StoreChange } from '../../src/renderer/instance-store';
import { ENV, ENV2, instance, item, ORCH, session, snap, WORKER } from './v2-fixtures';

function setup() {
  const requestResync = vi.fn();
  const store = createInstanceStore({ requestResync });
  const changes: StoreChange[] = [];
  store.subscribe((c) => changes.push(c));
  store.reset(ENV);
  return { store, requestResync, changes };
}

const upsert = (n: number, over = {}): DaemonEvent => ({ kind: 'item.upsert', item: item({ number: n, ...over }) });

describe('instance store', () => {
  it('holds events that arrive before the snapshot and applies the ones after its head', () => {
    const { store, changes } = setup();
    store.applyEvent(10, upsert(1), ENV);
    store.applyEvent(11, upsert(2), ENV);
    expect(store.items()).toEqual([]);
    store.applySnapshot(snap({ head: 10, items: [item({ number: 1 })], order: ['itm_1'] }), ENV);
    expect(store.cursor()).toBe(11);
    expect(store.items().map((i) => i.number)).toEqual([1, 2]);
    expect(changes.filter((c) => c.kind === 'event').map((c) => (c as { seq: number }).seq)).toEqual([11]);
  });

  it('skips duplicates, waits for missing seqs, and asks for a resync once per gap', () => {
    const { store, requestResync } = setup();
    store.applySnapshot(snap({ head: 5 }), ENV);
    store.applyEvent(5, upsert(9), ENV); // a replay overlap
    expect(store.items()).toEqual([]);
    store.applyEvent(7, upsert(2), ENV);
    expect(requestResync).toHaveBeenCalledTimes(1);
    store.applyEvent(8, upsert(3), ENV);
    expect(requestResync).toHaveBeenCalledTimes(1);
    store.applyEvent(6, upsert(1), ENV); // the gap closes
    expect(store.cursor()).toBe(8);
    expect(store.items().map((i) => i.number)).toEqual([1, 2, 3]);
  });

  it('ignores events and snapshots for another environment', () => {
    const { store } = setup();
    store.applySnapshot(snap({ head: 1, envId: ENV2 }), ENV2);
    expect(store.hasSnapshot()).toBe(false);
    store.applySnapshot(snap({ head: 1 }), ENV);
    store.applyEvent(2, upsert(1), ENV2);
    expect(store.items()).toEqual([]);
  });

  it('keeps backlog order, reorders optimistically, and reconciles from backlog.order', () => {
    const { store, changes } = setup();
    store.applySnapshot(
      snap({ head: 1, items: [item({ number: 1 }), item({ number: 2 }), item({ number: 3 })], order: ['itm_2', 'itm_1'] }),
      ENV,
    );
    // Items the order does not list follow by number.
    expect(store.items().map((i) => i.number)).toEqual([2, 1, 3]);
    store.moveLocal('itm_3', 'top');
    expect(store.items().map((i) => i.number)).toEqual([3, 2, 1]);
    expect(changes.at(-1)).toEqual({ kind: 'order', envId: ENV });
    store.applyEvent(2, { kind: 'backlog.order', order: ['itm_1', 'itm_2', 'itm_3'] }, ENV);
    expect(store.order()).toEqual(['itm_1', 'itm_2', 'itm_3']);
    store.applyEvent(3, { kind: 'item.removed', itemId: 'itm_2' }, ENV);
    expect(store.items().map((i) => i.number)).toEqual([1, 3]);
    expect(store.findItem('W-3')?.id).toBe('itm_3');
    expect(store.findItem('itm_1')?.number).toBe(1);
  });

  it('places items like the daemon does', () => {
    expect(placeInOrder(['a', 'b', 'c'], 'c', { before: 'a' })).toEqual(['c', 'a', 'b']);
    expect(placeInOrder(['a', 'b', 'c'], 'a', { after: 'c' })).toEqual(['b', 'c', 'a']);
    expect(placeInOrder(['a', 'b'], 'a', { before: 'zz' })).toEqual(['b', 'a']);
    expect(placeInOrder(['a', 'b'], 'b', 'top')).toEqual(['b', 'a']);
  });

  it('tracks live turns, their latest tool and open questions', () => {
    const { store } = setup();
    store.applySnapshot(snap({ head: 0, sessions: [session(), session({ id: WORKER, kind: 'worker', agent: 'implementer' })] }), ENV);
    const ev = (seq: number, e: DaemonEvent) => store.applyEvent(seq, e, ENV);
    ev(1, { kind: 'turn.start', sessionId: WORKER, turnId: 't1' });
    ev(2, { kind: 'turn.event', sessionId: WORKER, turnId: 't1', event: { kind: 'text-delta', text: 'Hel' } });
    ev(3, { kind: 'turn.event', sessionId: WORKER, turnId: 't1', event: { kind: 'text-delta', text: 'lo' } });
    ev(4, { kind: 'turn.event', sessionId: WORKER, turnId: 't1', event: { kind: 'thinking', active: true } });
    ev(5, {
      kind: 'turn.event',
      sessionId: WORKER,
      turnId: 't1',
      event: { kind: 'tool-start', toolId: 'x', tool: 'Bash', summary: 'npm test', input: '' },
    });
    expect(store.inflight('t1')?.events).toEqual([
      { kind: 'text-delta', text: 'Hello' },
      { kind: 'tool-start', toolId: 'x', tool: 'Bash', summary: 'npm test', input: '' },
    ]);
    expect(store.lastTool(WORKER)).toBe('Bash · npm test');
    ev(6, {
      kind: 'turn.event',
      sessionId: WORKER,
      turnId: 't1',
      event: { kind: 'ask', askId: 'a1', questions: [{ question: 'Q?', header: '', options: [], multiSelect: false }] },
    });
    expect(store.ask('a1')?.routedTo).toBe('orchestrator');
    ev(7, { kind: 'ask.routed', sessionId: WORKER, askId: 'a1', to: 'user' });
    expect(store.asksFor(WORKER).map((a) => a.routedTo)).toEqual(['user']);
    ev(8, { kind: 'turn.end', sessionId: WORKER, turnId: 't1', stats: { inputTokens: 1, outputTokens: 1, durationMs: 1 } });
    expect(store.inflight('t1')).toBeUndefined();
    expect(store.lastTool(WORKER)).toBeNull();
    expect(store.ask('a1')).toBeUndefined();
  });

  it('seeds live turns from the snapshot and follows sessions, capacity and status', () => {
    const { store } = setup();
    store.applySnapshot(
      snap({
        head: 3,
        inflight: [
          {
            sessionId: ORCH,
            turnId: 't9',
            startedAt: 1,
            events: [{ kind: 'tool-start', toolId: 'y', tool: 'Read', summary: 'README.md', input: '' }],
          },
        ],
      }),
      ENV,
    );
    expect(store.lastTool(ORCH)).toBe('Read · README.md');
    expect(store.orchestrator()?.agent).toBe('lead');
    store.applyEvent(4, { kind: 'capacity', agents: { implementer: { running: 1, max: 2 } }, workers: { running: 1, max: 4 }, paused: true }, ENV);
    expect(store.capacity().paused).toBe(true);
    store.applyEvent(5, { kind: 'instance.status', status: 'degraded', detail: 'x' }, ENV);
    expect(store.state()?.instance.status).toBe('degraded');
    expect(store.state()?.instance.pin?.name).toBe('v1.0.0');
    store.applyEvent(6, { kind: 'session.upsert', session: session({ id: 'ses_new', createdAt: 5 }) }, ENV);
    expect(store.state()?.orchestratorSessionId).toBe('ses_new');
    expect(store.closedOrchestrators().map((s) => s.id)).toEqual([ORCH]);
    store.applyEvent(7, { kind: 'github.auth', state: 'revoked' }, ENV);
    expect(store.state()?.github.state).toBe('revoked');
  });

  it('refreshes repositories from a definition event and keeps them when repos are omitted', () => {
    const { store } = setup();
    store.applySnapshot(snap({ head: 1, repos: [{ github: 'octo/web', dir: 'web' }] }), ENV);
    const pin = { kind: 'branch' as const, name: 'main', sha: 'b'.repeat(40) };
    store.applyEvent(2, { kind: 'instance.definition', sha: pin.sha, pin, classes: ['hot'] }, ENV);
    expect(store.state()?.repos).toEqual([{ github: 'octo/web', dir: 'web' }]);
    store.applyEvent(
      3,
      {
        kind: 'instance.definition',
        sha: pin.sha,
        pin,
        classes: ['reprovision'],
        repos: [
          { github: 'octo/web', dir: 'web' },
          { github: 'octo/api', dir: 'api' },
        ],
      },
      ENV,
    );
    expect(store.state()?.repos).toEqual([
      { github: 'octo/web', dir: 'web' },
      { github: 'octo/api', dir: 'api' },
    ]);
  });

  it('keeps the instance list and resets the daemon state on switch', () => {
    const { store, changes } = setup();
    store.setInstances([instance({ id: ENV2, name: 'zeta' }), instance()]);
    expect(store.instances().map((i) => i.name)).toEqual(['example', 'zeta']);
    store.applySnapshot(snap({ head: 1, items: [item()] }), ENV);
    store.reset(ENV2);
    expect(store.items()).toEqual([]);
    expect(store.cursor()).toBeNull();
    expect(changes.at(-1)).toEqual({ kind: 'reset', envId: ENV2 });
    store.removeInstance(ENV2);
    expect(store.instance(ENV2)).toBeUndefined();
  });

  it('merges text deltas per parent', () => {
    const events: Parameters<typeof recordLive>[0] = [];
    recordLive(events, { kind: 'text-delta', text: 'a' });
    recordLive(events, { kind: 'text-delta', text: 'b', parentId: 'p' });
    recordLive(events, { kind: 'text-delta', text: 'c', parentId: 'p' });
    expect(events).toEqual([
      { kind: 'text-delta', text: 'a' },
      { kind: 'text-delta', text: 'bc', parentId: 'p' },
    ]);
  });
});
