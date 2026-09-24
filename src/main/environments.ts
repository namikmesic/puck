/**
 * Environment primitive (main process).
 *
 * An environment is a named, persistent Docker container the harness runs
 * inside: the provider CLI (claude / codex) executes there via `docker exec`,
 * with a host directory mounted at /workspace. Config persists in userData.
 *
 * Puck owns the environment LIFECYCLE STATE (`EnvLifecycle`), separate from
 * Docker liveness: a running container is `ready` only after bootstrap,
 * credential and secret injection, runner deployment, and a successful runner
 * handshake. Every start/stop stage is streamed to lifecycle subscribers.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  EnvironmentConfig,
  EnvironmentInfo,
  EnvLifecycle,
  EnvLifecycleEvent,
  EnvStage,
} from '../harness/bridge';
import { log } from './log';
import { RUNNER_SOURCE } from './runner-source';
import { detach as detachRunner, onRunnerExit, probe as probeRunner } from './runner';
import {
  docker,
  dockerHealth,
  dockerOrThrow,
  dockerProcess,
  type DockerOptions,
  type DockerResult,
} from './docker-client';
import {
  describeTimeout,
  idleLifecycle,
  sanitizeOutputLine,
  STAGE_LABELS,
  transition,
  type LifecycleEvent,
} from './env-lifecycle';
import {
  bootstrapPlan,
  describePinFailure,
  expectedPackages,
  parseInstalledVersions,
  verifyPins,
  verifyScript,
} from './provisioning';
import { providers, type Provider } from './providers';
import { deleteSecret, loadSecret, saveSecret } from './secrets';
import { defineStore } from './store';

interface StoredEnv extends EnvironmentConfig {
  id: string;
}

interface Store {
  environments: StoredEnv[];
  activeEnvId: string | null;
}

/** Host auth material forwarded into containers at creation time. */
const FORWARDED_ENV = providers.flatMap((p) => p.container.forwardedEnvKeys);

/* ---------- Timeouts (one table; every long op names its bound in errors) ---------- */

export const TIMEOUTS = {
  /** Image pull, image build, package install: network-bound. */
  provision: 10 * 60_000,
  /** `docker run` / `docker start` once the image is local: a daemon-hang guard only. */
  run: 60_000,
  /** Read-only version check inside the container. */
  verify: 60_000,
  stop: 60_000,
} as const;

const store = defineStore<Store>({
  file: 'puck-environments.json',
  defaults: () => ({ environments: [], activeEnvId: null }),
  // Records written before Dockerfile / env-var support lack those fields.
  migrate: (raw) => ({
    ...raw,
    environments: raw.environments.map((e) => ({
      ...e,
      dockerfile: e.dockerfile ?? '',
      envVars: e.envVars ?? {},
    })),
  }),
});
const load = store.read;
const save = store.persist;

/** Every fs/docker-touching operation must name an environment we manage. */
function requireEnv(id: string): StoredEnv {
  const env = load().environments.find((e) => e.id === id);
  if (!env) throw new Error('Unknown environment');
  return env;
}

export function containerName(id: string): string {
  return `puck-env-${id}`;
}

/**
 * Stdio exec into an environment's runner — the transport adapter the
 * composition root hands to runner.ts (`useExecSpawner`). Uses the discovered
 * docker binary (a start has always resolved it before a turn can run).
 */
