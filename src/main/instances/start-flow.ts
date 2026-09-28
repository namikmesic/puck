/**
 * Starting an environment: preflight, then create.
 *
 * Preflight fails with one specific message before anything is created:
 * the definition resolves and is valid (its orchestrator uses Claude Code),
 * every harness it references is signed in, every secret it names has a
 * value, and the runner can take it (online, Docker healthy, below its
 * maximum, big enough, and its key unchanged).
 *
 * Create:
 * 1. The Puck server records the environment (`POST /v1/instances`): it
 *    mints the `env_` id and checks the user's push access to every
 *    repository. There is no GitHub step in the app: the runner fetches the
 *    environment's installation tokens from the server itself.
 * 2. The daemon bundle goes to the runner's cache unless it has it
 *    (`bundle.has`, then `bundle.put` in chunks).
 * 3. `instance.create` carries the image or Dockerfile, resources, the
 *    harness container environment, and the inbox: the resolved definition,
 *    fresh harness credential files and the secret values, all over the
 *    encrypted (or local) channel. The runner streams its stages.
 * A failure after step 1 forgets the index entry again, so nothing is left
 * half-made; the runner cleans up its own partial container.
 */

import type { Pin } from '../../harness/daemon-protocol';
import type { ResolvedEnvironment } from '../../harness/definitions/types';
import { readDefinition } from '../../harness/env-definition';
import { placement, type PlacementRunner } from '../../harness/placement';
import { RUNNER_LIMITS, type ControlArgs, type ControlEvent, type ControlOp, type ControlResult, type InstanceStage } from '../../harness/runner-protocol';
import type { PinSpec, StartSpec } from '../../harness/bridge';

export interface StartDeps {
  resolve(pin: PinSpec, name: string): Promise<ResolvedEnvironment>;
  runner(runnerId: string): (PlacementRunner & { id: string }) | null;
  /** Environments the index places on the runner now. */
  hosted(runnerId: string): number;
  /** Throws when channels to the runner cannot open (unknown, changed key). */
  checkTransport(runnerId: string): void;
  harnessSignedIn(id: string): boolean;
  harnessLabel(id: string): string;
  /** A fresh credential file for a signed-in harness, or null. */
  harnessCredential(id: string): Promise<string | null>;
  containerEnv(harnessId: string): Record<string, string>;
  createIndexEntry(req: { runnerId: string; definition: string; repos: string[]; policies?: { github?: Record<string, unknown> } }): Promise<{ envId: string }>;
  forgetIndexEntry(envId: string): Promise<void>;
  control<O extends ControlOp>(
    runnerId: string,
    op: O,
    args: ControlArgs<O>,
    opts?: { timeoutMs?: number; onEvent?: (ev: ControlEvent) => void },
  ): Promise<ControlResult<O>>;
  daemonBundle(): { source: string; sha: string };
  onStage(envId: string, stage: InstanceStage, detail: string): void;
  log: { info(msg: string, meta?: Record<string, unknown>): void };
}

export interface StartPlan {
  definition: ResolvedEnvironment;
  pin: Pin;
  harnesses: string[];
  runnerId: string;
}

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

/** The harness ids an environment's agents use. */
export function harnessesOf(def: ResolvedEnvironment): string[] {
  return [...new Set(Object.values(def.agentDefinitions).map((a) => a.harness))].sort();
}

export async function preflight(spec: StartSpec, deps: StartDeps): Promise<StartPlan> {
  const definition = await deps.resolve(spec.pin, spec.definition);
  const read = readDefinition(definition);
  if (!read.ok) throw new PreflightError(read.error);
  const harnesses = harnessesOf(definition);
  for (const id of harnesses) {
    if (!deps.harnessSignedIn(id)) throw new PreflightError(`Connect ${deps.harnessLabel(id)} first (Settings → Providers): this environment's agents use it.`);
  }
  const missing = definition.secrets.filter((name) => !spec.secrets[name]);
  if (missing.length) throw new PreflightError(`Give a value for ${missing.join(', ')}: the definition needs ${missing.length === 1 ? 'it' : 'them'}.`);
  const runner = deps.runner(spec.runnerId);
  if (!runner) throw new PreflightError('That runner is not in your runner list.');
  const fit = placement(runner, deps.hosted(runner.id), definition.resources);
  if (!fit.ok) throw new PreflightError(fit.reason ?? 'That runner cannot take this environment.');
  try {
    deps.checkTransport(runner.id);
  } catch (err) {
    throw new PreflightError((err as Error).message);
  }
  return { definition, pin: definition.source.pin, harnesses, runnerId: runner.id };
}

