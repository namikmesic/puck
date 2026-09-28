/**
 * The control channel: the app's commands to this runner (the op table is
 * src/harness/runner-protocol.ts). Every argument is validated here before
 * it reaches Docker; operations on one environment run one at a time; long
 * ones stream `instance.stage` events on the channel that asked.
 *
 * On create the runner fetches the environment's first GitHub grants from
 * the Puck server itself and adds them to the inbox, so GitHub tokens never
 * pass through the app.
 */

import {
  CONTROL_OPS,
  ENV_ID_RE,
  isControlOp,
  RUNNER_LIMITS,
  RUNNER_PROTOCOL_VERSION,
  type ControlArgs,
  type ControlEvent,
  type ControlOp,
  type ControlResult,
  type ControlRunnerFrame,
  type InstanceBuild,
  type InstanceInbox,
  type InstanceStage,
  type RunnerErrorCode,
  type RunnerInfo,
} from '../harness/runner-protocol';
import type { GithubGrant } from '../harness/daemon-protocol';
import { readDefinition } from '../harness/env-definition';
import { validHarnessContent, validPin, validSecretValues } from '../harness/inbox';
import { ApiError } from './api';
import { BundleCache, BundleError, SHA_RE } from './bundles';
import { DockerError } from './docker/client';
import type { DockerOps } from './docker/ops';
import { tailLog, type Logger } from './log';

export class ControlError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

type Obj = Record<string, unknown>;

function bad(message: string): never {
  throw new ControlError('invalid-args', message);
}

function obj(args: unknown): Obj {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) bad('Arguments must be an object.');
  return args as Obj;
}

function envId(o: Obj): string {
  if (typeof o.envId !== 'string' || !ENV_ID_RE.test(o.envId)) bad('envId is not an environment id.');
  return o.envId;
}

function sha(o: Obj, key: string): string {
  const v = o[key];
  if (typeof v !== 'string' || !SHA_RE.test(v)) bad(`${key} must be a sha256 (64 lowercase hex).`);
  return v;
}

/** An image reference Docker accepts, and never something argv could read as a flag. */
const IMAGE_RE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/i;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MEMORY_RE = /^\d{1,12}(\.\d{1,3})?[bkmg]?$/i;

function build(o: Obj): InstanceBuild {
  const out: InstanceBuild = { envId: envId(o), bundleSha: sha(o, 'bundleSha') };
  const hasImage = o.image !== undefined;
  const hasDockerfile = o.dockerfile !== undefined;
  if (hasImage === hasDockerfile) bad('Give exactly one of image and dockerfile.');
  if (hasImage) {
    if (typeof o.image !== 'string' || !IMAGE_RE.test(o.image)) bad('image is not a Docker image reference.');
    out.image = o.image;
  } else {
    if (typeof o.dockerfile !== 'string' || !o.dockerfile.trim()) bad('dockerfile must be a non-empty string.');
    if (Buffer.byteLength(o.dockerfile, 'utf8') > RUNNER_LIMITS.maxDockerfileBytes) throw new ControlError('limit', 'The Dockerfile is too large.');
    out.dockerfile = o.dockerfile;
  }
  if (o.resources !== undefined) {
    const r = obj(o.resources);
    out.resources = {};
    if (r.cpus !== undefined) {
      if (typeof r.cpus !== 'number' || !Number.isFinite(r.cpus) || r.cpus <= 0 || r.cpus > 1024) bad('resources.cpus must be a positive number.');
      out.resources.cpus = r.cpus;
    }
    if (r.memory !== undefined) {
      if (typeof r.memory !== 'string' || !MEMORY_RE.test(r.memory)) bad('resources.memory must look like 512m or 8g.');
      out.resources.memory = r.memory;
    }
  }
  if (o.containerEnv !== undefined) {
    const env = obj(o.containerEnv);
    out.containerEnv = {};
    for (const [key, value] of Object.entries(env)) {
      if (!ENV_KEY_RE.test(key) || typeof value !== 'string' || value.includes('\0') || value.length > 4096) {
        bad(`containerEnv.${key.slice(0, 64)} is not a valid variable.`);
      }
      out.containerEnv[key] = value;
    }
  }
  return out;
}

