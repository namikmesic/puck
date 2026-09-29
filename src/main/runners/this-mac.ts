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
 * <dir>/local.sock --app-bundle-id <Puck's>` with a registration token read
 * from a 0600 file (then revoked), and `svc install` + `svc start`. A runner
 * release from before `--app-bundle-id` rejects that option, so `config`
 * runs once more without it. `svc start` kickstarts the LaunchAgent; an
 * older runner release's only loads it, and launchd may hold a freshly
 * loaded job back or keep a previously loaded program, so when
 * `launchctl print` does not show the plist's program running the app
 * kickstarts it itself. That kickstart unloads the recorded agent
 * when one is loaded and bootstraps its plist, so the job that runs is the
 * plist on disk. A LaunchAgent left from an older install — its program is
 * not the puck-runner launcher, or its plist names no app — is rewritten
 * and kickstarted instead of started, including one an older `svc install`
 * just wrote. The
 * app's Electron binary is not used as a Node runtime: packaged builds
 * switch that off (the RunAsNode fuse), and the runner updates itself from
 * the server like any other.
 *
 * An isolated launch (PUCK_ISOLATED=1) refuses the install: the LaunchAgent
 * is a login item in the real ~/Library/LaunchAgents, and it would outlive
 * the launch's temporary data folder that holds the runner.
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
import { LAUNCHER, launchAgentNamesApp, launchAgentProgram, launchdNotLoaded, launchdPlist, launchdPrintedProgram, launchdPrintedRunning, launcherPath, launcherScript, loginItemName } from '../../harness/launch-agent';
import type { ServerRunner } from '../../harness/server-api';
import { ISOLATED_ENV } from '../isolation';
import { log } from '../log';
import * as api from '../server/api';
import { serverDeps } from '../server/http';
import { current, onSessionChange } from '../server/session';
import { forgetLocalRunner, localRunner, setLocalRunner, type LocalRunnerRecord } from './store';

/** Puck's bundle id (forge.config.ts `appBundleId`): the LaunchAgent names it as its app. */
export const APP_BUNDLE_ID = 'com.namikmesic.puck';

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
  /** The user's id: the LaunchAgent lives in the gui/<uid> launchd domain. */
  uid: number;
  /** An isolated launch (PUCK_ISOLATED=1), which must leave no LaunchAgent behind. */
  isolated: boolean;
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
    uid: process.getuid?.() ?? -1,
    isolated: process.env[ISOLATED_ENV] === '1',
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

const ISOLATED_REFUSAL =
  'This Mac cannot be set up in an isolated launch: its LaunchAgent would be a login item in your real ~/Library/LaunchAgents running a runner from this launch\'s temporary data folder. Launch Puck normally, or add a runner by hand.';

/** Why the one-click runner cannot be set up here, or null when it can. */
function unsupported(): string | null {
  if (!supported()) return 'The one-click runner needs macOS on Apple silicon. Pick a platform above and run the commands on this Mac instead.';
  if (d().isolated) return ISOLATED_REFUSAL;
  return null;
}

export function localState(): LocalRunnerState {
  const record = localRunner();
  const reason = unsupported();
  return {
    supported: !reason,
    unsupported: reason,
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

/** For runner releases whose `svc start` only bootstraps and fails when the agent is already loaded. */
function serviceAlreadyUp(message: string): boolean {
  return /already (bootstrapped|loaded|running)/i.test(message) || /Bootstrap failed: (5|17|37)\b/.test(message);
}

interface InstalledService {
  name: string;
  file: string;
}

/** The installed LaunchAgent, from the runner's `.service` record. */
function installedService(dir: string, fallback: string): InstalledService | null {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, '.service'), 'utf8')) as { kind?: unknown; name?: unknown; file?: unknown };
    if (r.kind !== 'launchd' || typeof r.file !== 'string' || r.file === '') return null;
    const name = typeof r.name === 'string' && /^com\.puck\.runner\.[a-z0-9-]{1,48}$/.test(r.name) ? r.name : fallback;
    return { name, file: r.file };
  } catch {
    return null;
  }
}

/** The name Login Items shows for the job launchd has loaded, or for the plist on disk. */
async function shownItemName(dir: string, label: string): Promise<string> {
  const rec = installedService(dir, label);
  const name = rec?.name ?? label;
  const printed = await d().exec('/bin/launchctl', ['print', `gui/${d().uid}/${name}`], { timeoutMs: 30_000 });
  const fromJob = launchdPrintedProgram(printed.stdout);
  if (fromJob) return fromJob;
  if (!rec) return LAUNCHER;
  try {
    return loginItemName(fs.readFileSync(rec.file, 'utf8')) ?? LAUNCHER;
  } catch {
    return LAUNCHER;
  }
}

