/**
 * The runner control protocol: what the app says to a puck-runner over a
 * `control` channel, declared once here so the runner and (later) the app
 * compile against the same table.
 *
 * A control channel is an end-to-end encrypted byte stream (src/channel)
 * carrying NDJSON, in the daemon protocol's style. On open the runner sends
 * `welcome`; the app then sends commands and gets one `res` per `cmd`, by
 * id, in any order. Long operations stream `event` frames (instance stages)
 * before their result.
 *
 * An `attach` channel carries no frames of this module: it is a raw byte
 * pipe to `puckd attach` inside one environment, and the daemon protocol
 * (daemon-protocol.ts) runs end to end over it.
 *
 * Versioning follows the daemon protocol: new optional fields and new ops
 * do not bump RUNNER_PROTOCOL_VERSION; changing or removing a shape does.
 */

export const RUNNER_PROTOCOL_VERSION = 1;

/** Limits both ends apply. */
export const RUNNER_LIMITS = {
  /** One control frame (one line of UTF-8 JSON). */
  maxFrameBytes: 4 * 1024 * 1024,
  /** Raw bytes per `bundle.put` chunk (sent base64). */
  maxBundleChunkBytes: 1024 * 1024,
  /** A daemon bundle. */
  maxBundleBytes: 64 * 1024 * 1024,
  /** A Dockerfile piped to `docker build -`. */
  maxDockerfileBytes: 256 * 1024,
  /** Lines `logs.tail` returns at most. */
  maxLogLines: 2_000,
} as const;

/** Where the runner's app-side work for one environment is, streamed as `instance.stage` events. */
export type InstanceStage =
  | 'checking-image'
  | 'pulling-image'
  | 'building-image'
  | 'creating-volumes'
  | 'creating-container'
  | 'copying-files'
  | 'starting-container'
  | 'stopping-container'
  | 'removing-container'
  | 'removing-volumes'
  | 'removing-image'
  | 'staging-daemon';

export type RunnerErrorCode = 'invalid-args' | 'not-found' | 'invalid-state' | 'limit' | 'docker' | 'server' | 'internal';

/** Docker on the runner host, as its last health check found it. */
export interface RunnerDocker {
  ok: boolean;
  /** Docker server version, when reachable. */
  version: string | null;
  /** `docker-cli-missing`, `socket-permission`, `daemon-down`, `timeout` or `unknown`. */
  problem: string | null;
  /** What to tell the user about `problem`. */
  detail: string | null;
  ncpu: number | null;
  /** Bytes. */
  memTotal: number | null;
}

export interface RunnerInfo {
  runnerId: string;
  name: string;
  version: string;
  os: 'linux' | 'macos';
  arch: 'x64' | 'arm64';
  labels: string[];
  maxEnvironments: number | null;
  docker: RunnerDocker;
  /** Environments whose container is running. */
  running: number;
}

/** One environment container on the runner host, found by its `puck=instance` label. */
export interface InstanceSummary {
  envId: string;
  container: string;
  /** Docker's container state: `created`, `running`, `exited`, `restarting`, ... */
  state: string;
  /** The definition name the container was created from (label `puck.definition`). */
  definition: string | null;
  image: string;
}

/** Container resources; each maps to one `docker create` flag. */
export interface InstanceResources {
  /** `--cpus`. */
  cpus?: number;
  /** `--memory`, in Docker's notation (`512m`, `8g`). */
  memory?: string;
}

/** The files the daemon ingests from /puck/inbox on its first boot. */
export interface InstanceInbox {
  /** instance.json: `{ envId, name, pin, definition }` (the resolved definition). */
  instance: { envId: string; name: string; pin?: unknown; definition: unknown };
  /** Harness CLI credential files, verbatim (harness-<id>.json). */
  harness?: { id: string; content: string }[];
  /** Environment secret values (secrets.json). */
  secrets?: Record<string, string>;
}

/** What `instance.create` and `instance.rebuild` build a container from. Exactly one of image and dockerfile. */
export interface InstanceBuild {
  envId: string;
  image?: string;
  dockerfile?: string;
  resources?: InstanceResources;
  /** Non-secret container environment (`-e`); secrets travel in the inbox. */
  containerEnv?: Record<string, string>;
  /** sha256 of a daemon bundle already in the runner's cache (`bundle.has` / `bundle.put`). */
  bundleSha: string;
}

export interface InstanceCreate extends InstanceBuild {
  inbox: InstanceInbox;
}

export interface InstanceRebuild extends InstanceBuild {
  /** The new instance.json; the volumes, and so every store and secret, are kept. */
  instance: InstanceInbox['instance'];
}

type Empty = Record<string, never>;

export interface ControlOps {
  'runner.info': { args: Empty; result: RunnerInfo };
  'instance.list': { args: Empty; result: { instances: InstanceSummary[] } };
  'bundle.has': { args: { sha: string }; result: { has: boolean } };
  /** Chunks arrive in order; `offset` is where this one starts. The last one completes and checks the sha256. */
  'bundle.put': { args: { sha: string; offset: number; data: string; last: boolean }; result: { received: number; complete: boolean } };
  'instance.create': { args: InstanceCreate; result: Empty };
  'instance.start': { args: { envId: string }; result: Empty };
  'instance.stop': { args: { envId: string }; result: Empty };
  'instance.rebuild': { args: InstanceRebuild; result: Empty };
  /** Removes the container, both volumes, and the image built for it. */
  'instance.delete': { args: { envId: string }; result: Empty };
  /** Copies a cached bundle to /opt/puck/puckd.next.js; the app then sends `daemon.upgrade` over an attach channel. */
  'instance.stageDaemon': { args: { envId: string; bundleSha: string }; result: Empty };
  'logs.tail': { args: { lines: number }; result: { text: string } };
}

export type ControlOp = keyof ControlOps;
export type ControlArgs<O extends ControlOp> = ControlOps[O]['args'];
export type ControlResult<O extends ControlOp> = ControlOps[O]['result'];

/** Every op, as a value (a unit test checks the runner handles each one). */
export const CONTROL_OPS: { [O in ControlOp]: true } = {
  'runner.info': true,
  'instance.list': true,
  'bundle.has': true,
  'bundle.put': true,
  'instance.create': true,
  'instance.start': true,
  'instance.stop': true,
  'instance.rebuild': true,
  'instance.delete': true,
  'instance.stageDaemon': true,
  'logs.tail': true,
};

export function isControlOp(op: unknown): op is ControlOp {
  return typeof op === 'string' && Object.prototype.hasOwnProperty.call(CONTROL_OPS, op);
}

export type ControlEvent = { kind: 'instance.stage'; envId: string; stage: InstanceStage; detail?: string };

export type ControlClientFrame = { t: 'cmd'; id: string; op: ControlOp; args: unknown };

export type ControlRunnerFrame =
  | { t: 'welcome'; protocol: number; runnerId: string; version: string }
  | { t: 'res'; id: string; ok: true; result: unknown }
  | { t: 'res'; id: string; ok: false; error: { code: RunnerErrorCode; message: string } }
  | { t: 'event'; ev: ControlEvent }
  | { t: 'error'; code: 'bad-frame' | 'protocol-mismatch'; message: string };

/** Environment ids as the Puck server mints them. */
export const ENV_ID_RE = /^env_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Docker names for one environment. Image tags must be lowercase; container and volume names need not be. */
export function instanceNames(envId: string): { container: string; data: string; workspace: string; image: string } {
  return {
    container: `puck-${envId}`,
    data: `puck-${envId}-data`,
    workspace: `puck-${envId}-ws`,
    image: `puck-img-${envId.toLowerCase()}`,
  };
}