function instanceFile(v: unknown, id: string): InstanceInbox['instance'] {
  const i = obj(v);
  if (i.envId !== id) bad('The instance file names another environment.');
  if (typeof i.name !== 'string' || !i.name || i.name.length > 200) bad('The instance file needs a name.');
  const def = readDefinition(i.definition);
  if (!def.ok) bad(def.error);
  const file: InstanceInbox['instance'] = { envId: id, name: i.name, definition: i.definition };
  if (i.pin !== undefined && i.pin !== null) {
    const pin = validPin(i.pin);
    if (!pin) bad('The instance pin must be a tag, branch, or commit with a hex sha.');
    file.pin = pin;
  }
  return file;
}

function inbox(v: unknown, id: string): InstanceInbox {
  const o = obj(v);
  const out: InstanceInbox = { instance: instanceFile(o.instance, id) };
  if (o.harness !== undefined) {
    if (!Array.isArray(o.harness) || o.harness.length > 8) bad('inbox.harness must be a short list.');
    out.harness = o.harness.map((h) => {
      const e = obj(h);
      if (typeof e.id !== 'string' || !validHarnessContent(e.id, e.content)) {
        bad('Each harness credential must be JSON for a known harness, at most 64KB.');
      }
      return { id: e.id, content: e.content };
    });
  }
  if (o.secrets !== undefined) {
    const secrets = validSecretValues(o.secrets);
    if (!secrets) bad('Secret names must be variable names that do not start with PUCK_, and each value must be at most 64KB.');
    out.secrets = secrets;
  }
  return out;
}

type Validators = { [O in ControlOp]: (args: unknown) => ControlArgs<O> };

export const VALIDATORS: Validators = {
  'runner.info': () => ({}) as ControlArgs<'runner.info'>,
  'instance.list': () => ({}) as ControlArgs<'instance.list'>,
  'bundle.has': (a) => ({ sha: sha(obj(a), 'sha') }),
  'bundle.put': (a) => {
    const o = obj(a);
    if (typeof o.offset !== 'number' || !Number.isSafeInteger(o.offset) || o.offset < 0) bad('offset must be a byte offset.');
    if (typeof o.data !== 'string') bad('data must be base64.');
    if (o.data.length > Math.ceil((RUNNER_LIMITS.maxBundleChunkBytes * 4) / 3) + 4) throw new ControlError('limit', 'The chunk is too large.');
    return { sha: sha(o, 'sha'), offset: o.offset, data: o.data, last: o.last === true };
  },
  'instance.create': (a) => {
    const o = obj(a);
    const b = build(o);
    return { ...b, inbox: inbox(o.inbox, b.envId) };
  },
  'instance.start': (a) => ({ envId: envId(obj(a)) }),
  'instance.stop': (a) => ({ envId: envId(obj(a)) }),
  'instance.rebuild': (a) => {
    const o = obj(a);
    const b = build(o);
    return { ...b, instance: instanceFile(o.instance, b.envId) };
  },
  'instance.delete': (a) => ({ envId: envId(obj(a)) }),
  'instance.stageDaemon': (a) => {
    const o = obj(a);
    return { envId: envId(o), bundleSha: sha(o, 'bundleSha') };
  },
  'logs.tail': (a) => {
    const o = obj(a);
    const lines = o.lines === undefined ? 200 : o.lines;
    if (typeof lines !== 'number' || !Number.isInteger(lines) || lines < 1) bad('lines must be a positive integer.');
    return { lines: Math.min(lines, RUNNER_LIMITS.maxLogLines) };
  },
};

