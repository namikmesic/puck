/**
 * Runners, as the app sees them: the `runner` environment provider.
 *
 * - The list comes from the Puck server (`GET /v1/runners`) and stays
 *   current through the app socket's push events; every (re)connect reads
 *   it again, together with the environment index, because pushes only
 *   arrive while connected.
 * - This Mac is the runner this app installed (this-mac.ts), marked `local`
 *   and reached over its local socket; every other runner through the
 *   server's relay, end-to-end encrypted to the key the server lists. That
 *   key is pinned per install (store.ts): a runner whose listed key changes
 *   gets no channels.
 * - Control channels are pooled per runner and closed after a minute idle.
 *
 * The app never runs docker for runners; it sends them commands.
 */

import type { LocalRunnerState, RunnerRow, RunnersState } from '../../harness/bridge';
import type { ControlArgs, ControlEvent, ControlOp, ControlResult } from '../../harness/runner-protocol';
import type { ServerInstance, ServerPush, ServerRunner } from '../../harness/server-api';
import { keyFingerprint } from '../../channel/wire';
import { log } from '../log';
import * as api from '../server/api';
import { ServerConnection, type SocketState } from '../server/connection';
import { serverUrl } from '../server/http';
import { current, freshSession, onSessionChange, signOut } from '../server/session';
import { ChannelOpenError, type RunnerTransport } from './channel';
import { ControlClient } from './control-client';
import { localTransport } from './local';
import { adoptLegacyLocal, checkPinnedKey, forgetKey, localRunner } from './store';
import * as thisMac from './this-mac';
import type { EnvironmentProvider } from '../providers/types';

const CONTROL_IDLE_MS = 60_000;

const runners = new Map<string, ServerRunner>();
const instances = new Map<string, ServerInstance>();
let socketState: SocketState = 'idle';
let loaded = false;
/**
 * Advances on every sign-in and sign-out. A list fetched for an earlier
 * generation is dropped, so one account's runners cannot land in another's.
 */
let generation = 0;
/** Pushes are applied only while this equals `generation` (the live session). */
let acceptedGeneration = 0;

type Listener<T> = (value: T) => void;
const runnerListeners: Listener<{ kind: 'upsert'; runner: RunnerRow } | { kind: 'removed'; runnerId: string } | { kind: 'state' }>[] = [];
const instanceListeners: Listener<{ kind: 'upsert'; instance: ServerInstance } | { kind: 'removed'; envId: string } | { kind: 'reload' }>[] = [];
const onlineListeners: Listener<string>[] = [];

/** Runner list, This Mac or connection changes (the renderer's RunnerEvent). */
export function onRunnersChange(cb: (typeof runnerListeners)[number]): void {
  runnerListeners.push(cb);
}

/** Environment index changes. */
export function onInstancesChange(cb: (typeof instanceListeners)[number]): void {
  instanceListeners.push(cb);
}

/** A runner came (back) online: attached environments on it can reconnect now. */
export function onRunnerOnline(cb: Listener<string>): void {
  onlineListeners.push(cb);
}

function emitRunners(e: Parameters<(typeof runnerListeners)[number]>[0]): void {
  for (const cb of runnerListeners) cb(e);
}

function emitInstances(e: Parameters<(typeof instanceListeners)[number]>[0]): void {
  for (const cb of instanceListeners) cb(e);
}

function isLocal(runnerId: string): boolean {
  return localRunner()?.runnerId === runnerId;
}

/** The fingerprint of the key channels are encrypted to (never the server's own label for it). */
function fingerprintOf(r: ServerRunner): string | null {
  try {
    return keyFingerprint(r.publicKey);
  } catch {
    return null;
  }
}

/** True when the key the server lists is not the one this install pinned for the runner. */
function keyChanged(r: ServerRunner): boolean {
  const fp = fingerprintOf(r);
  return fp === null || !checkPinnedKey(r.id, fp);
}

export function row(r: ServerRunner): RunnerRow {
  return {
    id: r.id,
    name: r.name,
    labels: r.labels,
    os: r.os,
    arch: r.arch,
    version: r.version,
    fingerprint: fingerprintOf(r) ?? '',
    status: r.status,
    running: r.running,
    maxEnvironments: r.maxEnvironments,
    docker: r.docker,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
    local: isLocal(r.id),
    environments: [...instances.values()]
      .filter((i) => i.runnerId === r.id)
      .map((i) => ({ envId: i.id, definition: i.definition, status: i.status })),
    keyChanged: keyChanged(r),
  };
}