/** Makes sure the runner's cache holds this app's daemon bundle. */
export async function uploadBundle(runnerId: string, deps: Pick<StartDeps, 'control' | 'daemonBundle'>): Promise<string> {
  const { source, sha } = deps.daemonBundle();
  const { has } = await deps.control(runnerId, 'bundle.has', { sha });
  if (has) return sha;
  const bytes = Buffer.from(source, 'utf8');
  const step = RUNNER_LIMITS.maxBundleChunkBytes;
  for (let offset = 0; offset < bytes.length || offset === 0; offset += step) {
    const chunk = bytes.subarray(offset, Math.min(offset + step, bytes.length));
    const last = offset + step >= bytes.length;
    await deps.control(runnerId, 'bundle.put', { sha, offset, data: chunk.toString('base64'), last }, { timeoutMs: 120_000 });
    if (last) break;
  }
  return sha;
}

/** What `instance.create` and `instance.rebuild` build from, for a definition. */
export function buildArgs(envId: string, def: ResolvedEnvironment, bundleSha: string, deps: Pick<StartDeps, 'containerEnv'>) {
  const containerEnv: Record<string, string> = {};
  for (const id of harnessesOf(def)) Object.assign(containerEnv, deps.containerEnv(id));
  const resources: { cpus?: number; memory?: string } = {};
  if (def.resources.cpus !== null) resources.cpus = def.resources.cpus;
  if (def.resources.memory !== null) resources.memory = def.resources.memory;
  return {
    envId,
    ...(def.dockerfile ? { dockerfile: def.dockerfile.blob } : { image: def.image ?? 'node:22-bookworm' }),
    resources,
    containerEnv,
    bundleSha,
  };
}

/** Runs create after a passed preflight; resolves with the new environment's id. */
export async function create(plan: StartPlan, spec: StartSpec, deps: StartDeps, onCreated: (envId: string) => void): Promise<string> {
  const def = plan.definition;
  const policies = (def.policies as { github?: Record<string, unknown> }).github;
  const { envId } = await deps.createIndexEntry({
    runnerId: plan.runnerId,
    definition: def.name,
    repos: def.repos.map((r) => r.github),
    ...(policies ? { policies: { github: policies } } : {}),
  });
  onCreated(envId);
  try {
    const bundleSha = await uploadBundle(plan.runnerId, deps);
    const harness: { id: string; content: string }[] = [];
    for (const id of plan.harnesses) {
      const content = await deps.harnessCredential(id);
      if (content) harness.push({ id, content });
    }
    const secrets: Record<string, string> = {};
    for (const name of def.secrets) secrets[name] = spec.secrets[name];
    await deps.control(
      plan.runnerId,
      'instance.create',
      {
        ...buildArgs(envId, def, bundleSha, deps),
        inbox: {
          instance: { envId, name: def.name, pin: plan.pin, definition: def },
          ...(harness.length ? { harness } : {}),
          ...(def.secrets.length ? { secrets } : {}),
        },
      },
      {
        timeoutMs: 60 * 60_000,
        onEvent: (ev) => {
          if (ev.kind === 'instance.stage' && ev.envId === envId) deps.onStage(envId, ev.stage, ev.detail ?? '');
        },
      },
    );
    deps.log.info('instance.created', { envId, runnerId: plan.runnerId, definition: def.name });
    return envId;
  } catch (err) {
    await deps.forgetIndexEntry(envId).catch(() => undefined);
    throw err;
  }
}
