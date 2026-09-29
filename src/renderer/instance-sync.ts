/**
 * Keeps the instance store in step with the bridge: the instance list,
 * the pushed instance events, and the daemon events and snapshots of the
 * environment on screen.
 *
 * Opening an environment asks main to attach and returns at once; the
 * snapshot is read as soon as the attach is up (right away when main is
 * already attached, else on the `attached` instance event), and again
 * whenever the store finds a gap in seq. A read that fails while already
 * attached, before any snapshot has landed, is a retriable banner;
 * opening the environment again reads the snapshot once more. Nothing
 * waits on the attach: an attach that ends unreachable, incompatible or
 * detached is state the window shows (`attachView`), and reopening tries
 * again. Context in, controller out.
 */

import type { AttachState, InstanceInfo, PuckBridge } from '../harness/bridge';
import type { InstanceStore } from './instance-store';
import { errText } from './util';

export type AttachPhase =
  | 'none'
  | 'connecting'
  | 'loading'
  | 'ready'
  | 'reconnecting'
  | 'unreachable'
  | 'incompatible'
  | 'detached'
  | 'lost'
  | 'snapshot-failed';

export interface AttachView {
  phase: AttachPhase;
  /** One sentence for the banner above the chat; empty while ready. */
  text: string;
  /** Show a Reconnect action. */
  retry: boolean;
}

export interface InstanceSyncContext {
  bridge: PuckBridge;
  store: InstanceStore;
  /** A failure worth a line on screen ('' clears it). */
  say(text: string): void;
  /** The attach view changed. */
  onAttach?(view: AttachView): void;
}

/** What the window shows about its connection to an environment. */
export function attachViewOf(info: InstanceInfo | undefined, hasSnapshot: boolean): AttachView {
  if (!info) return { phase: 'none', text: '', retry: false };
  const where = info.runnerName || 'its runner';
  if (info.status === 'lost') {
    return { phase: 'lost', text: `${where === 'a removed runner' ? 'Its runner' : where} was removed from Puck. Forget this environment in the switcher.`, retry: false };
  }
  if (info.status === 'orphaned') {
    return { phase: 'lost', text: 'Its runner was removed; the environment was kept on that machine.', retry: false };
  }
  const attach: AttachState | null = info.attach;
  switch (attach) {
    case 'attached':
      return hasSnapshot ? { phase: 'ready', text: '', retry: false } : { phase: 'loading', text: 'Loading the environment…', retry: false };
    case 'connecting':
    case null:
      return { phase: 'connecting', text: `Connecting to ${where}…`, retry: false };
    case 'reconnecting':
      return { phase: 'reconnecting', text: `Reconnecting to ${where}…`, retry: false };
    case 'unreachable':
      return {
        phase: 'unreachable',
        text: `Can't reach ${where}. Work continues there; Puck keeps trying.${info.attachDetail ? ` (${info.attachDetail})` : ''}`,
        retry: true,
      };
    case 'incompatible':
      return { phase: 'incompatible', text: info.attachDetail || "This environment's daemon needs a newer Puck.", retry: false };
    case 'detached':
      return { phase: 'detached', text: `Not connected to ${info.name || 'this environment'}.`, retry: true };
  }
}

export function initInstanceSync(ctx: InstanceSyncContext) {
  const { bridge, store } = ctx;
  let gen = 0;
  let flight: { envId: string; gen: number; promise: Promise<void>; ticket: object } | null = null;
  let lastView: AttachView | null = null;
  let snapshotError: string | null = null;

  function current(): InstanceInfo | undefined {
    const id = store.envId();
    return id ? store.instance(id) : undefined;
  }

  function view(): AttachView {
    const base = attachViewOf(current(), store.hasSnapshot());
    if (snapshotError && base.phase === 'loading') {
      return { phase: 'snapshot-failed', text: `Couldn't load the environment: ${snapshotError}`, retry: true };
    }
    return base;
  }

  function notify(): void {
    const next = view();
    if (lastView && lastView.phase === next.phase && lastView.text === next.text) return;
    lastView = next;
    ctx.onAttach?.(next);
  }

  /** One snapshot read at a time per environment view; a stale one lands nowhere. */
  function snapshot(envId: string): Promise<void> {
    if (flight && flight.envId === envId && flight.gen === gen) return flight.promise;
    const mine = gen;
    const ticket = {};
    const promise = (async () => {
      try {
        const snap = await bridge.daemon(envId, 'snapshot.get', {});
        if (mine !== gen || store.envId() !== envId) return;
        store.applySnapshot(snap, envId);
        snapshotError = null;
        ctx.say('');
      } catch (err) {
        if (mine !== gen || store.envId() !== envId) return;
        // Not attached (yet): the `attached` instance event brings the next try.
        if (store.instance(envId)?.attach !== 'attached') return;
        if (store.hasSnapshot()) ctx.say(errText(err));
        else {
          snapshotError = errText(err);
          ctx.say('');
        }
      } finally {
        if (flight?.ticket === ticket) flight = null;
        notify();
      }
    })();
    flight = { envId, gen: mine, promise, ticket };
    return promise;
  }

  bridge.onInstanceEvent((event) => {
    if (event.kind === 'removed') {
      store.removeInstance(event.envId);
      if (store.envId() === event.envId) {
        gen++;
        store.reset(null);
      }
      notify();
      return;
    }
    const info = event.instance;
    store.upsertInstance(info);
    // A reattach replays from the cursor main keeps, so the projection only
    // needs a snapshot when it has none yet.
    if (info.id === store.envId() && info.attach === 'attached' && !store.hasSnapshot()) void snapshot(info.id);
    notify();
  });

  bridge.onDaemonEvent((payload) => {
    if (payload.envId !== store.envId()) return;
    if ('snapshot' in payload) store.applySnapshot(payload.snapshot, payload.envId);
    else store.applyEvent(payload.seq, payload.ev, payload.envId);
    notify();
  });

  return {
    view,
    /** The store found a gap in seq. */
    resync(envId: string): void {
      if (store.envId() === envId) void snapshot(envId);
    },
    async load(): Promise<InstanceInfo[]> {
      const list = await bridge.instanceList();
      store.setInstances(list);
      notify();
      return list;
    },
    /**
     * Make an environment current and attach. Resolves once main accepted
     * the open; the snapshot follows the attach, whatever it takes.
     */
    async open(envId: string): Promise<void> {
      gen++;
      flight = null;
      snapshotError = null;
      store.reset(envId);
      notify();
      await bridge.instanceOpen(envId);
      if (store.envId() !== envId) return;
      // Already attached (a reload, or reopening the current one): read now.
      await snapshot(envId);
    },
    /** Show nothing (the last environment was deleted, or first run). */
    close(): void {
      gen++;
      flight = null;
      snapshotError = null;
      store.reset(null);
      notify();
    },
  };
}

export type InstanceSync = ReturnType<typeof initInstanceSync>;
