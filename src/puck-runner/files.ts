/**
 * The runner directory: what the tarball ships and what registration adds.
 *
 *   config.sh  run.sh  svc.sh  VERSION        the scripts and the release version
 *   bin/node  bin/puck-runner.js             the bundled Node runtime and the runner
 *   .runner         { runnerId, name, serverUrl, labels, maxEnvironments, disableUpdate, owner }   0644
 *   .credentials    { runnerId, keyFile, keyFingerprint }                                        0600
 *   .runner_key     the runner's Ed25519 private key, PKCS#8 PEM                                0600
 *   .service        the installed service unit, when svc.sh installed one                      0644
 *   _diag/          runner.log and its two rotations, redacted                                0700
 *   cache/daemon/   <sha256>.js daemon bundles received from apps                            0700
 *   _update/        downloads and the previous version during a self-update
 *
 * The runner never stores its registration token, and nothing outside
 * this directory is written except the service unit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RunnerPaths {
  root: string;
  config: string;
  credentials: string;
  key: string;
  service: string;
  lock: string;
  diag: string;
  cache: string;
  update: string;
  version: string;
  bin: string;
  bundle: string;
  node: string;
}

export function runnerPaths(root: string): RunnerPaths {
  const at = (...p: string[]): string => path.join(root, ...p);
  return {
    root,
    config: at('.runner'),
    credentials: at('.credentials'),
    key: at('.runner_key'),
    service: at('.service'),
    lock: at('.runner.lock'),
    diag: at('_diag'),
    cache: at('cache', 'daemon'),
    update: at('_update'),
    version: at('VERSION'),
    bin: at('bin'),
    bundle: at('bin', 'puck-runner.js'),
    node: at('bin', 'node'),
  };
}

/** The runner directory: PUCK_RUNNER_ROOT, else the parent of bin/ holding this bundle. */
export function runnerRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PUCK_RUNNER_ROOT) return path.resolve(env.PUCK_RUNNER_ROOT);
  const bundle = typeof __filename === 'string' && __filename ? __filename : process.argv[1];
  return path.resolve(path.dirname(bundle), '..');
}

export interface RunnerConfig {
  runnerId: string;
  name: string;
  /** The server's own public URL, as its register response named it (assertion audiences use it). */
  serverUrl: string;
  labels: string[];
  maxEnvironments: number | null;
  disableUpdate: boolean;
  owner: string | null;
}

export interface RunnerCredentials {
  runnerId: string;
  keyFile: string;
  keyFingerprint: string;
}

export class NotConfiguredError extends Error {
  constructor() {
    super('This runner is not configured. Run ./config.sh --url <server> --token <token> first.');
    this.name = 'NotConfiguredError';
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Writes through a temp file and a rename, with the final mode set before the rename. */
export function writeFileAtomic(file: string, content: string | Buffer, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** True only when `.runner` exists. A key or `.credentials` without it is an unfinished registration. */
export function isConfigured(paths: RunnerPaths): boolean {
  return fs.existsSync(paths.config);
}

export function readConfig(paths: RunnerPaths): RunnerConfig {
  const c = readJson(paths.config);
  if (!c || typeof c.runnerId !== 'string' || typeof c.serverUrl !== 'string' || typeof c.name !== 'string') {
    throw new NotConfiguredError();
  }
  return {
    runnerId: c.runnerId,
    name: c.name,
    serverUrl: c.serverUrl.replace(/\/+$/, ''),
    labels: Array.isArray(c.labels) ? c.labels.filter((l): l is string => typeof l === 'string') : [],
    maxEnvironments: typeof c.maxEnvironments === 'number' ? c.maxEnvironments : null,
    disableUpdate: c.disableUpdate === true,
    owner: typeof c.owner === 'string' ? c.owner : null,
  };
}

export function writeConfig(paths: RunnerPaths, config: RunnerConfig): void {
  writeFileAtomic(paths.config, JSON.stringify(config, null, 2) + '\n', 0o644);
}

export function readCredentials(paths: RunnerPaths): RunnerCredentials {
  const c = readJson(paths.credentials);
  if (!c || typeof c.runnerId !== 'string' || typeof c.keyFile !== 'string') throw new NotConfiguredError();
  return { runnerId: c.runnerId, keyFile: c.keyFile, keyFingerprint: typeof c.keyFingerprint === 'string' ? c.keyFingerprint : '' };
}

export function writeCredentials(paths: RunnerPaths, creds: RunnerCredentials): void {
  writeFileAtomic(paths.credentials, JSON.stringify(creds, null, 2) + '\n', 0o600);
}

/** Deletes what registration created; the scripts, bin/, logs and the bundle cache stay. */
export function forgetRegistration(paths: RunnerPaths): void {
  for (const file of [paths.config, paths.credentials, paths.key]) fs.rmSync(file, { force: true });
}

/** The release version this directory holds (VERSION, else the bundled one). */
export function installedVersion(paths: RunnerPaths, fallback: string): string {
  try {
    const v = fs.readFileSync(paths.version, 'utf8').trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}