export interface ControlDeps {
  ops: DockerOps;
  bundles: BundleCache;
  log: Logger;
  info(): Promise<RunnerInfo>;
  /** The first GitHub grants for a new environment, from the Puck server. */
  mint(envId: string): Promise<GithubGrant[]>;
  /** A container of this runner started (the token pump checks it). */
  started(envId: string): void;
  /** A container is gone (the token pump drops it). */
  removed(envId: string): void;
  maxEnvironments(): number | null;
}

type Handlers = { [O in ControlOp]: (args: ControlArgs<O>, emit: (ev: ControlEvent) => void) => Promise<ControlResult<O>> };

/**
 * Serializes operations per environment and counts the ones in flight.
 * `drain` refuses every new command until `releaseDrain`; commands already
 * running stay in `busy` until they finish. Self-update holds that drain
 * across the download and waits for `busy` to clear before it swaps.
 */
export class Control {
  private readonly chains = new Map<string, Promise<unknown>>();
  private busyCount = 0;
  private draining = false;

  constructor(private readonly deps: ControlDeps) {}

  get busy(): boolean {
    return this.busyCount > 0;
  }

  /** Refuses new commands. In-flight ones keep running and still count as `busy`. */
  drain(): void {
    this.draining = true;
  }

  releaseDrain(): void {
    this.draining = false;
  }