/** This Mac first, then by name. */
function sorted(): ServerRunner[] {
  return [...runners.values()].sort((a, b) => Number(isLocal(b.id)) - Number(isLocal(a.id)) || a.name.localeCompare(b.name));
}

export function state(): RunnersState {
  const session = current();
  const local: LocalRunnerState = thisMac.localState();
  return {
    signedIn: !!session,
    login: session?.user.login ?? null,
    server: serverUrl(),
    connection: socketState,
    runners: session ? sorted().map(row) : [],
    local,
  };
}

export function runnerById(id: string): ServerRunner | undefined {
  return runners.get(id);
}

export function serverInstances(): ServerInstance[] {
  return [...instances.values()];
}

export function serverInstance(envId: string): ServerInstance | undefined {
  return instances.get(envId);
}

/** Re-reads runners and environments from the server. */
export async function refresh(): Promise<void> {
  const gen = generation;
  const session = current();
  if (!session) return;
  const userId = session.user.id;
  const [list, envs] = await Promise.all([api.listRunners(), api.listInstances()]);
  if (gen !== generation || current()?.user.id !== userId) return;
  runners.clear();
  for (const r of list) runners.set(r.id, r);
  instances.clear();
  for (const i of envs) instances.set(i.id, i);
  loaded = true;
  adoptLegacyLocal(userId, list.map((r) => r.id));
  emitRunners({ kind: 'state' });
  emitInstances({ kind: 'reload' });
  // A nudge is cheap: an attached environment that is already connected ignores it.
  for (const r of list) if (r.status !== 'offline') for (const cb of onlineListeners) cb(r.id);
}

/** A push event from the server socket (exported for tests, which play the server). */
export function onPush(push: ServerPush): void {
  if (generation !== acceptedGeneration) return;
  switch (push.type) {
    case 'runner.upsert': {
      const before = runners.get(push.runner.id);
      runners.set(push.runner.id, push.runner);
      emitRunners({ kind: 'upsert', runner: row(push.runner) });
      if (push.runner.status !== 'offline' && (!before || before.status === 'offline')) {
        for (const cb of onlineListeners) cb(push.runner.id);
      }
      return;
    }
    case 'runner.removed':
      runners.delete(push.runnerId);
      forgetKey(push.runnerId);
      closeControl(push.runnerId);
      emitRunners({ kind: 'removed', runnerId: push.runnerId });
      return;
    case 'instance.upsert':
      instances.set(push.instance.id, push.instance);
      emitInstances({ kind: 'upsert', instance: push.instance });
      return;
    case 'instance.removed':
      instances.delete(push.envId);
      emitInstances({ kind: 'removed', envId: push.envId });
      return;
  }
}

export const connection = new ServerConnection({
  url: () => serverUrl(),
  session: async () => {
    const s = await freshSession();
    return { accessToken: s.accessToken, accessExpiresAt: s.accessExpiresAt };
  },
  onPush,
  onConnected: () => {
    void refresh().catch((err: unknown) => log.warn('runners.refresh-failed', { error: (err as Error).message.slice(0, 200) }));
  },
  onState: (s) => {
    socketState = s;
    emitRunners({ kind: 'state' });
  },
  onSignedOut: () => void signOut(),
  log,
});

/** Starts following the signed-in user's runners (boot and every sign-in). */
export function start(): void {
  thisMac.reconcile();
  thisMac.onLocalChange(() => emitRunners({ kind: 'state' }));
  if (current()) connection.start();
}

onSessionChange((signedIn) => {
  generation += 1;
  connection.stop(signedIn ? 'session-changed' : 'signed-out');
  for (const id of [...pool.keys()]) closeControl(id);
  runners.clear();
  instances.clear();
  loaded = false;
  if (signedIn) {
    acceptedGeneration = generation;
    connection.start();
  }
  emitRunners({ kind: 'state' });
  emitInstances({ kind: 'reload' });
});

