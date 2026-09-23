/**
 * Environment primitive (main process).
 *
 * An environment is a named, persistent Docker container the harness runs
 * inside: the provider CLI (claude / codex) executes there via `docker exec`,
 * with a host directory mounted at /workspace. Config persists in userData.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EnvironmentConfig, EnvironmentInfo } from '../harness/bridge';
import { RUNNER_SOURCE } from './runner-source';
import { detach as detachRunner } from './runner';
import { docker, dockerOrThrow } from './docker-client';
import { bootstrapPlan } from './provisioning';
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
 * composition root hands to runner.ts (`useExecSpawner`).
 */
export function runnerExecSpawner(envId: string): ChildProcessWithoutNullStreams {
  return spawn('docker', ['exec', '-i', containerName(envId), 'node', '/opt/puck/runner.js']);
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

async function containerState(id: string): Promise<'running' | 'stopped' | 'missing'> {
  const r = await docker(['inspect', '-f', '{{.State.Running}}', containerName(id)]);
  if (r.code !== 0) return 'missing';
  return r.stdout.trim() === 'true' ? 'running' : 'stopped';
}

export async function runtimeStatus(id: string): Promise<'running' | 'stopped'> {
  return (await containerState(id)) === 'running' ? 'running' : 'stopped';
}

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
  return withEnvOp(id, async () => {
    requireEnv(id);
    const secrets = envSecrets(id);
    secrets[key] = value;
    await writeSecrets(id, secrets);
    return list();
  });
}

export function secretDelete(id: string, key: string): Promise<EnvironmentInfo[]> {
  return withEnvOp(id, async () => {
    requireEnv(id);
    const secrets = envSecrets(id);
    delete secrets[key];
    await writeSecrets(id, secrets);
    return list();
  });
}

async function writeSecrets(id: string, secrets: Record<string, string>): Promise<void> {
  saveSecret(secretsStoreName(id), JSON.stringify(secrets));
  if ((await runtimeStatus(id)) === 'running') await injectSecretsFile(id);
}

async function toInfo(env: StoredEnv): Promise<EnvironmentInfo> {
  return {
    ...env,
    status: await runtimeStatus(env.id),
    active: env.id === load().activeEnvId,
    secretKeys: Object.keys(envSecrets(env.id)).sort(),
  };
}

export async function list(): Promise<EnvironmentInfo[]> {
  return Promise.all(load().environments.map(toInfo));
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
  return list();
}

export async function update(id: string, cfg: EnvironmentConfig): Promise<EnvironmentInfo[]> {
  const s = load();
  const idx = s.environments.findIndex((e) => e.id === id);
  if (idx === -1) throw new Error('Unknown environment');
  s.environments[idx] = { id, ...sanitize(cfg, id) };
  save();
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

// One mutex per environment across ALL lifecycle ops: a queued start must
// not resurrect a just-deleted container, and rm must not race a doStart.
// "Op", not "lock": beyond serializing, every op first detaches the env's
// runner exec — a live runner must not outlive its container state, and the
// next turn's runner picks up new secrets / a redeployed runner.js. An op
// that must NOT quiesce the runner (none exist today) needs a new helper.
const envLocks = new Map<string, Promise<unknown>>();
function withEnvOp<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = envLocks.get(id) ?? Promise.resolve();
  const task = prev
    .catch(() => undefined)
    .then(() => {
      detachRunner(id);
      return fn();
    });
  envLocks.set(id, task);
  void task.catch(() => undefined).finally(() => {
    if (envLocks.get(id) === task) envLocks.delete(id);
  });
  return task;
}

export function start(id: string): Promise<EnvironmentInfo[]> {
  return withEnvOp(id, () => doStart(id));
}

export function stop(id: string): Promise<EnvironmentInfo[]> {
  return withEnvOp(id, async () => {
    requireEnv(id);
    await doStop(id);
    return list();
  });
}

export function restart(id: string): Promise<EnvironmentInfo[]> {
  return withEnvOp(id, async () => {
    requireEnv(id);
    await doStop(id);
    return doStart(id);
  });
}

/** Destroy the container and recreate from current config (incl. build). */
export function rebuild(id: string): Promise<EnvironmentInfo[]> {
  return withEnvOp(id, async () => {
    requireEnv(id);
    await doStop(id); // adopts rotated credentials; ignores not-running
    await docker(['rm', '-f', containerName(id)]);
    notifyReset(id); // container transcripts are gone — resume ids with them
    return doStart(id);
  });
}

export function remove(id: string): Promise<EnvironmentInfo[]> {
  return withEnvOp(id, async () => {
    requireEnv(id);
    await docker(['rm', '-f', containerName(id)]);
    await docker(['rmi', imageTag(id)]);
    deleteSecret(secretsStoreName(id));
    const s = load();
    s.environments = s.environments.filter((e) => e.id !== id);
    if (s.activeEnvId === id) s.activeEnvId = s.environments[0]?.id ?? null;
    save();
    notifyReset(id);
    return list();
  });
}

