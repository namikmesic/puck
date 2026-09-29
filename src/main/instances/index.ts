/**
 * Environments (instances): starting, attaching, and the lifecycle
 * commands, for environments that run on runners.
 *
 * - The Puck server's index says which environments exist and where
 *   (runners/index.ts keeps it current); this module adds what the app does
 *   to them (`op`), the attached daemon's state, and the replay cursors in
 *   puck-instances.json.
 * - One environment is attached at a time: the current one. Opening
 *   another detaches the old one, which keeps working. Its daemon events go
 *   to the renderer unchanged, in seq order, and the cursor survives quit,
 *   so reopening the app replays from the last event applied.
 * - Operations on one environment run one at a time. Container work is the
 *   runner's (control channel); the app never runs docker.
 */

import type { DaemonEventPayload, InstanceEvent, InstanceInfo, InstanceOp, InstanceUpdate, PinSpec, StartSpec } from '../../harness/bridge';
import type { DaemonEvent, InstanceState, Op, OpArgs, OpResult, RendererOp } from '../../harness/daemon-protocol';
import type { ResolvedEnvironment } from '../../harness/definitions/types';
import type { InstanceStage } from '../../harness/runner-protocol';
import { app } from 'electron';
import { checkDefinitionUpdate, resolveDefinition } from '../config-repo';
import { DAEMON_META, DAEMON_SOURCE } from '../daemon-source';
import { log } from '../log';
import * as providerRegistry from '../providers';
import * as runners from '../runners';
import { LONG_TIMEOUT_MS } from '../runners/control-client';
import * as api from '../server/api';
import { syncOnAttach, type SyncDeps, type SyncHarness } from './credentials-sync';
import { DaemonClient, type AttachState } from './daemon-client';
import { buildArgs, create, harnessesOf, preflight, uploadBundle, type StartDeps } from './start-flow';
import * as store from './store';
import { applyUpdate as applyDefinitionUpdate, checkUpdate as checkDefinition, type UpdateDeps } from './update';

const ops = new Map<string, InstanceOp>();
const daemonState = new Map<string, InstanceState>();
const chains = new Map<string, Promise<unknown>>();
let attached: DaemonClient | null = null;
let attachDetail = '';

type Listener<T> = (payload: T) => void;
const instanceListeners: Listener<InstanceEvent>[] = [];
const daemonListeners: Listener<DaemonEventPayload>[] = [];

export function onInstanceEvent(cb: Listener<InstanceEvent>): void {
  instanceListeners.push(cb);
}

export function onDaemonEvent(cb: Listener<DaemonEventPayload>): void {
  daemonListeners.push(cb);
}

function changed(envId: string): void {
  const info = infoOf(envId);
  const e: InstanceEvent = info ? { kind: 'upsert', instance: info } : { kind: 'removed', envId };
  for (const cb of instanceListeners) cb(e);
}

/** Operations on one environment, one at a time. */
function serial<T>(envId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(envId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  chains.set(envId, next);
  void next
    .finally(() => {
      if (chains.get(envId) === next) chains.delete(envId);
    })
    .catch(() => undefined);
  return next;
}

function setOp(envId: string, op: InstanceOp | null): void {
  if (op) ops.set(envId, op);
  else ops.delete(envId);
  changed(envId);
}

async function withOp<T>(envId: string, kind: InstanceOp['kind'], fn: (stage: (s: InstanceStage, d?: string) => void) => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  setOp(envId, { kind, stage: null, detail: '', startedAt, error: null });
  const stage = (s: InstanceStage, detail = ''): void => setOp(envId, { kind, stage: s, detail, startedAt, error: null });
  try {
    const out = await fn(stage);
    setOp(envId, null);
    return out;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`instance.${kind}-failed`, { envId, error: message.slice(0, 300) });
    setOp(envId, { ...(ops.get(envId) ?? { kind, stage: null, detail: '', startedAt }), error: message });
    throw err;
  }
}