  private serial<T>(envId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(envId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(envId, next);
    void next.finally(() => {
      if (this.chains.get(envId) === next) this.chains.delete(envId);
    }).catch(() => undefined);
    return next;
  }

  private stages(envId: string, emit: (ev: ControlEvent) => void) {
    return (stage: InstanceStage, detail?: string): void => emit({ kind: 'instance.stage', envId, stage, ...(detail ? { detail } : {}) });
  }

  private readonly handlers: Handlers = {
    'runner.info': () => this.deps.info(),
    'instance.list': async () => ({ instances: await this.deps.ops.list() }),
    'bundle.has': async ({ sha: s }) => ({ has: this.deps.bundles.has(s) }),
    'bundle.put': async ({ sha: s, offset, data, last }) => this.deps.bundles.put(s, offset, Buffer.from(data, 'base64'), last),
    'instance.create': (args, emit) =>
      this.serial(args.envId, async () => {
        if ((await this.deps.ops.state(args.envId)) !== null) {
          throw new ControlError('invalid-state', 'This environment already has a container on this runner.');
        }
        const max = this.deps.maxEnvironments();
        if (max !== null && (await this.deps.ops.list()).length >= max) {
          throw new ControlError('limit', `This runner hosts at most ${max} environments.`);
        }
        const bundle = this.deps.bundles.get(args.bundleSha);
        let github: GithubGrant[];
        try {
          github = await this.deps.mint(args.envId);
        } catch (err) {
          throw new ControlError('server', `Could not get GitHub access for this environment from the Puck server: ${(err as Error).message}`);
        }
        await this.deps.ops.create(args, { bundle, inbox: args.inbox, github }, this.stages(args.envId, emit));
        this.deps.log.info('instance.created', { envId: args.envId, installations: github.length });
        this.deps.started(args.envId);
        return {};
      }),
    'instance.start': ({ envId: id }) =>
      this.serial(id, async () => {
        await this.existing(id);
        await this.deps.ops.start(id);
        this.deps.log.info('instance.started', { envId: id });
        this.deps.started(id);
        return {};
      }),
    'instance.stop': ({ envId: id }) =>
      this.serial(id, async () => {
        await this.existing(id);
        await this.deps.ops.stop(id);
        this.deps.log.info('instance.stopped', { envId: id });
        this.deps.removed(id);
        return {};
      }),
    'instance.rebuild': (args, emit) =>
      this.serial(args.envId, async () => {
        // A missing container whose volumes remain is a rebuild that already
        // removed it. Recreate on those volumes so a failed rebuild can be retried.
        if ((await this.deps.ops.state(args.envId)) === null && !(await this.deps.ops.volumesPresent(args.envId))) {
          throw new ControlError('not-found', 'This environment has no container on this runner.');
        }
        const bundle = this.deps.bundles.get(args.bundleSha);
        await this.deps.ops.rebuild(args, { bundle, instance: args.instance }, this.stages(args.envId, emit));
        this.deps.log.info('instance.rebuilt', { envId: args.envId });
        this.deps.started(args.envId);
        return {};
      }),
    'instance.delete': ({ envId: id }, emit) =>
      this.serial(id, async () => {
        this.deps.removed(id);
        await this.deps.ops.delete(id, this.stages(id, emit));
        this.deps.log.info('instance.deleted', { envId: id });
        return {};
      }),
    'instance.stageDaemon': ({ envId: id, bundleSha }, emit) =>
      this.serial(id, async () => {
        await this.existing(id);
        this.stages(id, emit)('staging-daemon');
        await this.deps.ops.stageDaemon(id, this.deps.bundles.get(bundleSha));
        return {};
      }),
    // The support bundle reads this. tailLog redacts the text, and the validator caps the line count.
    'logs.tail': async ({ lines }) => ({ text: tailLog(this.deps.log, lines) }),
  };

  private async existing(id: string): Promise<void> {
    if ((await this.deps.ops.state(id)) === null) throw new ControlError('not-found', 'This environment has no container on this runner.');
  }

  /** Runs one command frame; the result frame is always a `res`. */
  async handle(frame: unknown, emit: (ev: ControlEvent) => void): Promise<ControlRunnerFrame> {
    const f = frame as { t?: unknown; id?: unknown; op?: unknown; args?: unknown } | null;
    const id = typeof f?.id === 'string' ? f.id.slice(0, 64) : '';
    if (!f || f.t !== 'cmd' || !id) return { t: 'error', code: 'bad-frame', message: 'Expected { t: "cmd", id, op, args }.' };
    if (this.draining) {
      return { t: 'res', id, ok: false, error: { code: 'invalid-state', message: 'The runner is installing an update and is not accepting commands.' } };
    }
    if (!isControlOp(f.op)) return { t: 'res', id, ok: false, error: { code: 'invalid-args', message: `Unknown op ${String(f.op).slice(0, 40)}.` } };
    const op = f.op;
    this.busyCount++;
    try {
      const args = (VALIDATORS[op] as (a: unknown) => unknown)(f.args);
      const handler = this.handlers[op] as (a: unknown, e: (ev: ControlEvent) => void) => Promise<unknown>;
      const result = await handler(args, emit);
      return { t: 'res', id, ok: true, result };
    } catch (err) {
      const { code, message } = describe(err);
      if (code === 'internal' || code === 'docker') this.deps.log.warn('control.failed', { op, code, message: message.slice(0, 300) });
      return { t: 'res', id, ok: false, error: { code, message } };
    } finally {
      this.busyCount--;
    }
  }
}

function describe(err: unknown): { code: RunnerErrorCode; message: string } {
  if (err instanceof ControlError) return { code: err.code, message: err.message };
  if (err instanceof BundleError) return { code: err.code, message: err.message };
  if (err instanceof DockerError) return { code: 'docker', message: err.message };
  if (err instanceof ApiError) return { code: 'server', message: err.message };
  return { code: 'internal', message: err instanceof Error ? err.message : 'Something went wrong on the runner.' };
}

export function welcomeFrame(runnerId: string, version: string): ControlRunnerFrame {
  return { t: 'welcome', protocol: RUNNER_PROTOCOL_VERSION, runnerId, version };
}

/** Every op in the protocol has a validator and a handler (a unit test calls this). */
export function controlTableTotal(): boolean {
  return Object.keys(CONTROL_OPS).every((op) => op in VALIDATORS);
}