export function runnerExecSpawner(envId: string): ReturnType<typeof dockerProcess> {
  return dockerProcess(['exec', '-i', containerName(envId), 'node', '/opt/puck/runner.js']);
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

type ContainerState = 'running' | 'stopped' | 'missing' | 'unknown';

async function containerState(id: string): Promise<ContainerState> {
  const r = await docker(['inspect', '-f', '{{.State.Running}}', containerName(id)]);
  if (r.code !== 0) return r.timedOut ? 'unknown' : 'missing';
  return r.stdout.trim() === 'true' ? 'running' : 'stopped';
}

/** Is the image present in the local daemon? null when Docker could not answer. */
async function imageLocal(image: string): Promise<boolean | null> {
  const r = await docker(['image', 'inspect', '--format', '{{.Id}}', image]);
  if (r.code === 0) return true;
  return r.timedOut || r.code === -1 ? null : false;
}

/* ---------- Lifecycle state (Puck-owned; authoritative for the UI and the chat gate) ---------- */

const lifecycles = new Map<string, EnvLifecycle>();
const lifecycleSubscribers: Array<(ev: EnvLifecycleEvent) => void> = [];

/** Subscribe to every lifecycle change (the composition root pushes these to the renderer). */
export function onLifecycle(cb: (ev: EnvLifecycleEvent) => void): void {
  lifecycleSubscribers.push(cb);
}

function lifecycleOf(id: string): EnvLifecycle {
  return lifecycles.get(id) ?? idleLifecycle();
}

/** Output-line updates are coalesced so a chatty `docker build` does not flood IPC. */
const DETAIL_COALESCE_MS = 120;
const pendingEmits = new Map<string, ReturnType<typeof setTimeout>>();

function emit(id: string): void {
  const timer = pendingEmits.get(id);
  if (timer) {
    clearTimeout(timer);
    pendingEmits.delete(id);
  }
  const payload: EnvLifecycleEvent = { envId: id, ...lifecycleOf(id) };
  for (const cb of lifecycleSubscribers) cb(payload);
}

function apply(id: string, ev: LifecycleEvent): void {
  const before = lifecycleOf(id);
  const after = transition(before, ev);
  if (after === before) return;
  lifecycles.set(id, after);
  if (ev.type === 'detail') {
    if (!pendingEmits.has(id)) {
      pendingEmits.set(id, setTimeout(() => emit(id), DETAIL_COALESCE_MS));
    }
  } else {
    emit(id);
  }
}

/**
 * Boot reconciliation, once: a container left running by a previous app
 * session is NOT trusted as ready — it is re-provisioned through the normal
 * start (idempotent installs, fresh runner, handshake) and reaches `ready`
 * the same way every other start does.
 */
let reconciled: Promise<void> | null = null;
function reconcile(): Promise<void> {
  if (!reconciled) {
    reconciled = (async () => {
      const envs = load().environments;
      const states = await Promise.all(envs.map((e) => containerState(e.id)));
      envs.forEach((e, i) => {
        if (states[i] === 'running') void start(e.id).catch(() => undefined);
      });
    })();
  }
  return reconciled;
}

/** A `ready` environment whose container vanished (stopped outside Puck) is demoted. */
async function verifyLiveness(id: string): Promise<void> {
  if (lifecycleOf(id).status !== 'ready') return;
  const state = await containerState(id);
  if (state === 'running' || state === 'unknown') return;
  apply(id, { type: 'lost', at: Date.now(), detail: 'container stopped outside Puck' });
}

/** The authoritative lifecycle of one environment (boot-reconciled, liveness-checked). */
export async function lifecycle(id: string): Promise<EnvLifecycle> {
  await reconcile();
  await verifyLiveness(id);
  return lifecycleOf(id);
}

// The runner died on its own (not a detach): either the container went away
// or the runner crashed. Only a READY environment with no operation in
// flight is affected — operations own the state while they run.
onRunnerExit((envId, code) => {
  if (isOperating(envId) || lifecycleOf(envId).status !== 'ready') return;
  void containerState(envId).then((state) => {
    if (isOperating(envId) || lifecycleOf(envId).status !== 'ready') return;
    if (state === 'missing' || state === 'stopped') {
      apply(envId, { type: 'lost', at: Date.now(), detail: 'container stopped outside Puck' });
    } else {
      const why = code === 137 ? 'was killed (exit 137)' : `exited unexpectedly (code ${code ?? 'unknown'})`;
      apply(envId, {
        type: 'failed',
        at: Date.now(),
        error: `Runner ${why}. Restart the environment from Settings.`,
      });
    }
  });
});

/* ---------- Per-environment secrets (values encrypted at rest) ---------- */

function secretsStoreName(id: string): string {
  // Ids are validated at the IPC boundary; basename() is defense in depth
  // against path traversal ever reaching the secret store.
  return path.basename(`env-secrets-${id}.bin`);
}

function envSecrets(id: string): Record<string, string> {
  const json = loadSecret(secretsStoreName(id));
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Key shape is validated at the IPC boundary (ipcguard.requireSecretKey). */
export function secretSet(id: string, key: string, value: string): Promise<EnvironmentInfo[]> {
  return withEnvOp(id, 'secrets', async () => {
    requireEnv(id);
    const secrets = envSecrets(id);
    secrets[key] = value;
    await writeSecrets(id, secrets);
    return list();
  });
}

export function secretDelete(id: string, key: string): Promise<EnvironmentInfo[]> {
  return withEnvOp(id, 'secrets', async () => {
    requireEnv(id);
    const secrets = envSecrets(id);
    delete secrets[key];
    await writeSecrets(id, secrets);
    return list();
  });
}

async function writeSecrets(id: string, secrets: Record<string, string>): Promise<void> {
  saveSecret(secretsStoreName(id), JSON.stringify(secrets));
  if (lifecycleOf(id).status === 'ready') await injectSecretsFile(id);
}

function toInfo(env: StoredEnv): EnvironmentInfo {
  return {
    ...env,
    ...lifecycleOf(env.id),
    active: env.id === load().activeEnvId,
    secretKeys: Object.keys(envSecrets(env.id)).sort(),
  };
}

export async function list(): Promise<EnvironmentInfo[]> {
  await reconcile();
  const envs = load().environments;
  await Promise.all(envs.map((e) => verifyLiveness(e.id)));
  return envs.map(toInfo);
}

function sanitize(cfg: EnvironmentConfig, id: string): Omit<StoredEnv, 'id'> {
  return {
    name: cfg.name.trim() || 'environment',
    image: cfg.image.trim() || 'node:22-bookworm',
    workspacePath:
      cfg.workspacePath.trim() || path.join(os.homedir(), 'puck-workspaces', id),
    autoInstall: cfg.autoInstall,
    dockerfile: cfg.dockerfile,
    envVars: cfg.envVars,
  };
}

export async function create(cfg: EnvironmentConfig): Promise<EnvironmentInfo[]> {
  const s = load();
  const id = crypto.randomUUID();
  s.environments.push({ id, ...sanitize(cfg, id) });
  if (!s.activeEnvId) s.activeEnvId = id;
  save();
  log.info('env.create', { envId: id });
  return list();
}

export async function update(id: string, cfg: EnvironmentConfig): Promise<EnvironmentInfo[]> {
  const s = load();
  const idx = s.environments.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error('Unknown environment');
  s.environments[idx] = { id, ...sanitize(cfg, id) };
  save();
  log.info('env.update', { envId: id });
  return list();
}

function imageTag(id: string): string {
  return `puck-img-${id}`;
}

/** Subscribers notified when an environment's container state is destroyed
 *  (rebuild / remove) — e.g. the session registry drops its resume ids. */
const resetSubscribers: Array<(envId: string) => void> = [];
export function onEnvReset(cb: (envId: string) => void): void {
  resetSubscribers.push(cb);
}
function notifyReset(envId: string): void {
  for (const cb of resetSubscribers) cb(envId);
}

/* ---------- Operations: one serialized, cancellable queue per environment ---------- */

type OpKind = 'start' | 'stop' | 'restart' | 'rebuild' | 'remove' | 'secrets';

interface RunningOp {
  kind: OpKind;
  controller: AbortController;
}

// One queue per environment across ALL lifecycle ops: a queued start must
// not resurrect a just-deleted container, and rm must not race a start.
// "Op", not "lock": beyond serializing, every op first detaches the env's
// runner exec — a live runner must not outlive its container state, and the
// next turn's runner picks up new secrets / a redeployed runner.js.
const envTail = new Map<string, Promise<unknown>>();
const runningOps = new Map<string, RunningOp>();

function withEnvOp<T>(id: string, kind: OpKind, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const prev = envTail.get(id) ?? Promise.resolve();
  const controller = new AbortController();
  const task: Promise<T> = prev
    .catch(() => undefined)
    .then(async () => {
      runningOps.set(id, { kind, controller });
      detachRunner(id);
      log.info(`env.${kind}`, { envId: id });
      try {
        return await fn(controller.signal);
      } catch (err) {
        // Every op failure lands in the diagnostic log by name; the caller still sees it.
        log.error(`env.${kind} failed`, err, { envId: id });
        throw err;
      } finally {
        // Bookkeeping settles BEFORE the caller's await resumes, so a runner
        // exit or a status read right after an op sees "idle", not a stale op.
        if (runningOps.get(id)?.controller === controller) runningOps.delete(id);
        if (envTail.get(id) === task) envTail.delete(id);
      }
    });
  envTail.set(id, task);
  return task;
}

/** An operation is running or queued for this environment. */
export function isOperating(id: string): boolean {
  return envTail.has(id);
}

/** A start in progress (pull, build, install…) is abandoned when a stop-like op arrives. */
function cancelStart(id: string): void {
  const running = runningOps.get(id);
  if (running?.kind === 'start') running.controller.abort();
}

/**
 * For runner.ts: why did the runner exec just die? A lifecycle operation
 * (stop, restart, rebuild, delete, secrets update) detaches the runner on
 * purpose; the turn should read as cancelled by that, not "disconnected".
 */
export function explainDisconnect(id: string): string | null {
  const running = runningOps.get(id);
  const name = load().environments.find((e) => e.id === id)?.name ?? 'environment';
  const kind = running?.kind ?? (lifecycleOf(id).status === 'stopping' ? 'stop' : null);
  switch (kind) {
    case 'start':
      return `Environment "${name}" is starting.`;
    case 'stop':
      return `Environment "${name}" is stopping.`;
    case 'restart':
      return `Environment "${name}" is restarting.`;
    case 'rebuild':
      return `Environment "${name}" is being rebuilt.`;
    case 'remove':
      return `Environment "${name}" was deleted.`;
    case 'secrets':
      return `Environment "${name}" is applying updated secrets.`;
    default:
      return null;
  }
}

class StartCancelled extends Error {
  constructor(name: string) {
    super(`Start of "${name}" was cancelled.`);
    this.name = 'StartCancelled';
  }
}

export function start(id: string): Promise<EnvironmentInfo[]> {
  const env = requireEnv(id);
  if (!isOperating(id)) apply(id, { type: 'begin-start', at: Date.now() }); // instant feedback
  return withEnvOp(id, 'start', async (signal) => {
    await runStart(env, signal);
    return list();
  });
}

/** doStart with lifecycle bookkeeping: ready on success, failed (stage kept) on error. */
async function runStart(env: StoredEnv, signal: AbortSignal): Promise<void> {
  apply(env.id, { type: 'begin-start', at: Date.now() });
  try {
    await doStart(env.id, signal);
    apply(env.id, { type: 'ready', at: Date.now() });
  } catch (err) {
    // A cancelled start belongs to the stop/remove that cancelled it — that
    // operation owns the state from here.
    if (signal.aborted) throw new StartCancelled(env.name);
    apply(env.id, { type: 'failed', at: Date.now(), error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export function stop(id: string): Promise<EnvironmentInfo[]> {
  requireEnv(id);
  cancelStart(id);
  if (!isOperating(id) || runningOps.get(id)?.kind === 'start') {
    apply(id, { type: 'begin-stop', at: Date.now() }); // instant feedback
  }
  return withEnvOp(id, 'stop', async () => {
    requireEnv(id);
    await stopPhase(id);
    apply(id, { type: 'stopped', at: Date.now() });
    return list();
  });
}

/** doStop with lifecycle bookkeeping; the caller decides what follows (stopped, or a start). */
async function stopPhase(id: string): Promise<void> {
  apply(id, { type: 'begin-stop', at: Date.now() });
  try {
    await doStop(id);
  } catch (err) {
    apply(id, { type: 'failed', at: Date.now(), error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Stop + start without a `stopped` flash in between: stopping → starting → ready. */
export function restart(id: string): Promise<EnvironmentInfo[]> {
  const env = requireEnv(id);
  cancelStart(id);
  return withEnvOp(id, 'restart', async (signal) => {
    requireEnv(id);
    await stopPhase(id);
    await runStart(env, signal);
    return list();
  });
}

/** Destroy the container and recreate from current config (incl. build). */
export function rebuild(id: string): Promise<EnvironmentInfo[]> {
  const env = requireEnv(id);
  cancelStart(id);
  return withEnvOp(id, 'rebuild', async (signal) => {
    requireEnv(id);
    await stopPhase(id); // adopts rotated credentials; ignores not-running
    apply(id, { type: 'stage', stage: 'removing-container', detail: `docker rm ${containerName(id)}` });
    await docker(['rm', '-f', containerName(id)]);
    notifyReset(id); // container transcripts are gone — resume ids with them
    await runStart(env, signal);
    return list();
  });
}

export function remove(id: string): Promise<EnvironmentInfo[]> {
  requireEnv(id);
  cancelStart(id);
  return withEnvOp(id, 'remove', async () => {
    requireEnv(id);
    apply(id, { type: 'begin-stop', at: Date.now(), stage: 'removing-container' });
    await docker(['rm', '-f', containerName(id)]);
    await docker(['rmi', imageTag(id)]);
    deleteSecret(secretsStoreName(id));
    const s = load();
    s.environments = s.environments.filter((e) => e.id !== id);
    if (s.activeEnvId === id) s.activeEnvId = s.environments[0]?.id ?? null;
    save();
    lifecycles.delete(id);
    notifyReset(id);
    return list();
  });
}

/* ---------- Start: pull → run → install → verify → deploy → inject → handshake ---------- */

/** Values that reach docker as operands must never be parsed as flags. */
function assertOperand(value: string, what: string): void {
  if (value.startsWith('-')) throw new Error(`Invalid ${what}.`);
}

/**
 * Failure text for a docker operation in a stage. A timeout inspects the
 * image, container, and daemon before reporting; any other failure asks the
 * daemon health check ONCE so "is Docker running?" appears only when Docker
 * really did not answer — a failed pull or build is not a stopped daemon.
 */
async function startFailure(
  operation: string,
  stage: EnvStage,
  r: DockerResult,
  timeoutMs: number,
  image: string,
  id: string,
): Promise<Error> {
  if (r.timedOut) {
    const [img, container, daemon] = await Promise.all([
      imageLocal(image),
      containerState(id),
      dockerHealth(),
    ]);
    return new Error(
      describeTimeout(operation, stage, Math.round(timeoutMs / 1000), {
        imageLocal: img,
        container,
        daemon,
      }),
    );
  }
  const health = await dockerHealth();
  if (!health.ok) return new Error(`${operation} failed while ${STAGE_LABELS[stage]}: ${health.message}`);
  const tail = r.stderr.trim().slice(-600) || `docker exited with code ${r.code ?? 'unknown'}`;
  return new Error(`${operation} failed while ${STAGE_LABELS[stage]}: ${tail}`);
}

async function doStart(id: string, signal: AbortSignal): Promise<void> {
  const env = requireEnv(id);
  const name = containerName(id);
  const stage = (s: EnvStage, detail?: string): void => apply(id, { type: 'stage', stage: s, detail });
  const detail = (line: string): void => apply(id, { type: 'detail', detail: sanitizeOutputLine(line) });
  const checkCancelled = (): void => {
    if (signal.aborted) throw new StartCancelled(env.name);
  };
  const opts = (timeoutMs: number, stream = false): DockerOptions => ({
    timeoutMs,
    signal,
    onOutput: stream ? detail : undefined,
  });

  stage('checking-image', `container ${name}`);
  const state = await containerState(id);
  checkCancelled();
  if (state === 'unknown') {
    const health = await dockerHealth();
    throw new Error(`docker inspect timed out while ${STAGE_LABELS['checking-image']}: ${health.message}`);
  }

  if (state === 'missing') {
    let image = env.image;
    assertOperand(image, 'image name');
    if (env.dockerfile.trim()) {
      // Build the per-environment image when a Dockerfile is configured; the
      // build pulls its own base image and streams progress as it goes.
      stage('building-image', `docker build ${imageTag(id)}`);
      const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-build-'));
      fs.writeFileSync(path.join(ctx, 'Dockerfile'), env.dockerfile);
      const build = await docker(['build', '-t', imageTag(id), ctx], opts(TIMEOUTS.provision, true));
      checkCancelled();
      if (build.code !== 0) {
        throw await startFailure('docker build', 'building-image', build, TIMEOUTS.provision, imageTag(id), id);
      }
      image = imageTag(id);
    } else {
      // Pull explicitly, outside the short run timeout, so a cold image
      // download shows progress instead of consuming the daemon-hang guard.
      stage('checking-image', image);
      const present = await imageLocal(image);
      checkCancelled();
      if (present !== true) {
        stage('pulling-image', `docker pull ${image}`);
        const pull = await docker(['pull', image], opts(TIMEOUTS.provision, true));
        checkCancelled();
        if (pull.code !== 0) {
          throw await startFailure('docker pull', 'pulling-image', pull, TIMEOUTS.provision, image, id);
        }
      }
    }

    const workspace = expandHome(env.workspacePath);
    assertOperand(workspace, 'workspace path');
    fs.mkdirSync(workspace, { recursive: true });
    const args = [
      'run', '-d',
      '--name', name,
      '--label', 'puck=environment',
      '-v', `${workspace}:/workspace`,
      '-w', '/workspace',
    ];
    // Provider-declared container env (e.g. Claude Code's IS_SANDBOX=1).
    for (const p of providers) {
      for (const [key, value] of Object.entries(p.container.containerEnv)) {
        args.push('-e', `${key}=${value}`);
      }
    }
    // Host CLI state dirs (~/.claude, ~/.codex) are deliberately NOT mounted:
    // the container runs with full tool access, and a writable mount would let
    // an agent plant host-side hooks/settings that execute outside the sandbox
    // (and colima doesn't share $HOME anyway). Credentials arrive via docker
    // cp below; transcripts/session state stay container-local.
    for (const key of FORWARDED_ENV) {
      if (process.env[key]) args.push('-e', `${key}=${process.env[key]}`);
    }
    // User-configured env vars. Secrets deliberately do NOT go through -e:
    // docker inspect would expose them forever — they travel as a root-only
    // file the runner applies to its own environment (injectSecretsFile).
    for (const [key, value] of Object.entries(env.envVars)) {
      args.push('-e', `${key}=${value}`);
    }
    // `--` ends option parsing so a hostile image string can't become a flag.
    args.push('--', image, 'sleep', 'infinity');
    stage('starting-container', `docker run ${image}`);
    const r = await docker(args, opts(TIMEOUTS.run));
    checkCancelled();
    if (r.code !== 0) throw await startFailure('docker run', 'starting-container', r, TIMEOUTS.run, image, id);
  } else if (state === 'stopped') {
    stage('starting-container', `docker start ${name}`);
    const r = await docker(['start', name], opts(TIMEOUTS.run));
    checkCancelled();
    if (r.code !== 0) throw await startFailure('docker start', 'starting-container', r, TIMEOUTS.run, env.image, id);
  } else {
    stage('starting-container', 'container already running');
  }

  await dockerOrThrow(['exec', name, 'mkdir', '-p', '/opt/puck'], 'Environment setup failed', opts(TIMEOUTS.run));
  checkCancelled();

  if (env.autoInstall) {
    for (const step of bootstrapPlan(providers)) {
      const installStage: EnvStage = step.kind === 'clis' ? 'installing-clis' : 'installing-sdks';
      stage(installStage, 'checking installed versions');
      const check = await docker(['exec', name, 'sh', '-lc', step.check], opts(TIMEOUTS.verify));
      checkCancelled();
      if (check.code === 0) continue; // every pin already at its version
      detail(step.install); // the UI reads "npm install …" for the minutes this takes
      await dockerOrThrow(
        ['exec', name, 'sh', '-lc', step.install],
        `Environment bootstrap failed (${STAGE_LABELS[installStage]})`,
        opts(TIMEOUTS.provision, true),
      );
      checkCancelled();
    }
  }

  // Pinned versions are verified on every start — including user-managed
  // images — so the runner never meets an SDK it was not written against.
  stage('verifying-packages');
  const expected = expectedPackages(providers);
  const versions = await dockerOrThrow(
    ['exec', name, 'sh', '-lc', verifyScript(expected)],
    'Package verification failed',
    opts(TIMEOUTS.verify),
  );
  checkCancelled();
  const report = verifyPins(expected, parseInstalledVersions(versions), env.autoInstall);
  if (report.errors.length) throw new Error(describePinFailure(report, env.autoInstall));
  if (report.notes.length) detail(report.notes.join('; '));

  // Deploy (or refresh) the runner agent.
  stage('deploying-runner', '/opt/puck/runner.js');
  await copyIntoContainer(id, RUNNER_SOURCE, '/opt/puck/runner.js', 'Runner deploy failed', signal);
  checkCancelled();

  // Credential material: static labels only — never paths, never contents.
  stage('injecting-credentials');
  // Copy file-based CLI credentials from the host. Bind mounts are not
  // reliable for this across Docker runtimes (a colima VM without $HOME
  // sharing silently yields empty dirs), so docker cp on every start.
  // Signed out of Puck and no host file: a mirror left from before the
  // sign-out is stale (the logout fence only reaches running containers, see
  // purgeCredentials) - remove it before anything in the container can use it.
  for (const p of providers) {
    const cred = p.container.credential;
    if (fs.existsSync(cred.hostPath)) {
      detail(`${p.label} CLI credentials`);
      const dest = path.posix.dirname(cred.containerPath) + '/';
      await dockerOrThrow(['exec', name, 'mkdir', '-p', dest], `${p.label} credential setup failed`, opts(TIMEOUTS.run));
      await dockerOrThrow(['cp', cred.hostPath, `${name}:${dest}`], `${p.label} credential copy failed`, opts(TIMEOUTS.run));
    } else if (!cred.signedIn()) {
      detail(`${p.label} stale credentials removed`);
      await dockerOrThrow(
        ['exec', name, 'rm', '-f', cred.containerPath],
        `${p.label} credential cleanup failed`,
        opts(TIMEOUTS.run),
      );
    }
  }
  detail('environment secrets');
  await injectSecretsFile(id, signal);
  // Puck-managed OAuth tokens win over host files when fresher.
  for (const p of providers) {
    detail(`${p.label} sign-in`);
    await injectCredentials(id, p, signal);
  }
  checkCancelled();

  // The handshake is the readiness proof: the runner file is in place, node
  // can load it, and it answers on stdio. The exec stays cached for the
  // first turn.
  stage('probing-runner', 'docker exec node /opt/puck/runner.js');
  await probeRunner(id);
}

/**
 * Ship `content` into the container via a root-only host temp file and
 * `docker cp` — the only way secrets and credentials travel (never argv, never
 * a bind mount). Callers create the destination directory first if needed.
 */
async function copyIntoContainer(
  id: string,
  content: string,
  containerPath: string,
  what: string,
  signal?: AbortSignal,
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-cp-'));
  try {
    const tmp = path.join(tmpDir, path.posix.basename(containerPath));
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    await dockerOrThrow(['cp', tmp, `${containerName(id)}:${containerPath}`], what, { signal });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Environment secrets as a root-only container file (never docker argv). */
async function injectSecretsFile(id: string, signal?: AbortSignal): Promise<void> {
  const what = 'Secrets injection failed';
  await dockerOrThrow(['exec', containerName(id), 'mkdir', '-p', '/opt/puck'], what, { signal });
  await copyIntoContainer(id, JSON.stringify(envSecrets(id)), '/opt/puck/secrets.json', what, signal);
  await dockerOrThrow(['exec', containerName(id), 'chmod', '600', '/opt/puck/secrets.json'], what, { signal });
}

/**
 * Write Puck-managed OAuth tokens into a container as the provider's CLI
 * credential file — unless the container already holds fresher ones (CLIs
 * rotate tokens themselves mid-session, which we adopt back). A sign-out
 * that happens while this runs wins: the snapshot's fence is checked before
 * the copy, and again after it so a copy that raced the purge is undone.
 */
async function injectCredentials(id: string, p: Provider, signal?: AbortSignal): Promise<void> {
  const cred = p.container.credential;
  const snapshot = await cred.fresh();
  if (!snapshot) return;
  const existing = await docker(['exec', containerName(id), 'cat', cred.containerPath], { signal });
  if (existing.code === 0) {
    cred.adoptIfNewer(existing.stdout);
    if (!snapshot.supersedes(existing.stdout)) return;
  }
  if (!snapshot.current()) return; // signed out while we read the container copy
  await dockerOrThrow(
    ['exec', containerName(id), 'mkdir', '-p', path.posix.dirname(cred.containerPath)],
    `${p.label} credential setup failed`,
    { signal },
  );
  await copyIntoContainer(id, snapshot.content, cred.containerPath, `${p.label} credential copy failed`, signal);
  if (!snapshot.current()) {
    await dockerOrThrow(
      ['exec', containerName(id), 'rm', '-f', cred.containerPath],
      `${p.label} credential cleanup failed`,
      { signal },
    );
  }
}

/**
 * The container side of the logout fence: remove the provider's credential
 * file Puck mirrored into every RUNNING container (a stopped container is
 * cleaned on its next start, see doStart). Docker liveness, not Puck
 * readiness, is the right test here: the file must go wherever a container
 * exists, including one mid-start. Deliberately not an env op: it must
 * neither wait behind a long bootstrap nor quiesce a runner, and it needs
 * no mutex - the account is already signed out, so nothing re-injects
 * (injectCredentials re-checks its fence after copying). Reports the
 * environments it could not clean; the sign-out itself has already held.
 */
export async function purgeCredentials(p: Provider): Promise<void> {
  const failures: string[] = [];
  for (const env of load().environments) {
    if ((await containerState(env.id)) !== 'running') continue;
    const r = await docker(['exec', containerName(env.id), 'rm', '-f', p.container.credential.containerPath]);
    if (r.code !== 0 && !/is not running|no such container/i.test(r.stderr)) {
      failures.push(`${env.name}: ${r.stderr.trim().slice(-200) || 'docker exec failed'}`);
    }
  }
  if (failures.length) {
    throw new Error(
      `Signed out, but the ${p.label} credential file could not be removed from ` +
        `${failures.length === 1 ? 'environment' : 'environments'} ${failures.join('; ')}`,
    );
  }
}

/**
 * Push freshly obtained credentials into every running container. Like the
 * purge, this follows Docker liveness rather than Puck readiness: a container
 * that exists should hold the current tokens whatever its lifecycle state.
 */
export async function injectCredentialsIntoRunning(): Promise<void> {
  for (const env of load().environments) {
    if ((await containerState(env.id)) === 'running') {
      for (const p of providers) await injectCredentials(env.id, p);
    }
  }
}

async function doStop(id: string): Promise<void> {
  // Providers may have rotated tokens inside the container — adopt them
  // before the container goes away so Puck's copies stay valid.
  apply(id, { type: 'detail', detail: 'adopting rotated credentials' });
  for (const p of providers) {
    const creds = await docker(['exec', containerName(id), 'cat', p.container.credential.containerPath]);
    if (creds.code === 0) p.container.credential.adoptIfNewer(creds.stdout);
  }
  apply(id, { type: 'detail', detail: `docker stop ${containerName(id)}` });
  const r = await docker(['stop', containerName(id)], { timeoutMs: TIMEOUTS.stop });
  // A missing or already-stopped container is a successful stop; only a
  // daemon that never answered is an error.
  if (r.timedOut) {
    const health = await dockerHealth();
    throw new Error(
      `docker stop timed out after ${Math.round(TIMEOUTS.stop / 1000)}s while ${STAGE_LABELS['stopping-container']}: ${health.message}`,
    );
  }
}

export function select(id: string): void {
  const s = load();
  if (s.environments.some((e) => e.id === id)) {
    s.activeEnvId = id;
    save();
  }
}

export function activeEnv(): StoredEnv | null {
  const s = load();
  return s.environments.find((e) => e.id === s.activeEnvId) ?? null;
}
