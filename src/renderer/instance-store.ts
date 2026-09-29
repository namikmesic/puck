/**
 * The renderer's projection of environments: every instance the app knows
 * (the Puck server's index plus what this app is doing to it), and the
 * daemon state of the one environment on screen.
 *
 * - Daemon events apply once, in seq order. An event at or below the cursor
 *   is a replay overlap and is skipped. Events that arrive before the first
 *   snapshot, or ahead of a missing seq, wait in a buffer; a gap that the
 *   buffer cannot close asks the owner for a resync (once per cursor).
 * - A snapshot replaces everything and moves the cursor to its head;
 *   buffered events after the head then apply on top.
 * - Kept: items, backlog order, sessions, capacity, instance status, GitHub
 *   state, open questions, and live turn buffers (the recorded dialect of
 *   every turn still running, so a thread opened mid-turn and the work pane's
 *   "latest tool" line need no history read).
 * - Transcripts are not kept here: session-view pages them.
 *
 * No DOM; listeners hear what changed.
 */

import type { InstanceInfo } from '../harness/bridge';
import type {
  Capacity,
  DaemonEvent,
  GithubAuth,
  InflightTurn,
  InstanceState,
  ItemPosition,
  OpenAsk,
  Pin,
  SessionSummary,
  Snapshot,
  WorkItem,
} from '../harness/daemon-protocol';
import type { HarnessEvent } from '../harness/types';

export type StoreChange =
  | { kind: 'instances' }
  | { kind: 'reset'; envId: string | null }
  | { kind: 'snapshot'; envId: string }
  /** An optimistic local reorder, before the daemon confirms it. */
  | { kind: 'order'; envId: string }
  | { kind: 'event'; envId: string; seq: number; ev: DaemonEvent };

export interface EnvDaemonState {
  envId: string;
  name: string;
  daemon: Snapshot['daemon'];
  instance: InstanceState & { pin: Pin | null; sha: string | null };
  github: GithubAuth;
  orchestratorSessionId: string | null;
  capacity: Capacity;
  /** Set by `daemon.upgrading` until the next snapshot. */
  upgrading: 'drain' | 'now' | null;
}

export interface InstanceStoreOptions {
  /** The buffer cannot close a gap in seq: fetch a snapshot (the owner calls applySnapshot). */
  requestResync(envId: string): void;
}

const EMPTY_CAPACITY: Capacity = { agents: {}, workers: { running: 0, max: 0 }, paused: false };

/** Consecutive text deltas with the same parentId merge, and `thinking` is dropped. */
export function recordLive(events: HarnessEvent[], event: HarnessEvent): void {
  if (event.kind === 'thinking') return;
  const prev = events[events.length - 1];
  if (event.kind === 'text-delta' && prev?.kind === 'text-delta' && prev.parentId === event.parentId) {
    events[events.length - 1] = { ...prev, text: prev.text + event.text };
    return;
  }
  events.push(event);
}

/** Apply a position to an order the way the daemon does (unknown anchors go to the bottom). */
export function placeInOrder(order: readonly string[], itemId: string, position: ItemPosition): string[] {
  const next = order.filter((id) => id !== itemId);
  let at: number;
  if (position === 'top') at = 0;
  else if (position === 'bottom') at = next.length;
  else if ('before' in position) {
    const i = next.indexOf(position.before);
    at = i < 0 ? next.length : i;
  } else {
    const i = next.indexOf(position.after);
    at = i < 0 ? next.length : i + 1;
  }
  next.splice(at, 0, itemId);
  return next;
}

