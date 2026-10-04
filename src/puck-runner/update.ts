/**
 * Self-update. The runner asks the server for the latest release on
 * connect and every few hours (and at once when the server says this
 * version is too old). A newer tarball for this platform is downloaded from
 * the server, checked against the sha256 the server published, unpacked
 * into `_update/<version>/`, and smoke-tested by running its own Node
 * runtime. Then the shipped files (`SHIPPED`, the package layout's top
 * level) are swapped in by rename, the previous ones kept under
 * `_update/previous/`, and the runner exits with UPDATE_EXIT; run.sh starts
 * the new version.
 *
 * Restarting the runner never touches environments: containers run under
 * the Docker engine with their own restart policy, and the runner only
 * relays. Once a newer release is chosen, the runner refuses new control
 * commands for the download and the swap, and waits until every command
 * already running has finished before it swaps (`Control.drain` in
 * control.ts). If the update fails, it accepts commands again.
 * `--disableupdate` at configuration turns this off; a server that requires
 * a newer version then refuses the runner until it is updated by hand.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RUNNER_PACKAGE_ENTRIES, type ListedRunnerAsset } from '../harness/runner-releases';
import type { ServerApi } from './api';
import type { RunnerPaths } from './files';
import type { Logger } from './log';

/** run.sh restarts the runner when it exits with this code. */
export const UPDATE_EXIT = 3;
export const CHECK_EVERY_MS = 6 * 60 * 60_000;

/**
 * What a release ships, and so what an update replaces: the top level of the
 * package layout (RUNNER_PACKAGE_ENTRIES). Registration files, logs and the
 * cache stay.
 */
export const SHIPPED: readonly string[] = [...new Set(RUNNER_PACKAGE_ENTRIES.map((e) => e.name.split('/')[0]))];

export type Exec = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realExec: Exec = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** MAJOR.MINOR.PATCH comparison; anything unparsable sorts first. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export interface UpdateDeps {
  api: ServerApi;
  paths: RunnerPaths;
  version: string;
  os: 'linux' | 'macos';
  arch: 'x64' | 'arm64';
  log: Logger;
  exec?: Exec;
}

/** The newer release asset for this platform, or null. */
export async function findUpdate(deps: UpdateDeps): Promise<ListedRunnerAsset | null> {
  const releases = await deps.api.releases();
  if (!releases.latest || compareVersions(releases.latest, deps.version) <= 0) return null;
  return releases.assets.find((a) => a.version === releases.latest && a.os === deps.os && a.arch === deps.arch) ?? null;
}

export class UpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateError';
  }
}

/**
 * Downloads, verifies, unpacks, smoke-tests and swaps in `asset`.
 * `beforeSwap` runs after the smoke test and before anything in the runner
 * directory is replaced. On failure nothing in the runner directory changed.
 */
export async function applyUpdate(deps: UpdateDeps, asset: ListedRunnerAsset, beforeSwap?: () => Promise<void>): Promise<void> {
  const exec = deps.exec ?? realExec;
  const { paths, log } = deps;
  if (!/^\d+\.\d+\.\d+$/.test(asset.version) || !/^[0-9a-f]{64}$/.test(asset.sha256) || path.basename(asset.file) !== asset.file) {
    throw new UpdateError('The server listed a malformed runner release.');
  }
  fs.mkdirSync(paths.update, { recursive: true, mode: 0o700 });
  const archive = path.join(paths.update, asset.file);
  const staging = path.join(paths.update, asset.version);
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    log.info('update.download', { version: asset.version, file: asset.file });
    const hash = createHash('sha256');
    const body = await deps.api.download(asset.url);
    body.on('data', (chunk: Buffer) => hash.update(chunk));
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(archive, { mode: 0o600 });
      body.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
      body.pipe(out);
    });
    const actual = hash.digest('hex');
    if (actual !== asset.sha256) throw new UpdateError(`The download does not match its published sha256 (got ${actual.slice(0, 12)}…).`);

    fs.mkdirSync(staging, { recursive: true });
    const untar = await exec('tar', ['-xzf', archive, '-C', staging], { timeoutMs: 300_000 });
    if (untar.code !== 0) throw new UpdateError(`Unpacking the update failed: ${untar.stderr.trim().slice(-300)}`);
    const shippedVersion = fs.readFileSync(path.join(staging, 'VERSION'), 'utf8').trim();
    if (shippedVersion !== asset.version) throw new UpdateError(`The update says it is ${shippedVersion}, not ${asset.version}.`);
    const probe = await exec(path.join(staging, 'bin', 'node'), [path.join(staging, 'bin', 'puck-runner.cjs'), 'version'], { timeoutMs: 60_000 });
    if (probe.code !== 0 || !probe.stdout.includes(asset.version)) {
      throw new UpdateError(`The new runner does not start on this machine: ${(probe.stderr || probe.stdout).trim().slice(-300)}`);
    }
    if (beforeSwap) await beforeSwap();
    swapIn(paths, staging);
    log.info('update.installed', { from: deps.version, to: asset.version });
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Renames the shipped files of `staging` over the runner's, keeping the old ones; rolls back on any failure. */
export function swapIn(paths: RunnerPaths, staging: string): void {
  const previous = path.join(paths.update, 'previous');
  fs.rmSync(previous, { recursive: true, force: true });
  fs.mkdirSync(previous, { recursive: true });
  const done: { item: string; hadOld: boolean }[] = [];
  try {
    for (const item of SHIPPED) {
      const incoming = path.join(staging, item);
      if (!fs.existsSync(incoming)) continue;
      const current = path.join(paths.root, item);
      const hadOld = fs.existsSync(current);
      if (hadOld) fs.renameSync(current, path.join(previous, item));
      done.push({ item, hadOld });
      fs.renameSync(incoming, current);
    }
  } catch (err) {
    for (const { item, hadOld } of done.reverse()) {
      const current = path.join(paths.root, item);
      try {
        if (fs.existsSync(current)) fs.renameSync(current, path.join(staging, item));
        if (hadOld) fs.renameSync(path.join(previous, item), current);
      } catch {
        // best effort: the previous files are still under _update/previous
      }
    }
    throw new UpdateError(`Installing the update failed: ${(err as Error).message}`);
  }
}
