/**
 * The This Mac runner: one click installs the same puck-runner every other
 * runner host runs, as a LaunchAgent of the user, and registers it; another
 * removes it again. The app then reaches it over its local socket, so local
 * environments need no server hop and stay reachable while the Puck server
 * is down, and the runner keeps their GitHub tokens fresh while the app is
 * closed.
 *
 * Install: the macOS ARM64 runner tarball the Puck server publishes is
 * downloaded and checked against its sha256, unpacked with /usr/bin/tar into
 * `<userData>/r/<account>`, one directory per Puck account, then driven by its own scripts' entry point with its
 * own Node runtime: `config --unattended … --labels local --local-socket
 * <dir>/local.sock` with a registration token read from a 0600 file (then
 * revoked), and `svc install` + `svc start`. The app's Electron binary is not
 * used as a Node runtime: packaged builds switch that off (the RunAsNode
 * fuse), and the runner updates itself from the server like any other.
 *
 * Uninstall: `config remove --unattended --keep-environments` (which stops
 * and removes the LaunchAgent and deregisters with the runner's own signed
 * request), then the directory goes. Environments are kept: containers and
 * volumes belong to Docker, and the user deletes them with docker when done.
 *
 * Nothing here runs docker; the runner does.
 */

import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LocalRunnerState } from '../../harness/bridge';
import type { ServerRunner } from '../../harness/server-api';
import { log } from '../log';
import * as api from '../server/api';
import { serverDeps } from '../server/http';
import { current, onSessionChange } from '../server/session';
import { forgetLocalRunner, localRunner, setLocalRunner, type LocalRunnerRecord } from './store';

/** Unix socket paths are limited to 104 bytes on macOS. */
const MAX_SOCKET_PATH_BYTES = 103;

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Exec = (file: string, args: string[], opts: { timeoutMs: number; cwd?: string }) => Promise<ExecResult>;

export const realExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.stdout.on('data', (d) => (stdout = (stdout + String(d)).slice(-16_000)));
    child.stderr.on('data', (d) => (stderr = (stderr + String(d)).slice(-16_000)));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

export interface ThisMacDeps {
  exec: Exec;
  platform: NodeJS.Platform;
  arch: string;
  hostname(): string;
  dataDir(): string;
  /** Resolves once the local socket accepts connections, or rejects. */
  waitForSocket(socket: string, timeoutMs: number): Promise<void>;
}

let deps: ThisMacDeps | null = null;

/** Test seam. */
export function useThisMacDeps(next: Partial<ThisMacDeps> | null): void {
  deps = next ? { ...defaultDeps(), ...next } : null;
}

function defaultDeps(): ThisMacDeps {
  return {
    exec: realExec,
    platform: process.platform,
    arch: process.arch,
    hostname: () => os.hostname(),
    dataDir: () => app.getPath('userData'),
    waitForSocket,
  };
}

function d(): ThisMacDeps {
  return deps ?? defaultDeps();
}

let busy: LocalRunnerState['busy'] = null;
let detail = '';
let lastError: string | null = null;
let listener: (() => void) | null = null;

/** Called whenever the This Mac state changes. */
export function onLocalChange(cb: () => void): void {
  listener = cb;
}

function progress(text: string): void {
  detail = text;
  listener?.();
}

export function supported(): boolean {
  return d().platform === 'darwin' && d().arch === 'arm64';
}

export function localState(): LocalRunnerState {
  const record = localRunner();
  return {
    supported: supported(),
    installed: !!record?.runnerId,
    runnerId: record?.runnerId ?? null,
    busy,
    detail: busy ? detail : record?.runnerId ? 'Installed as a LaunchAgent; environments run in Docker on this Mac.' : detail,
    error: lastError,
  };
}

/** Eight hex characters, so two account ids never share a directory or a socket path long enough to matter. */
export function accountKey(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 8);
}

/** LaunchAgent label for one Puck account. A second account gets a different label. */
export function serviceLabelFor(accountId: string): string {
  return `com.puck.runner.${accountKey(accountId)}`;
}

/** Advances on every Puck sign-in and sign-out. */
let sessionGeneration = 0;
onSessionChange(() => {
  sessionGeneration += 1;
});

function accountId(): string {
  const id = current()?.user.id;
  if (!id) throw new Error('Sign in to Puck first (Settings → Providers → GitHub).');
  return id;
}