/** Channels to a runner: This Mac over its socket, any other through the relay with its pinned key. */
export function transport(runnerId: string): RunnerTransport {
  const local = localRunner();
  if (local?.runnerId === runnerId) return localTransport(local.socket);
  const r = runners.get(runnerId);
  if (!r) throw new ChannelOpenError('not-found', 'Puck does not know that runner (sign in, or wait for the runner list).');
  if (keyChanged(r)) {
    throw new ChannelOpenError(
      'key-changed',
      `The Puck server lists a different key for ${r.name} than this Mac first saw, so Puck will not open channels to it. If you did not re-register it, check the fingerprint on the runner; otherwise remove it and add it again.`,
    );
  }
  return {
    kind: 'relay',
    open: (kind, envId) => connection.openChannel(r.id, r.publicKey, kind, envId),
  };
}

/* ---------- Control channels, pooled ---------- */

interface Pooled {
  client: Promise<ControlClient>;
  idle: ReturnType<typeof setTimeout> | null;
  inUse: number;
}
const pool = new Map<string, Pooled>();

function closeControl(runnerId: string): void {
  const p = pool.get(runnerId);
  if (!p) return;
  pool.delete(runnerId);
  if (p.idle) clearTimeout(p.idle);
  void p.client.then((c) => c.close()).catch(() => undefined);
}

function controlFor(runnerId: string): Pooled {
  const have = pool.get(runnerId);
  if (have) return have;
  const client = (async () => {
    const channel = await transport(runnerId).open('control');
    const c = new ControlClient(channel);
    channel.onClose(() => {
      if (pool.get(runnerId)?.client === client) pool.delete(runnerId);
    });
    await c.welcome;
    return c;
  })();
  const pooled: Pooled = { client, idle: null, inUse: 0 };
  pool.set(runnerId, pooled);
  client.catch(() => {
    if (pool.get(runnerId) === pooled) pool.delete(runnerId);
  });
  return pooled;
}

/** One control command to a runner. */
export async function control<O extends ControlOp>(
  runnerId: string,
  op: O,
  args: ControlArgs<O>,
  opts: { timeoutMs?: number; onEvent?: (ev: ControlEvent) => void } = {},
): Promise<ControlResult<O>> {
  const pooled = controlFor(runnerId);
  pooled.inUse++;
  if (pooled.idle) clearTimeout(pooled.idle);
  pooled.idle = null;
  try {
    const client = await pooled.client;
    return await client.cmd(op, args, opts);
  } finally {
    pooled.inUse--;
    if (pooled.inUse === 0 && pool.get(runnerId) === pooled) {
      pooled.idle = setTimeout(() => {
        if (pool.get(runnerId) === pooled && pooled.inUse === 0) closeControl(runnerId);
      }, CONTROL_IDLE_MS);
    }
  }
}

/** Closes every channel and the server socket (quit). */
export function shutdown(): void {
  for (const id of [...pool.keys()]) closeControl(id);
  connection.stop('app-quitting');
}

/** Removes a runner whose machine is gone (the server marks its environments lost). */
export async function forceRemove(runnerId: string): Promise<void> {
  await api.forceRemoveRunner(runnerId);
  closeControl(runnerId);
  forgetKey(runnerId);
  await refresh();
}

/* ---------- This Mac ---------- */

export async function installLocal(): Promise<void> {
  const gen = generation;
  const session = current();
  if (!session) throw new Error('Sign in to Puck first (Settings → Providers → GitHub).');
  const userId = session.user.id;
  const existing = await api.listRunners();
  if (gen !== generation || current()?.user.id !== userId) throw new Error('The Puck session changed; try again.');
  await thisMac.install(existing);
  await refresh().catch(() => undefined);
}

export async function uninstallLocal(): Promise<void> {
  const id = localRunner()?.runnerId;
  if (id) closeControl(id);
  await thisMac.uninstall();
  await refresh().catch(() => undefined);
}

/* ---------- The provider ---------- */

export const runnerProvider: EnvironmentProvider = {
  kind: 'environment',
  id: 'runner',
  label: 'Runners',
  status() {
    const s = state();
    if (!s.signedIn) return { state: 'disconnected', detail: 'Sign in to Puck to use your runners' };
    if (s.connection === 'offline') return { state: 'error', detail: `Can't reach the Puck server at ${s.server}; Puck keeps trying.` };
    if (!loaded) return { state: 'pending', detail: 'Loading your runners…' };
    const online = s.runners.filter((r) => r.status !== 'offline').length;
    const n = s.runners.length;
    if (n === 0) return { state: 'disconnected', detail: 'No runners yet' };
    return { state: 'connected', detail: `${n} ${n === 1 ? 'runner' : 'runners'}, ${online} online` };
  },
  state,
  transport,
};