async function doStart(id: string): Promise<EnvironmentInfo[]> {
  const env = requireEnv(id);

  const state = await containerState(id);
  if (state === 'missing') {
    // Build the per-environment image when a Dockerfile is configured.
    let image = env.image;
    if (env.dockerfile.trim()) {
      const ctx = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-build-'));
      fs.writeFileSync(path.join(ctx, 'Dockerfile'), env.dockerfile);
      const build = await docker(['build', '-t', imageTag(id), ctx], 10 * 60_000);
      if (build.code !== 0) {
        throw new Error(`Docker build failed: ${build.stderr.trim().slice(-600)}`);
      }
      image = imageTag(id);
    }

    const workspace = expandHome(env.workspacePath);
    fs.mkdirSync(workspace, { recursive: true });
    const args = [
      'run', '-d',
      '--name', containerName(id),
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
    const r = await docker(args, 120_000);
    if (r.code !== 0) {
      throw new Error(r.stderr.trim() || 'docker run failed — is Docker running?');
    }
  } else if (state === 'stopped') {
    const r = await docker(['start', containerName(id)]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'docker start failed');
  }

  await dockerOrThrow(['exec', containerName(id), 'mkdir', '-p', '/opt/puck'], 'Environment setup failed');
  if (env.autoInstall) {
    for (const script of bootstrapPlan(providers)) {
      await dockerOrThrow(
        ['exec', containerName(id), 'sh', '-lc', script],
        'Environment bootstrap failed',
        10 * 60_000,
      );
    }
  }

  // Copy file-based CLI credentials from the host. Bind mounts are not
  // reliable for this across Docker runtimes (a colima VM without $HOME
  // sharing silently yields empty dirs), so docker cp on every start.
  for (const p of providers) {
    const cred = p.container.credential;
    if (!fs.existsSync(cred.hostPath)) continue;
    const dest = path.posix.dirname(cred.containerPath) + '/';
    await dockerOrThrow(['exec', containerName(id), 'mkdir', '-p', dest], `${p.label} credential setup failed`);
    await dockerOrThrow(['cp', cred.hostPath, `${containerName(id)}:${dest}`], `${p.label} credential copy failed`);
  }

  // Deploy (or refresh) the runner agent.
  await copyIntoContainer(id, RUNNER_SOURCE, '/opt/puck/runner.js', 'Runner deploy failed');

  await injectSecretsFile(id);
  // Puck-managed OAuth tokens win over host files when fresher.
  for (const p of providers) await injectCredentials(id, p);
  return list();
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
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-cp-'));
  try {
    const tmp = path.join(tmpDir, path.posix.basename(containerPath));
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    await dockerOrThrow(['cp', tmp, `${containerName(id)}:${containerPath}`], what);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Environment secrets as a root-only container file (never docker argv). */
async function injectSecretsFile(id: string): Promise<void> {
  const what = 'Secrets injection failed';
  await dockerOrThrow(['exec', containerName(id), 'mkdir', '-p', '/opt/puck'], what);
  await copyIntoContainer(id, JSON.stringify(envSecrets(id)), '/opt/puck/secrets.json', what);
  await dockerOrThrow(['exec', containerName(id), 'chmod', '600', '/opt/puck/secrets.json'], what);
}

/**
 * Write Puck-managed OAuth tokens into a container as the provider's CLI
 * credential file — unless the container already holds fresher ones (CLIs
 * rotate tokens themselves mid-session, which we adopt back).
 */
async function injectCredentials(id: string, p: Provider): Promise<void> {
  const cred = p.container.credential;
  const snapshot = await cred.fresh();
  if (!snapshot) return;
  const existing = await docker(['exec', containerName(id), 'cat', cred.containerPath]);
  if (existing.code === 0) {
    cred.adoptIfNewer(existing.stdout);
    if (!snapshot.supersedes(existing.stdout)) return;
  }
  await dockerOrThrow(
    ['exec', containerName(id), 'mkdir', '-p', path.posix.dirname(cred.containerPath)],
    `${p.label} credential setup failed`,
  );
  await copyIntoContainer(id, snapshot.content, cred.containerPath, `${p.label} credential copy failed`);
}

/** Push freshly obtained credentials into every running environment. */
export async function injectCredentialsIntoRunning(): Promise<void> {
  for (const env of load().environments) {
    if ((await runtimeStatus(env.id)) === 'running') {
      for (const p of providers) await injectCredentials(env.id, p);
    }
  }
}

async function doStop(id: string): Promise<void> {
  // Providers may have rotated tokens inside the container — adopt them
  // before the container goes away so Puck's copies stay valid.
  for (const p of providers) {
    const creds = await docker(['exec', containerName(id), 'cat', p.container.credential.containerPath]);
    if (creds.code === 0) p.container.credential.adoptIfNewer(creds.stdout);
  }
  await docker(['stop', containerName(id)], 60_000);
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