/** An older LaunchAgent still runs run.sh, or its plist names no app. */
function recordedAgentStale(dir: string, label: string): boolean {
  const rec = installedService(dir, label);
  if (!rec) return false;
  let text: string;
  try {
    text = fs.readFileSync(rec.file, 'utf8');
  } catch {
    return true;
  }
  return launchAgentProgram(text) !== launcherPath(dir) || !launchAgentNamesApp(text, APP_BUNDLE_ID);
}

function ensureAppBundleId(dir: string): void {
  const file = path.join(dir, '.runner');
  let c: Record<string, unknown>;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    c = v as Record<string, unknown>;
  } catch {
    return;
  }
  if (c.appBundleId === APP_BUNDLE_ID) return;
  c.appBundleId = APP_BUNDLE_ID;
  fs.writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
}

/** Writes the launcher and plist `svc install` writes, over an older agent. */
function placeLaunchAgent(dir: string, rec: InstalledService): void {
  const launcher = launcherPath(dir);
  fs.mkdirSync(path.join(dir, '_diag'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(launcher, launcherScript(), { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);
  fs.mkdirSync(path.dirname(rec.file), { recursive: true });
  fs.writeFileSync(rec.file, launchdPlist({ label: rec.name, root: dir, appBundleId: APP_BUNDLE_ID }), { mode: 0o644 });
  try {
    const serviceFile = path.join(dir, '.service');
    const r = JSON.parse(fs.readFileSync(serviceFile, 'utf8')) as Record<string, unknown>;
    r.launcher = launcher;
    fs.writeFileSync(serviceFile, JSON.stringify(r, null, 2) + '\n');
  } catch {
    // `.service` is the runner's record; the plist is already rewritten.
  }
}

/** Unloads `name`. A label that is not loaded is fine; any other failure is not. */
async function bootoutLabel(name: string): Promise<void> {
  const r = await d().exec('/bin/launchctl', ['bootout', `gui/${d().uid}/${name}`], { timeoutMs: 30_000 });
  if (r.code === 0 || launchdNotLoaded(r.code, `${r.stderr}\n${r.stdout}`)) return;
  const why = (r.stderr || r.stdout).trim().slice(-300) || `exit ${r.code}`;
  throw new Error(`launchctl bootout failed: ${why}`);
}

/** Unloads the recorded agent and bootstraps its plist, so kickstart runs that plist. */
async function loadRecorded(dir: string, label: string): Promise<void> {
  const rec = installedService(dir, label);
  if (!rec) return;
  await bootoutLabel(rec.name);
  if (rec.name !== label) await bootoutLabel(label);
  const boot = await d().exec('/bin/launchctl', ['bootstrap', `gui/${d().uid}`, rec.file], { timeoutMs: 30_000 });
  if (boot.code !== 0) {
    const why = (boot.stderr || boot.stdout).trim().slice(-300) || `exit ${boot.code}`;
    throw new Error(`launchctl bootstrap failed: ${why}`);
  }
}

/** Loads the recorded plist and kickstarts that job. */
async function kickstart(dir: string, label: string): Promise<void> {
  await loadRecorded(dir, label);
  const name = installedService(dir, label)?.name ?? label;
  const r = await d().exec('/bin/launchctl', ['kickstart', `gui/${d().uid}/${name}`], { timeoutMs: 30_000 });
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim().slice(-300) || `exit ${r.code}`;
    throw new Error(`launchd did not start the runner (${why}). Check that ${await shownItemName(dir, label)} is allowed in System Settings → General → Login Items & Extensions.`);
  }
}

/** Basename of the program the recorded plist names, or null when that plist cannot be read. */
function recordedProgramName(rec: InstalledService | null): string | null {
  if (!rec) return null;
  try {
    return loginItemName(fs.readFileSync(rec.file, 'utf8'));
  } catch {
    return null;
  }
}

/** Kickstarts unless launchd is already running the program named by the plist on disk. */
async function ensureRunning(dir: string, label: string): Promise<void> {
  const rec = installedService(dir, label);
  const printed = await d().exec('/bin/launchctl', ['print', `gui/${d().uid}/${rec?.name ?? label}`], { timeoutMs: 30_000 });
  const onDisk = recordedProgramName(rec);
  if (printed.code === 0 && launchdPrintedRunning(printed.stdout) && onDisk !== null && launchdPrintedProgram(printed.stdout) === onDisk) return;
  await kickstart(dir, label);
}

/** Rewrites a stale LaunchAgent through `svc install`. Kickstart then loads that plist. */
async function replaceStaleLaunchAgent(dir: string, label: string, gate: () => void): Promise<void> {
  const previous = installedService(dir, label);
  if (!previous) throw new Error('No LaunchAgent is installed.');
  ensureAppBundleId(dir);
  try {
    await runner(dir, ['svc', 'install'], 'Updating the LaunchAgent', 60_000);
  } catch (err) {
    gate();
    const message = err instanceof Error ? err.message : String(err);
    if (!/already installed/i.test(message)) throw err;
    await runner(dir, ['svc', 'uninstall'], 'Updating the LaunchAgent', 60_000);
    gate();
    await runner(dir, ['svc', 'install'], 'Updating the LaunchAgent', 60_000);
  }
  gate();
  const next = installedService(dir, label) ?? previous;
  placeLaunchAgent(dir, next);
  if (previous.name !== next.name) await bootoutLabel(previous.name);
  gate();
}

/** Starts the LaunchAgent `svc install` just wrote. One an older runner release wrote is rewritten and kickstarted instead. */
async function startInstalled(dir: string, label: string, gate: () => void): Promise<void> {
  const stale = recordedAgentStale(dir, label) ? installedService(dir, label) : null;
  if (stale) {
    ensureAppBundleId(dir);
    placeLaunchAgent(dir, stale);
    gate();
    return kickstart(dir, label);
  }
  await runner(dir, ['svc', 'start'], 'Starting the LaunchAgent', 60_000);
  gate();
  await ensureRunning(dir, label);
}

async function startRecordedAgent(dir: string, label: string, gate: () => void): Promise<void> {
  if (recordedAgentStale(dir, label)) {
    await replaceStaleLaunchAgent(dir, label, gate);
    return kickstart(dir, label);
  }
  try {
    await runner(dir, ['svc', 'start'], 'Starting the runner', 60_000);
  } catch (err) {
    gate();
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('No service is installed')) {
      await runner(dir, ['svc', 'install'], 'Installing the LaunchAgent', 60_000);
      gate();
      return startInstalled(dir, label, gate);
    }
    if (!serviceAlreadyUp(message)) throw err;
  }
  gate();
  await ensureRunning(dir, label);
}

async function startRecorded(dir: string, socket: string, label: string, gate: () => void): Promise<void> {
  await startRecordedAgent(dir, label, gate);
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
  // The runner's lock is node:sqlite; its experimental warning would crowd the error text below.
  const r = await d().exec(node, ['--disable-warning=ExperimentalWarning', bundle, ...args], { timeoutMs, cwd: dir });
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(-400);
    throw new Error(`${what} failed: ${why || `exit ${r.code}`}`);
  }
  return r.stdout;
}