function infoOf(envId: string): InstanceInfo | null {
  const index = runners.serverInstance(envId);
  const cursor = store.cursor(envId);
  const op = ops.get(envId) ?? null;
  if (!index && !op) return null;
  const runnerId = index?.runnerId ?? '';
  const runner = runnerId ? runners.runnerById(runnerId) : undefined;
  const current = store.currentId() === envId;
  return {
    id: envId,
    name: index?.definition ?? '',
    runnerId,
    runnerName: runner?.name ?? (runnerId ? 'a removed runner' : ''),
    local: runnerId ? runners.state().local.runnerId === runnerId : false,
    status: index?.status ?? 'active',
    repos: (index?.repos ?? []).map((r) => `${r.owner}/${r.name}`),
    current,
    attach: current && attached?.envId === envId ? attached.attachState : null,
    attachDetail: current ? attachDetail : '',
    daemon: daemonState.get(envId) ?? null,
    op,
    lastSeq: cursor?.lastSeq ?? null,
  };
}

export function list(): InstanceInfo[] {
  const ids = new Set([...runners.serverInstances().map((i) => i.id), ...ops.keys()]);
  return [...ids].flatMap((id) => infoOf(id) ?? []).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

runners.onInstancesChange((e) => {
  if (e.kind === 'reload') {
    for (const info of list()) for (const cb of instanceListeners) cb({ kind: 'upsert', instance: info });
    return;
  }
  const envId = e.kind === 'upsert' ? e.instance.id : e.envId;
  changed(envId);
});

runners.onRunnerOnline((runnerId) => {
  if (attached && runners.serverInstance(attached.envId)?.runnerId === runnerId) attached.nudge();
});

/* ---------- Harness credentials ---------- */

function syncHarnesses(): SyncHarness[] {
  return providerRegistry.byKind('harness').map((h) => ({
    id: h.id,
    signedIn: () => h.credential.signedIn(),
    fresh: () => h.credential.fresh(),
    adoptIfNewer: (json: string) => h.credential.adoptIfNewer(json),
  }));
}

function syncDeps(client: DaemonClient): SyncDeps {
  return {
    harnesses: syncHarnesses(),
    get: () => client.cmd('credentials.get', {} as OpArgs<'credentials.get'>),
    put: (args) => client.cmd('credentials.put', args),
  };
}

/** Attach-time sync and a live credential delete, one at a time. */
let credentialChain: Promise<unknown> = Promise.resolve();

function credentialOp<T>(fn: () => Promise<T>): Promise<T> {
  const next = credentialChain.catch(() => undefined).then(fn);
  credentialChain = next;
  void next
    .finally(() => {
      if (credentialChain === next) credentialChain = Promise.resolve();
    })
    .catch(() => undefined);
  return next;
}

function syncAttached(client: DaemonClient): Promise<void> {
  return credentialOp(async () => {
    const envId = client.envId;
    const cursor = store.cursor(envId);
    const pending = cursor?.pendingCredentialRemoval ?? [];
    try {
      const { pushed, removed } = await syncOnAttach(syncDeps(client), cursor?.harnesses ?? [], pending);
      if (removed.length) {
        const current = store.cursor(envId)?.pendingCredentialRemoval ?? [];
        store.updateCursor(envId, { pendingCredentialRemoval: current.filter((id) => !removed.includes(id)) });
      }
      if (pushed.length || removed.length) log.info('instance.credentials-synced', { envId, pushed, removed });
    } catch (err) {
      log.warn('instance.credentials-sync-failed', { envId, error: (err as Error).message.slice(0, 200) });
    }
  });
}

/** A harness sign-in landed: the attached environment gets the fresh file (if it uses that harness). */
export async function onHarnessLogin(): Promise<void> {
  const client = attached;
  if (!client || client.attachState !== 'attached') return;
  await syncAttached(client);
}

/**
 * The user signed out of a harness: its file leaves the attached
 * environment now and every other environment on its next attach.
 */
export async function onHarnessLogout(harnessId: string): Promise<void> {
  const client = attached;
  const live = client !== null && client.attachState === 'attached' ? client : null;
  const ids = new Set([...Object.keys(store.allCursors()), ...runners.serverInstances().map((i) => i.id)]);
  if (live) ids.add(live.envId);
  for (const id of ids) {
    const c = store.cursor(id);
    if (!c?.pendingCredentialRemoval.includes(harnessId)) {
      store.updateCursor(id, { pendingCredentialRemoval: [...(c?.pendingCredentialRemoval ?? []), harnessId] });
    }
  }
  if (!live) return;
  await credentialOp(async () => {
    try {
      await live.cmd('credentials.put', { harness: [{ id: harnessId, content: null }] });
      const c = store.cursor(live.envId);
      store.updateCursor(live.envId, { pendingCredentialRemoval: (c?.pendingCredentialRemoval ?? []).filter((id) => id !== harnessId) });
    } catch (err) {
      log.warn('instance.credentials-remove-failed', { envId: live.envId, error: (err as Error).message.slice(0, 200) });
    }
  });
}

/* ---------- Attach ---------- */

function emitDaemon(payload: DaemonEventPayload): void {
  for (const cb of daemonListeners) cb(payload);
}

function track(envId: string, ev: DaemonEvent): void {
  if (ev.kind === 'instance.status') {
    daemonState.set(envId, { status: ev.status, stage: ev.stage, detail: ev.detail, error: ev.error });
    changed(envId);
  } else if (ev.kind === 'instance.definition') {
    store.updateCursor(envId, { pin: ev.pin });
  }
}

function attach(envId: string): void {
  if (attached?.envId === envId) {
    attached.nudge();
    return;
  }
  detach();
  const client = new DaemonClient({
    envId,
    open: async () => {
      const index = runners.serverInstance(envId);
      if (index && index.status !== 'active') {
        throw new Error(index.status === 'lost' ? 'Its runner was removed from Puck.' : 'Its runner was removed; the environment was kept on that machine.');
      }
      // The cursor remembers the runner, so This Mac attaches locally while the server is unreachable.
      const runnerId = index?.runnerId ?? store.cursor(envId)?.runnerId;
      if (!runnerId) throw new Error('The Puck server does not list this environment (yet).');
      if (index && store.cursor(envId)?.runnerId !== index.runnerId) store.updateCursor(envId, { runnerId: index.runnerId });
      return runners.transport(runnerId).open('attach', envId);
    },
    since: () => store.cursor(envId)?.lastSeq ?? null,
    saveSeq: (seq) => store.saveSeq(envId, seq),
    onEvent: (seq, at, ev) => {
      track(envId, ev);
      emitDaemon({ envId, seq, at, ev });
    },
    onSnapshot: (snapshot) => {
      daemonState.set(envId, { status: snapshot.instance.status, stage: snapshot.instance.stage, detail: snapshot.instance.detail, error: snapshot.instance.error });
      if (snapshot.instance.pin) store.updateCursor(envId, { pin: snapshot.instance.pin });
      emitDaemon({ envId, snapshot });
      changed(envId);
    },
    onState: (state: AttachState, detail) => {
      attachDetail = detail;
      if (state === 'attached') {
        store.updateCursor(envId, { lastAttachedAt: Date.now() });
        void syncAttached(client);
      }
      changed(envId);
    },
    client: { app: 'puck', build: app.getVersion() },
  });
  attached = client;
  client.start();
}

function detach(): void {
  const client = attached;
  attached = null;
  attachDetail = '';
  client?.stop();
  if (client) changed(client.envId);
}

/** Attaches to an environment and makes it current. */
export async function open(envId: string): Promise<void> {
  if (!runners.serverInstance(envId) && !ops.has(envId) && !store.cursor(envId)?.runnerId) throw new Error('No such environment.');
  store.setCurrent(envId);
  attach(envId);
}

/** Boot: reattach to the environment the window showed last. */
export function resumeCurrent(): void {
  const id = store.currentId();
  if (id) attach(id);
}

/* ---------- Commands ---------- */

export function daemon<K extends RendererOp>(envId: string, op: K, args: OpArgs<K>): Promise<OpResult<K>> {
  if (!attached || attached.envId !== envId) return Promise.reject(new Error('Open this environment first.'));
  return attached.cmd(op as Op, args) as Promise<OpResult<K>>;
}

function indexOf(envId: string) {
  const index = runners.serverInstance(envId);
  if (!index) throw new Error('No such environment.');
  if (index.status !== 'active') throw new Error('Its runner was removed from Puck; forget the environment instead.');
  return index;
}

const startDeps = (): StartDeps => ({
  resolve: resolveDefinition,
  runner: (id) => {
    const r = runners.state().runners.find((x) => x.id === id);
    return r ? { id: r.id, name: r.name, status: r.status, docker: r.docker, maxEnvironments: r.maxEnvironments, keyChanged: r.keyChanged } : null;
  },
  hosted: (id) => runners.serverInstances().filter((i) => i.runnerId === id && i.status === 'active').length,
  checkTransport: (id) => void runners.transport(id),
  harnessSignedIn: (id) => providerRegistry.harnessById(id)?.credential.signedIn() ?? false,
  harnessLabel: (id) => providerRegistry.harnessById(id)?.label ?? id,
  harnessCredential: async (id) => {
    const fresh = await providerRegistry.harnessById(id)?.credential.fresh();
    return fresh && fresh.current() ? fresh.content : null;
  },
  containerEnv: (id) => ({ ...(providerRegistry.harnessById(id)?.containerEnv ?? {}) }),
  createIndexEntry: async (req) => ({ envId: (await api.createInstance(req)).id }),
  forgetIndexEntry: (envId) => api.forgetInstance(envId),
  control: runners.control,
  daemonBundle: () => ({ source: DAEMON_SOURCE, sha: DAEMON_META.build }),
  onStage: (envId, stage, detail) => {
    const op = ops.get(envId);
    if (op) setOp(envId, { ...op, stage, detail });
  },
  log,
});

/** Starts a new environment (see start-flow.ts) and attaches to it. */
export async function start(spec: StartSpec): Promise<{ envId: string }> {
  const deps = startDeps();
  const plan = await preflight(spec, deps);
  const startedAt = Date.now();
  let envId = '';
  try {
    envId = await create(plan, spec, deps, (id) => {
      envId = id;
      store.updateCursor(id, { runnerId: plan.runnerId, pin: plan.pin, harnesses: plan.harnesses, lastSeq: null });
      setOp(id, { kind: 'starting', stage: null, detail: '', startedAt, error: null });
    });
  } catch (err) {
    if (envId) {
      ops.delete(envId);
      store.removeCursor(envId);
      changed(envId);
    }
    throw err;
  }
  setOp(envId, null);
  await open(envId);
  return { envId };
}

export function stop(envId: string): Promise<void> {
  return serial(envId, () =>
    withOp(envId, 'stopping', async () => {
      const index = indexOf(envId);
      if (attached?.envId === envId) detach();
      await runners.control(index.runnerId, 'instance.stop', { envId }, { timeoutMs: 120_000 });
      daemonState.delete(envId);
    }),
  );
}

export function resume(envId: string): Promise<void> {
  return serial(envId, () =>
    withOp(envId, 'resuming', async () => {
      const index = indexOf(envId);
      await runners.control(index.runnerId, 'instance.start', { envId }, { timeoutMs: 120_000 });
      if (store.currentId() === envId) attach(envId);
    }),
  );
}

/** Recreates the container from `def` (volumes, and so all work, are kept). Runs inside `serial`. */
function rebuildFrom(envId: string, given?: ResolvedEnvironment): Promise<void> {
  return withOp(envId, 'rebuilding', async (stage) => {
    const index = indexOf(envId);
    let def = given;
    if (!def) {
      const pin = store.cursor(envId)?.pin;
      if (!pin) throw new Error('Puck does not know which definition pin this environment runs; open it once, then rebuild.');
      def = await resolveDefinition({ kind: pin.kind, name: pin.kind === 'commit' ? pin.sha : pin.name }, index.definition);
    }
    const deps = startDeps();
    if (attached?.envId === envId) detach();
    const bundleSha = await uploadBundle(index.runnerId, deps);
    await runners.control(
      index.runnerId,
      'instance.rebuild',
      { ...buildArgs(envId, def, bundleSha, deps), instance: { envId, name: def.name, pin: def.source.pin, definition: def } },
      {
        timeoutMs: LONG_TIMEOUT_MS,
        onEvent: (ev) => {
          if (ev.kind === 'instance.stage' && ev.envId === envId) stage(ev.stage, ev.detail);
        },
      },
    );
    store.updateCursor(envId, { pin: def.source.pin, harnesses: harnessesOf(def) });
    if (store.currentId() === envId) attach(envId);
  });
}

export function rebuild(envId: string): Promise<void> {
  return serial(envId, () => rebuildFrom(envId));
}

const updateDeps = (): UpdateDeps => ({
  pin: (envId) => store.cursor(envId)?.pin ?? null,
  definition: (envId) => indexOf(envId).definition,
  check: checkDefinitionUpdate,
  resolve: resolveDefinition,
  apply: async (envId, def) => {
    const client = attached;
    if (!client || client.envId !== envId || client.attachState !== 'attached') {
      throw new Error('Open this environment and wait until it is connected, then apply the update.');
    }
    await client.cmd('definition.apply', { definition: def, pin: def.source.pin });
  },
  rebuild: (envId, def) => rebuildFrom(envId, def),
  applied: (envId, def) => store.updateCursor(envId, { pin: def.source.pin, harnesses: harnessesOf(def) }),
});

/** A newer definition for the environment's pin, with its changes grouped by how they apply. */
export function checkUpdate(envId: string): Promise<InstanceUpdate | null> {
  return checkDefinition(envId, updateDeps());
}

/** Moves the environment to `pin`: in place when the daemon can, else by a rebuild. */
export function applyUpdate(envId: string, pin: PinSpec): Promise<void> {
  return serial(envId, async () => {
    const cls = await applyDefinitionUpdate(envId, pin, updateDeps());
    log.info('instance.update-applied', { envId, class: cls });
  });
}

export function remove(envId: string): Promise<void> {
  return serial(envId, () =>
    withOp(envId, 'deleting', async (stage) => {
      const index = indexOf(envId);
      if (attached?.envId === envId) detach();
      await runners.control(index.runnerId, 'instance.delete', { envId }, {
        timeoutMs: LONG_TIMEOUT_MS,
        onEvent: (ev) => {
          if (ev.kind === 'instance.stage' && ev.envId === envId) stage(ev.stage, ev.detail);
        },
      });
      await api.forgetInstance(envId);
      forgetLocal(envId);
    }),
  );
}

/** Forgets an environment whose runner is gone; nothing is deleted anywhere else. */
export function forget(envId: string): Promise<void> {
  return serial(envId, async () => {
    if (attached?.envId === envId) detach();
    await api.forgetInstance(envId);
    forgetLocal(envId);
  });
}

function forgetLocal(envId: string): void {
  ops.delete(envId);
  daemonState.delete(envId);
  store.removeCursor(envId);
  changed(envId);
}

/** Quit: the cursor is written, and the daemon connection closed (the daemon keeps working). */
export function shutdown(): void {
  detach();
  store.flushSeq();
}

export { flushSeq } from './store';