/** The runner name This Mac registers under. */
export function localName(hostname: string): string {
  const host = hostname
    .replace(/\.local$/i, '')
    .replace(/[^A-Za-z0-9 ._-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 48);
  return host ? `This Mac (${host})` : 'This Mac';
}

const MACHINE_TAG_RE = /^[0-9a-f]{4}$/;

function machineTag(): string {
  const file = path.join(d().dataDir(), 'this-mac.id');
  let cur = '';
  try {
    cur = fs.readFileSync(file, 'utf8').trim();
  } catch {
    cur = '';
  }
  if (MACHINE_TAG_RE.test(cur)) return cur;
  const tag = randomBytes(2).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${tag}\n`, { mode: 0o600 });
  return tag;
}

function suffixedLocalName(base: string, tag: string): string {
  if (base.startsWith('This Mac (') && base.endsWith(')')) return `${base.slice(0, -1)} ${tag})`;
  return `This Mac (${tag})`;
}

function registrationTarget(existing: ServerRunner[], recordedId: string | null, hostname: string): { name: string; replace: boolean } {
  const own = recordedId ? existing.find((r) => r.id === recordedId) : undefined;
  if (own) return { name: own.name, replace: true };
  const base = localName(hostname);
  if (existing.some((r) => r.name === base)) return { name: suffixedLocalName(base, machineTag()), replace: false };
  return { name: base, replace: false };
}

function serviceAlreadyUp(message: string): boolean {
  return /already (bootstrapped|loaded|running)/i.test(message) || /Bootstrap failed: (5|17|37)\b/.test(message);
}

async function startRecorded(dir: string, socket: string, gate: () => void): Promise<void> {
  try {
    await runner(dir, ['svc', 'start'], 'Starting the runner', 60_000);
  } catch (err) {
    gate();
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('No service is installed')) {
      await runner(dir, ['svc', 'install'], 'Installing the LaunchAgent', 60_000);
      gate();
      await runner(dir, ['svc', 'start'], 'Starting the LaunchAgent', 60_000);
    } else if (!serviceAlreadyUp(message)) {
      throw err;
    }
  }
  gate();
  progress('Waiting for the runner…');
  await d().waitForSocket(socket, 60_000);
}

/** This account's runner directory. The socket stays under the unix-socket path limit. */
export function pathsFor(dataDir: string, id: string): { dir: string; socket: string } {
  const dir = path.join(dataDir, 'r', accountKey(id));
  return { dir, socket: path.join(dir, 'local.sock') };
}

function runnerJs(dir: string): { node: string; bundle: string } {
  return { node: path.join(dir, 'bin', 'node'), bundle: path.join(dir, 'bin', 'puck-runner.cjs') };
}

async function runner(dir: string, args: string[], what: string, timeoutMs = 120_000): Promise<string> {
  const { node, bundle } = runnerJs(dir);
  const r = await d().exec(node, [bundle, ...args], { timeoutMs, cwd: dir });
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(-400);
    throw new Error(`${what} failed: ${why || `exit ${r.code}`}`);
  }
  return r.stdout;
}

function readRunnerId(dir: string): string | null {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, '.runner'), 'utf8')) as { runnerId?: unknown };
    return typeof c.runnerId === 'string' ? c.runnerId : null;
  } catch {
    return null;
  }
}

async function download(url: string, sha256: string, file: string): Promise<void> {
  const res = await serverDeps().fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`Downloading the runner failed (HTTP ${res.status}).`);
  const body = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(body).digest('hex');
  if (got !== sha256) throw new Error('The downloaded runner does not match its published sha256; nothing was installed.');
  fs.writeFileSync(file, body, { mode: 0o600 });
}

async function exclusive<T>(kind: 'installing' | 'uninstalling', fn: () => Promise<T>): Promise<T> {
  if (busy) throw new Error(busy === 'installing' ? 'This Mac is already being installed.' : 'This Mac is being removed.');
  busy = kind;
  lastError = null;
  progress(kind === 'installing' ? 'Installing…' : 'Removing…');
  try {
    return await fn();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    log.warn(`this-mac.${kind === 'installing' ? 'install' : 'uninstall'}-failed`, { error: lastError.slice(0, 300) });
    throw err;
  } finally {
    busy = null;
    detail = '';
    listener?.();
  }
}

/**
 * Installs, registers and starts the This Mac runner. `existing` is the
 * user's current runner list. Re-registration replaces only a runner id
 * this Mac recorded; another runner's name is left alone.
 */
export function install(existing: ServerRunner[]): Promise<LocalRunnerRecord> {
  return exclusive('installing', async () => {
    if (!supported()) throw new Error('The This Mac runner needs macOS on Apple silicon. Add this Mac as a runner by hand instead.');
    const id = accountId();
    const generation = sessionGeneration;
    const switched = (): boolean => sessionGeneration !== generation || current()?.user.id !== id;
    const gate = (): void => {
      if (switched()) throw new Error('The Puck session changed; try again.');
    };
    const { dir, socket } = pathsFor(d().dataDir(), id);
    if (Buffer.byteLength(socket, 'utf8') > MAX_SOCKET_PATH_BYTES) {
      throw new Error(`Puck's data folder path is too long for the runner's local socket (${socket}).`);
    }
    const recordedId = localRunner()?.runnerId ?? null;
    const already = readRunnerId(dir);
    if (already) {
      // A registration from an earlier install that the record lost: keep it, make sure it runs.
      progress('Starting the runner…');
      await startRecorded(dir, socket, gate);
      gate();
      const record = { runnerId: already, dir, socket, accountId: id };
      setLocalRunner(record);
      log.info('this-mac.installed', { runnerId: already });
      return record;
    }

    progress('Finding the runner release…');
    const releases = await api.releases();
    gate();
    const asset = releases.assets.find((a) => a.os === 'macos' && a.arch === 'arm64' && a.version === releases.latest);
    if (!asset) throw new Error('This Puck server has no runner package for macOS on Apple silicon. Runner downloads come only from a Puck server in development mode.');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    setLocalRunner({ runnerId: null, dir, socket, accountId: id });
    const tarball = path.join(dir, asset.file);
    const tokenFile = path.join(dir, '.registration-token');
    let tokenId: string | null = null;
    try {
      progress(`Downloading runner ${asset.version}…`);
      await download(asset.url, asset.sha256, tarball);
      gate();
      progress('Unpacking…');
      const untar = await d().exec('/usr/bin/tar', ['-xzf', tarball, '-C', dir], { timeoutMs: 120_000 });
      gate();
      if (untar.code !== 0) throw new Error(`Unpacking the runner failed: ${untar.stderr.trim().slice(-300)}`);
      fs.rmSync(tarball, { force: true });

      progress('Registering with the Puck server…');
      const reg = await api.registrationToken();
      tokenId = reg.id;
      gate();
      fs.writeFileSync(tokenFile, reg.token, { mode: 0o600 });
      const target = registrationTarget(existing, recordedId, d().hostname());
      const args = ['config', '--unattended', '--url', reg.serverUrl, '--token-file', tokenFile, '--name', target.name, '--labels', 'local', '--local-socket', socket, '--service-label', serviceLabelFor(id)];
      if (target.replace) args.push('--replace');
      await runner(dir, args, 'Registering the runner');
      gate();
      fs.rmSync(tokenFile, { force: true });
      const runnerId = readRunnerId(dir);
      if (!runnerId) throw new Error('The runner did not record its registration.');
      const record = { runnerId, dir, socket, accountId: id };

      progress('Starting the LaunchAgent…');
      await runner(dir, ['svc', 'install'], 'Installing the LaunchAgent', 60_000);
      gate();
      await runner(dir, ['svc', 'start'], 'Starting the LaunchAgent', 60_000);
      gate();
      progress('Waiting for the runner…');
      await d().waitForSocket(socket, 60_000);
      gate();
      setLocalRunner(record);
      log.info('this-mac.installed', { runnerId });
      return record;
    } catch (err) {
      fs.rmSync(tokenFile, { force: true });
      fs.rmSync(tarball, { force: true });
      if (!readRunnerId(dir)) {
        // Nothing registered: leave no half-installed runner behind for this account.
        if (!switched()) fs.rmSync(dir, { recursive: true, force: true });
        forgetLocalRunner(id);
      }
      throw err;
    } finally {
      if (tokenId) await api.revokeEnrollToken('registration', tokenId).catch(() => undefined);
    }
  });
}

/** Stops, deregisters and deletes the This Mac runner, keeping its environments. */
export function uninstall(): Promise<void> {
  return exclusive('uninstalling', async () => {
    const record = localRunner();
    if (!record) return;
    if (fs.existsSync(path.join(record.dir, '.runner'))) {
      progress('Removing the runner…');
      await runner(record.dir, ['config', 'remove', '--unattended', '--keep-environments'], 'Removing the runner');
    } else if (fs.existsSync(path.join(record.dir, '.service'))) {
      await runner(record.dir, ['svc', 'uninstall'], 'Removing the LaunchAgent', 60_000).catch(() => undefined);
    }
    fs.rmSync(record.dir, { recursive: true, force: true });
    if (record.accountId) forgetLocalRunner(record.accountId);
    else setLocalRunner(null);
    log.info('this-mac.uninstalled', { runnerId: record.runnerId });
  });
}

/** Boot: a record whose directory is gone is forgotten. */
export function reconcile(): void {
  const record = localRunner();
  if (record && !fs.existsSync(record.dir)) setLocalRunner(null);
}

async function waitForSocket(socket: string, timeoutMs: number): Promise<void> {
  const net = await import('node:net');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.createConnection(socket);
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error('The runner was installed but did not start; see its log in the runner folder (_diag).');
    await new Promise((r) => setTimeout(r, 500));
  }
}
