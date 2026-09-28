/**
 * The Puck server's REST and push shapes as the app reads them. The server
 * (src/server) is the authority; these are the fields the app relies on,
 * read leniently, so a newer server that adds fields keeps working.
 */

/** Idle: online, hosting no running environment. Active: hosting one or more. Offline: no frame for 60 s. */
export type RunnerStatusWord = 'idle' | 'active' | 'offline';

/** Docker on a runner host, as the runner last reported it. */
export interface RunnerDockerInfo {
  ok: boolean;
  version: string | null;
  /** `docker-cli-missing`, `socket-permission`, `daemon-down`, `timeout` or `unknown`. */
  problem: string | null;
  ncpu: number | null;
  /** Bytes. */
  memTotal: number | null;
}

/** `GET /v1/runners` rows, and the `runner.upsert` payload. */
export interface ServerRunner {
  id: string;
  name: string;
  labels: string[];
  os: string;
  arch: string;
  version: string;
  /** The runner's Ed25519 public key, raw base64url. Channels to it must prove this key. */
  publicKey: string;
  fingerprint: string;
  maxEnvironments: number | null;
  docker: RunnerDockerInfo | null;
  status: RunnerStatusWord;
  running: number;
  createdAt: number;
  lastSeenAt: number | null;
}

/** active: on its runner. orphaned: its runner was removed and kept it. lost: its runner was force-removed. */
export type ServerInstanceStatus = 'active' | 'orphaned' | 'lost';

/** `GET /v1/instances` rows, and the `instance.upsert` payload. */
export interface ServerInstance {
  id: string;
  runnerId: string;
  definition: string;
  status: ServerInstanceStatus;
  createdAt: number;
  updatedAt: number;
  repos: { owner: string; name: string; revoked: boolean }[];
}

/** One runner tarball the server publishes (`GET /v1/runner/releases`). */
export interface RunnerAsset {
  os: string;
  arch: string;
  version: string;
  file: string;
  url: string;
  sha256: string;
  size: number;
}

export interface RunnerReleases {
  latest: string | null;
  minVersion: string | null;
  assets: RunnerAsset[];
}

/** What the server pushes on the app socket. */
export type ServerPush =
  | { type: 'runner.upsert'; runner: ServerRunner }
  | { type: 'runner.removed'; runnerId: string }
  | { type: 'instance.upsert'; instance: ServerInstance }
  | { type: 'instance.removed'; envId: string };

/** Record ids as the server mints them: a prefix and a ULID. */
export const RUNNER_ID_RE = /^rnr_[0-9A-HJKMNP-TV-Z]{26}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function dockerOf(v: unknown): RunnerDockerInfo | null {
  if (!isObj(v)) return null;
  return {
    ok: v.ok !== false,
    version: typeof v.version === 'string' ? v.version : null,
    problem: typeof v.problem === 'string' ? v.problem : null,
    ncpu: num(v.ncpu),
    memTotal: num(v.memTotal),
  };
}

/** A runner row, or null when it lacks an id or key. */
export function readRunner(v: unknown): ServerRunner | null {
  if (!isObj(v) || !RUNNER_ID_RE.test(str(v.id)) || !str(v.publicKey)) return null;
  const status = v.status === 'idle' || v.status === 'active' ? v.status : 'offline';
  return {
    id: str(v.id),
    name: str(v.name) || str(v.id),
    labels: strs(v.labels),
    os: str(v.os),
    arch: str(v.arch),
    version: str(v.version),
    publicKey: str(v.publicKey),
    fingerprint: str(v.fingerprint),
    maxEnvironments: num(v.maxEnvironments),
    docker: dockerOf(v.docker),
    status,
    running: num(v.running) ?? 0,
    createdAt: num(v.createdAt) ?? 0,
    lastSeenAt: num(v.lastSeenAt),
  };
}

/** An instance row, or null when it lacks its ids. */
export function readInstance(v: unknown): ServerInstance | null {
  if (!isObj(v) || !/^env_/.test(str(v.id)) || !RUNNER_ID_RE.test(str(v.runnerId))) return null;
  const status = v.status === 'orphaned' || v.status === 'lost' ? v.status : 'active';
  const repos = Array.isArray(v.repos)
    ? v.repos.flatMap((r) => (isObj(r) && str(r.owner) && str(r.name) ? [{ owner: str(r.owner), name: str(r.name), revoked: r.revoked === true }] : []))
    : [];
  return {
    id: str(v.id),
    runnerId: str(v.runnerId),
    definition: str(v.definition),
    status,
    createdAt: num(v.createdAt) ?? 0,
    updatedAt: num(v.updatedAt) ?? 0,
    repos,
  };
}

/** A push event the app understands, or null (newer kinds are ignored). */
export function readPush(v: unknown): ServerPush | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case 'runner.upsert': {
      const runner = readRunner(v.runner);
      return runner ? { type: 'runner.upsert', runner } : null;
    }
    case 'runner.removed':
      return RUNNER_ID_RE.test(str(v.runnerId)) ? { type: 'runner.removed', runnerId: str(v.runnerId) } : null;
    case 'instance.upsert': {
      const instance = readInstance(v.instance);
      return instance ? { type: 'instance.upsert', instance } : null;
    }
    case 'instance.removed':
      return str(v.envId) ? { type: 'instance.removed', envId: str(v.envId) } : null;
    default:
      return null;
  }
}

export function readReleases(v: unknown): RunnerReleases {
  const o = isObj(v) ? v : {};
  const assets = Array.isArray(o.assets)
    ? o.assets.flatMap((a) =>
        isObj(a) && str(a.url) && /^[0-9a-f]{64}$/.test(str(a.sha256))
          ? [{ os: str(a.os), arch: str(a.arch), version: str(a.version), file: str(a.file), url: str(a.url), sha256: str(a.sha256), size: num(a.size) ?? 0 }]
          : [],
      )
    : [];
  return { latest: typeof o.latest === 'string' ? o.latest : null, minVersion: typeof o.minVersion === 'string' ? o.minVersion : null, assets };
}