export function createInstanceStore(opts: InstanceStoreOptions) {
  const instances = new Map<string, InstanceInfo>();
  const listeners: ((change: StoreChange) => void)[] = [];

  let envId: string | null = null;
  let cursor: number | null = null;
  let resyncAsked: number | null | undefined;
  const buffered = new Map<number, DaemonEvent>();

  let state: EnvDaemonState | null = null;
  const items = new Map<string, WorkItem>();
  let order: string[] = [];
  const sessions = new Map<string, SessionSummary>();
  const asks = new Map<string, OpenAsk>();
  const inflight = new Map<string, InflightTurn>();
  /** The latest tool summary per session while its turn runs. */
  const lastTool = new Map<string, string>();

  function emit(change: StoreChange): void {
    for (const cb of listeners) cb(change);
  }

  function clearDaemon(): void {
    state = null;
    items.clear();
    order = [];
    sessions.clear();
    asks.clear();
    inflight.clear();
    lastTool.clear();
  }

  function applyOne(ev: DaemonEvent): void {
    if (!state) return;
    switch (ev.kind) {
      case 'instance.status':
        state.instance = { ...state.instance, status: ev.status, stage: ev.stage, detail: ev.detail, error: ev.error };
        break;
      case 'instance.definition':
        state.instance = { ...state.instance, pin: ev.pin, sha: ev.sha };
        break;
      case 'github.auth':
        state.github = { state: ev.state, login: ev.login, expiresAt: ev.expiresAt };
        break;
      case 'session.upsert':
        sessions.set(ev.session.id, ev.session);
        if (ev.session.kind === 'orchestrator' && ev.session.status !== 'closed') state.orchestratorSessionId = ev.session.id;
        break;
      case 'turn.start':
        inflight.set(ev.turnId, { sessionId: ev.sessionId, turnId: ev.turnId, startedAt: Date.now(), events: [] });
        lastTool.delete(ev.sessionId);
        break;
      case 'turn.event': {
        const turn = inflight.get(ev.turnId);
        if (turn) recordLive(turn.events, ev.event);
        if (ev.event.kind === 'tool-start' && !ev.event.parentId) {
          lastTool.set(ev.sessionId, ev.event.summary ? `${ev.event.tool} · ${ev.event.summary}` : ev.event.tool);
        }
        if (ev.event.kind === 'ask') {
          const prev = asks.get(ev.event.askId);
          asks.set(ev.event.askId, {
            sessionId: ev.sessionId,
            turnId: ev.turnId,
            askId: ev.event.askId,
            questions: ev.event.questions,
            routedTo: prev?.routedTo ?? (ev.sessionId === state.orchestratorSessionId ? 'user' : 'orchestrator'),
            note: ev.event.note,
          });
        }
        break;
      }
      case 'turn.end':
        inflight.delete(ev.turnId);
        lastTool.delete(ev.sessionId);
        for (const [askId, ask] of asks) if (ask.turnId === ev.turnId) asks.delete(askId);
        break;
      case 'ask.routed': {
        const ask = asks.get(ev.askId);
        if (ask) asks.set(ev.askId, { ...ask, routedTo: ev.to });
        break;
      }
      case 'ask.closed':
        asks.delete(ev.askId);
        break;
      case 'item.upsert':
        items.set(ev.item.id, ev.item);
        if (!order.includes(ev.item.id)) order = [...order, ev.item.id];
        break;
      case 'item.removed':
        items.delete(ev.itemId);
        order = order.filter((id) => id !== ev.itemId);
        break;
      case 'backlog.order':
        order = ev.order.slice();
        break;
      case 'capacity':
        state.capacity = { agents: ev.agents, workers: ev.workers, paused: ev.paused };
        break;
      case 'daemon.upgrading':
        state.upgrading = ev.mode;
        break;
      case 'turn.user':
      case 'turn.notice':
        break;
    }
  }

  function drain(): void {
    if (envId === null || cursor === null) return;
    while (buffered.has(cursor + 1)) {
      const seq: number = cursor + 1;
      const ev = buffered.get(seq) as DaemonEvent;
      buffered.delete(seq);
      cursor = seq;
      applyOne(ev);
      emit({ kind: 'event', envId, seq, ev });
    }
    for (const seq of [...buffered.keys()]) if (seq <= cursor) buffered.delete(seq);
    if (buffered.size && resyncAsked !== cursor) {
      resyncAsked = cursor;
      opts.requestResync(envId);
    }
  }

  const store = {
    subscribe(cb: (change: StoreChange) => void): () => void {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    /* ---------- Instances ---------- */

    setInstances(list: readonly InstanceInfo[]): void {
      instances.clear();
      for (const info of list) instances.set(info.id, info);
      emit({ kind: 'instances' });
    },
    upsertInstance(info: InstanceInfo): void {
      instances.set(info.id, info);
      emit({ kind: 'instances' });
    },
    removeInstance(id: string): void {
      instances.delete(id);
      emit({ kind: 'instances' });
    },
    instances(): InstanceInfo[] {
      return [...instances.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },
    instance(id: string): InstanceInfo | undefined {
      return instances.get(id);
    },

    /* ---------- The environment on screen ---------- */

    /** Switch to another environment (or none): its daemon state starts empty until a snapshot. */
    reset(next: string | null): void {
      envId = next;
      cursor = null;
      resyncAsked = undefined;
      buffered.clear();
      clearDaemon();
      emit({ kind: 'reset', envId: next });
    },
    envId: (): string | null => envId,
    cursor: (): number | null => cursor,
    hasSnapshot: (): boolean => state !== null,

    applySnapshot(snapshot: Snapshot, forEnv: string): void {
      if (forEnv !== envId) return;
      clearDaemon();
      state = {
        envId: forEnv,
        name: snapshot.name,
        daemon: snapshot.daemon,
        instance: { ...snapshot.instance },
        github: { ...snapshot.github },
        orchestratorSessionId: snapshot.orchestratorSessionId,
        capacity: snapshot.capacity ?? EMPTY_CAPACITY,
        upgrading: null,
      };
      for (const item of snapshot.items) items.set(item.id, item);
      order = snapshot.order.slice();
      for (const s of snapshot.sessions) sessions.set(s.id, s);
      for (const ask of snapshot.asks) asks.set(ask.askId, ask);
      for (const turn of snapshot.inflight) {
        const events: HarnessEvent[] = [];
        for (const e of turn.events) recordLive(events, e);
        inflight.set(turn.turnId, { ...turn, events });
        for (let i = turn.events.length - 1; i >= 0; i--) {
          const e = turn.events[i];
          if (e?.kind === 'tool-start' && !e.parentId) {
            lastTool.set(turn.sessionId, e.summary ? `${e.tool} · ${e.summary}` : e.tool);
            break;
          }
        }
      }
      cursor = snapshot.head;
      resyncAsked = undefined;
      emit({ kind: 'snapshot', envId: forEnv });
      drain();
    },

    applyEvent(seq: number, ev: DaemonEvent, forEnv: string): void {
      if (forEnv !== envId) return;
      if (cursor !== null && seq <= cursor) return;
      buffered.set(seq, ev);
      drain();
    },

    state: (): EnvDaemonState | null => state,
    item: (id: string): WorkItem | undefined => items.get(id),
    /** `W-12`, `12` or an item id. */
    findItem(ref: string): WorkItem | undefined {
      const m = /^(?:W-)?(\d{1,9})$/i.exec(ref.trim());
      if (m) return [...items.values()].find((i) => i.number === Number(m[1]));
      return items.get(ref.trim());
    },
    /** Every item, in backlog order (items the order does not list follow by number). */
    items(): WorkItem[] {
      const rank = new Map(order.map((id, i) => [id, i]));
      return [...items.values()].sort((a, b) => {
        const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        return ra - rb || a.number - b.number;
      });
    },
    order: (): string[] => order.slice(),
    /** Optimistic reorder; the daemon's `backlog.order` reconciles it. */
    moveLocal(itemId: string, position: ItemPosition): void {
      if (!items.has(itemId)) return;
      order = placeInOrder(order.includes(itemId) ? order : [...order, itemId], itemId, position);
      if (envId) emit({ kind: 'order', envId });
    },
    sessions: (): SessionSummary[] => [...sessions.values()],
    session: (id: string): SessionSummary | undefined => sessions.get(id),
    orchestrator(): SessionSummary | undefined {
      const id = state?.orchestratorSessionId;
      return id ? sessions.get(id) : undefined;
    },
    /** Replaced orchestrator sessions, newest first. */
    closedOrchestrators(): SessionSummary[] {
      return [...sessions.values()]
        .filter((s) => s.kind === 'orchestrator' && s.id !== state?.orchestratorSessionId)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    capacity: (): Capacity => state?.capacity ?? EMPTY_CAPACITY,
    asks: (): OpenAsk[] => [...asks.values()],
    ask: (askId: string): OpenAsk | undefined => asks.get(askId),
    asksFor: (sessionId: string): OpenAsk[] => [...asks.values()].filter((a) => a.sessionId === sessionId),
    inflight: (turnId: string): InflightTurn | undefined => inflight.get(turnId),
    inflightFor: (sessionId: string): InflightTurn[] => [...inflight.values()].filter((t) => t.sessionId === sessionId),
    lastTool: (sessionId: string): string | null => lastTool.get(sessionId) ?? null,
  };
  return store;
}

export type InstanceStore = ReturnType<typeof createInstanceStore>;
