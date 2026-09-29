/**
 * The instance sync opens environments without waiting on the attach: the
 * snapshot follows an attach, an attach that ends unreachable, incompatible
 * or detached is state the window shows, and pushed events and snapshots
 * land in the store.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../../src/harness/daemon-protocol';
import { createInstanceStore } from '../../src/renderer/instance-store';
import { attachViewOf, initInstanceSync, type AttachView } from '../../src/renderer/instance-sync';
import { ENV, ENV2, fakeBridge, flush, instance, item, snap } from './v2-fixtures';

function setup(daemon?: (envId: string, op: string) => Promise<unknown>) {
  const fake = fakeBridge(daemon ? { daemon: vi.fn(daemon) as never } : {});
  let sync: ReturnType<typeof initInstanceSync> | null = null;
  const store = createInstanceStore({ requestResync: (id) => sync?.resync(id) });
  const views: AttachView[] = [];
  const say = vi.fn();
  sync = initInstanceSync({ bridge: fake.bridge, store, say, onAttach: (v) => views.push(v) });
  return { ...fake, store, sync, views, say };
}

describe('instance sync', () => {
  it('reads the snapshot right after opening when main is already attached', async () => {
    const s = snap({ head: 3, items: [item()] });
    const { sync, store, bridge } = setup(async () => s);
    store.setInstances([instance()]);
    await sync.open(ENV);
    expect(bridge.instanceOpen).toHaveBeenCalledWith(ENV);
    expect(store.items()).toHaveLength(1);
    expect(sync.view().phase).toBe('ready');
  });

  it('waits for the attached event when the first read fails, then loads', async () => {
    let attached = false;
    const { sync, store, instanceEvent } = setup(async () => {
      if (!attached) throw new Error('Open this environment first.');
      return snap({ head: 1 });
    });
    store.setInstances([instance({ attach: 'connecting' })]);
    await sync.open(ENV);
    expect(store.hasSnapshot()).toBe(false);
    expect(sync.view().phase).toBe('connecting');
    attached = true;
    instanceEvent({ kind: 'upsert', instance: instance({ attach: 'attached' }) });
    await flush();
    expect(store.hasSnapshot()).toBe(true);
    expect(sync.view().phase).toBe('ready');
  });

  // Follow-up v2-attach-wait-never-fails: opening an environment whose attach
  // ends unreachable, incompatible or detached shows that state instead of
  // waiting forever.
  it.each([
    ['unreachable', "Can't reach build-box. Work continues there; Puck keeps trying.", true],
    ['incompatible', 'Update Puck to work in it.', false],
    ['detached', 'Not connected to example.', true],
  ] as const)('v2-attach-wait-never-fails: an attach that ends %s is shown and open() returns', async (attach, text, retry) => {
    const { sync, store, instanceEvent, views } = setup(async () => {
      throw new Error('Open this environment first.');
    });
    store.setInstances([instance({ attach: 'connecting' })]);
    const opened = sync.open(ENV);
    await expect(opened).resolves.toBeUndefined();
    instanceEvent({
      kind: 'upsert',
      instance: instance({ attach, attachDetail: attach === 'incompatible' ? 'Update Puck to work in it.' : '' }),
    });
    const view = views.at(-1);
    expect(view?.phase).toBe(attach);
    expect(view?.text).toBe(text);
    expect(view?.retry).toBe(retry);
    // Nothing is left waiting: another environment opens normally.
    await sync.open(ENV2);
    expect(store.envId()).toBe(ENV2);
  });

  it('applies pushed events and snapshots for the environment on screen only', async () => {
    const { sync, store, daemonEvent, daemonSnapshot } = setup(async () => snap({ head: 1 }));
    store.setInstances([instance()]);
    await sync.open(ENV);
    daemonEvent(2, { kind: 'item.upsert', item: item({ number: 4 }) });
    daemonEvent(3, { kind: 'item.upsert', item: item({ number: 5 }) }, ENV2);
    expect(store.items().map((i) => i.number)).toEqual([4]);
    daemonSnapshot(snap({ head: 9, items: [] }));
    expect(store.cursor()).toBe(9);
    expect(store.items()).toEqual([]);
  });

  it('resyncs from a snapshot when the store finds a gap', async () => {
    const reads: Snapshot[] = [snap({ head: 1 }), snap({ head: 5, items: [item({ number: 7 })] })];
    const { sync, store, daemonEvent } = setup(async () => reads.shift() as Snapshot);
    store.setInstances([instance()]);
    await sync.open(ENV);
    daemonEvent(4, { kind: 'item.upsert', item: item({ number: 3 }) });
    await flush();
    expect(store.cursor()).toBe(5);
    expect(store.items().map((i) => i.number)).toEqual([7]);
  });

  it('drops a snapshot that lands after the user switched environments', async () => {
    let release: (s: Snapshot) => void = () => undefined;
    const { sync, store } = setup(() => new Promise((resolve) => (release = resolve as (s: Snapshot) => void)));
    store.setInstances([instance(), instance({ id: ENV2, name: 'docs' })]);
    const first = sync.open(ENV);
    await flush();
    const second = sync.open(ENV2);
    release(snap({ head: 1, items: [item()] }));
    await first;
    expect(store.envId()).toBe(ENV2);
    expect(store.items()).toEqual([]);
    release(snap({ head: 2, envId: ENV2 }));
    await second;
  });

  it('forgets a removed environment and shows nothing', async () => {
    const { sync, store, instanceEvent } = setup(async () => snap());
    store.setInstances([instance()]);
    await sync.open(ENV);
    instanceEvent({ kind: 'removed', envId: ENV });
    expect(store.envId()).toBeNull();
    expect(sync.view().phase).toBe('none');
  });

  it('shows a retriable banner when the snapshot fails while already attached, and opening again reads it', async () => {
    let calls = 0;
    const { sync, store, say } = setup(async () => {
      calls += 1;
      if (calls === 1) throw new Error('snapshot broke');
      return snap({ head: 1, items: [item()] });
    });
    store.setInstances([instance()]);
    await sync.open(ENV);
    expect(store.hasSnapshot()).toBe(false);
    expect(sync.view()).toEqual({ phase: 'snapshot-failed', text: "Couldn't load the environment: snapshot broke", retry: true });
    expect(say).not.toHaveBeenCalledWith('snapshot broke');
    await sync.open(ENV);
    expect(calls).toBe(2);
    expect(store.hasSnapshot()).toBe(true);
    expect(store.items()).toHaveLength(1);
    expect(sync.view().phase).toBe('ready');
  });

  it('toasts a failed resync without replacing a snapshot that already landed', async () => {
    let fail = false;
    const { sync, store, say, daemonEvent } = setup(async () => {
      if (fail) throw new Error('resync broke');
      return snap({ head: 1, items: [item()] });
    });
    store.setInstances([instance()]);
    await sync.open(ENV);
    fail = true;
    daemonEvent(4, { kind: 'item.upsert', item: item({ number: 3 }) });
    await flush();
    expect(say).toHaveBeenCalledWith('resync broke');
    expect(sync.view().phase).toBe('ready');
    expect(store.items()).toHaveLength(1);
  });

  it('names lost and orphaned environments', () => {
    expect(attachViewOf(instance({ status: 'lost', runnerName: 'a removed runner' }), false).text).toMatch(/^Its runner was removed/);
    expect(attachViewOf(instance({ status: 'orphaned' }), false).phase).toBe('lost');
    expect(attachViewOf(instance({ attach: 'reconnecting' }), true).text).toBe('Reconnecting to build-box…');
    expect(attachViewOf(instance({ attach: 'attached' }), false).phase).toBe('loading');
  });
});