/** A runner release from before `--app-bundle-id` rejects it; `startInstalled` then names the app in the LaunchAgent. */
async function configure(dir: string, args: string[], gate: () => void): Promise<void> {
  try {
    await runner(dir, args, 'Registering the runner');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const at = args.indexOf('--app-bundle-id');
    if (at === -1 || !message.includes("Unknown option '--app-bundle-id'")) throw err;
    gate();
    log.info('this-mac.config-without-app-bundle-id');
    await runner(dir, [...args.slice(0, at), ...args.slice(at + 2)], 'Registering the runner');
  }
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
    if (d().isolated) throw new Error(ISOLATED_REFUSAL);
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
      await startRecorded(dir, socket, serviceLabelFor(id), gate);
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
    if (!asset) {
      const devMode = releases.assets.length === 0 ? ' Runner downloads come only from a Puck server in development mode.' : '';
      throw new Error(`This Puck server has no runner package for macOS on Apple silicon.${devMode}`);
    }

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
      const args = ['config', '--unattended', '--url', reg.serverUrl, '--token-file', tokenFile, '--name', target.name, '--labels', 'local', '--local-socket', socket, '--service-label', serviceLabelFor(id), '--app-bundle-id', APP_BUNDLE_ID];
      if (target.replace) args.push('--replace');
      await configure(dir, args, gate);
      gate();
      fs.rmSync(tokenFile, { force: true });
      const runnerId = readRunnerId(dir);
      if (!runnerId) throw new Error('The runner did not record its registration.');
      const record = { runnerId, dir, socket, accountId: id };

      progress('Starting the LaunchAgent…');
      await runner(dir, ['svc', 'install'], 'Installing the LaunchAgent', 60_000);
      gate();
      await startInstalled(dir, serviceLabelFor(id), gate);
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
