/**
 * Docker suite plumbing for puck-runner: a runner directory laid out like
 * the tarball (the scripts, the built bundle, and `bin/node` pointing at
 * this Node), `config.sh` and `run.sh` run as real processes, and the
 * Puck server running in this process on the real clock with a fake
 * GitHub, listening where its public URL says.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { docker } from './helpers';
import { call, signIn, startLiveServer, type SignedIn } from '../unit/server-fakes';
import type { ControlClient } from '../relay-client';

const ROOT = path.resolve(__dirname, '..', '..');
export const RUNNER_BUNDLE = path.join(ROOT, '.webpack', 'runner', 'puck-runner.js');

export type LiveServer = Awaited<ReturnType<typeof startLiveServer>>;

export async function liveServer(): Promise<{ server: LiveServer; session: SignedIn }> {
  const server = await startLiveServer();
  server.github.addUser('octo');
  server.github.addRepo('octo/app', { pushers: ['octo'], installationId: 42 });
  const session = await signIn(server, 'octo');
  return { server, session };
}

/** A runner directory as the tarball unpacks, with this machine's Node as bin/node. */
export function runnerDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-runner-suite-'));
  for (const script of ['config.sh', 'run.sh', 'svc.sh']) {
    fs.copyFileSync(path.join(ROOT, 'src', 'puck-runner', 'sh', script), path.join(dir, script));
    fs.chmodSync(path.join(dir, script), 0o755);
  }
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.copyFileSync(RUNNER_BUNDLE, path.join(dir, 'bin', 'puck-runner.js'));
  fs.symlinkSync(process.execPath, path.join(dir, 'bin', 'node'));
  fs.writeFileSync(path.join(dir, 'VERSION'), '0.0.1\n');
  return dir;
}

export function sh(dir: string, script: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('sh', [path.join(dir, script), ...args], { cwd: dir, timeout: timeoutMs, env: { ...process.env, PUCK_RUNNER_ROOT: '' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });
}

export async function tokenFor(server: LiveServer, session: SignedIn, kind: 'registration' | 'removal'): Promise<string> {
  const res = await call(server, 'POST', `/v1/runners/${kind}-token`, { token: session.accessToken });
  if (res.status !== 201) throw new Error(`token: ${JSON.stringify(res.body)}`);
  return String(res.body.token);
}

export async function configureRunner(server: LiveServer, session: SignedIn, dir: string, name: string): Promise<{ runnerId: string; out: string }> {
  const token = await tokenFor(server, session, 'registration');
  const r = await sh(dir, 'config.sh', ['--url', server.base, '--token', token, '--name', name, '--unattended']);
  if (r.code !== 0) throw new Error(`config.sh failed (${r.code}): ${r.out}`);
  const config = JSON.parse(fs.readFileSync(path.join(dir, '.runner'), 'utf8')) as { runnerId: string };
  return { runnerId: config.runnerId, out: r.out };
}

/** `./run.sh` as a real process; `stop` sends SIGTERM and resolves with the exit code. */
export class RunnerProcess {
  readonly child: ChildProcess;
  out = '';
  exit: Promise<number>;

  constructor(readonly dir: string) {
    this.child = spawn('sh', [path.join(dir, 'run.sh')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PUCK_RUNNER_ROOT: '' } });
    this.child.stdout?.on('data', (d: Buffer) => (this.out += d.toString()));
    this.child.stderr?.on('data', (d: Buffer) => (this.out += d.toString()));
    this.exit = new Promise((resolve) => this.child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1))));
  }

  async stop(): Promise<number> {
    this.child.kill('SIGTERM');
    return this.exit;
  }

  log(): string {
    try {
      return fs.readFileSync(path.join(this.dir, '_diag', 'runner.log'), 'utf8');
    } catch {
      return '';
    }
  }
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function runnerView(server: LiveServer, session: SignedIn, runnerId: string): Promise<Record<string, unknown> | undefined> {
  const res = await call(server, 'GET', '/v1/runners', { token: session.accessToken });
  return (res.body.runners as Record<string, unknown>[]).find((r) => r.id === runnerId);
}

/** Uploads a daemon bundle over the control channel when the runner lacks it. */
export async function uploadBundle(control: ControlClient, bundle: Buffer): Promise<string> {
  const sha = createHash('sha256').update(bundle).digest('hex');
  if ((await control.cmd<{ has: boolean }>('bundle.has', { sha })).has) return sha;
  const chunk = 512 * 1024;
  for (let at = 0; at < bundle.length; at += chunk) {
    await control.cmd('bundle.put', { sha, offset: at, data: bundle.subarray(at, at + chunk).toString('base64'), last: at + chunk >= bundle.length });
  }
  return sha;
}

/** Removes every container and volume of the given environments (the suite's own cleanup). */
export async function removeEnvironments(envIds: string[]): Promise<void> {
  for (const envId of envIds) {
    await docker(['rm', '-f', `puck-${envId}`]);
    await docker(['volume', 'rm', '-f', `puck-${envId}-data`, `puck-${envId}-ws`]);
  }
}

export async function containerStart(envId: string): Promise<{ startedAt: string; restarts: number; running: boolean } | null> {
  const r = await docker(['container', 'inspect', '--format', '{{.State.StartedAt}} {{.RestartCount}} {{.State.Running}}', `puck-${envId}`]);
  if (r.code !== 0) return null;
  const [startedAt, restarts, running] = r.stdout.trim().split(' ');
  return { startedAt, restarts: Number(restarts), running: running === 'true' };
}
