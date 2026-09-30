/**
 * The app's side of reaching runners, end to end in one process: the real
 * Puck server (fake GitHub, fake clock), a real runner connection with
 * Docker faked and a scripted daemon behind `attach`, and the app's own
 * clients: the server socket with its relay channels, the control client,
 * and the daemon client. Then the same clients over This Mac's local
 * socket, with no server at all.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DaemonEvent, Snapshot } from '../../src/harness/daemon-protocol';
import type { RunnerInfo } from '../../src/harness/runner-protocol';
import { readRunner, type ServerPush } from '../../src/harness/server-api';
import { DaemonClient, type AttachState } from '../../src/main/instances/daemon-client';
import type { ByteChannel } from '../../src/main/runners/channel';
import { ControlClient } from '../../src/main/runners/control-client';
import { openLocalChannel } from '../../src/main/runners/local';
import { ServerConnection } from '../../src/main/server/connection';
import { RunnerSession, ServerApi } from '../../src/puck-runner/api';
import { BundleCache } from '../../src/puck-runner/bundles';
import { configure } from '../../src/puck-runner/configure';
import { Control } from '../../src/puck-runner/control';
import type { DockerResult, DockerSpawner } from '../../src/puck-runner/docker/client';
import { DockerOps } from '../../src/puck-runner/docker/ops';
import { readConfig, runnerPaths } from '../../src/puck-runner/files';
import { loadRunnerKey } from '../../src/puck-runner/identity';
import { LocalListener } from '../../src/puck-runner/local';
import { nullLogger } from '../../src/puck-runner/log';
import { RelayConnection } from '../../src/puck-runner/relay';
import { call, signIn, startServer, type Harness } from './server-fakes';

const ENV = 'env_01J8Z3X0000000000000000000';
const FAKE_DAEMON = path.resolve(__dirname, '../fixtures/fake-daemon.mjs');
const quiet = { info: () => undefined, warn: () => undefined };

let dir: string;
let h: Harness | null = null;
let relay: RelayConnection | null = null;
let conn: ServerConnection | null = null;
let local: LocalListener | null = null;
const clients: DaemonClient[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-appch-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  conn?.stop();
  conn = null;
  await relay?.stop();
  relay = null;
  await local?.stop();
  local = null;
  await h?.close();
  h = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

const until = async (what: string, ok: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

function fakeDocker(state: () => string | null) {
  return async (args: string[]): Promise<DockerResult> => {
    if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ServerVersion: '27.3.1', NCPU: 8, MemTotal: 16e9 }), stderr: '' };
    if (args[0] === 'container' && args[1] === 'inspect') {
      const s = state();
      return s ? { code: 0, stdout: `${s}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'No such container' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

/** `docker exec … attach`, played by the scripted daemon. */
const daemonSpawner = (logFile: string): DockerSpawner => () =>
  spawn(process.execPath, [FAKE_DAEMON], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FAKE_DAEMON_LOG: logFile, FAKE_DAEMON_ENV: ENV } });

function control(runnerId: string, name: string, docker: ReturnType<typeof fakeDocker>, paths: ReturnType<typeof runnerPaths>) {
  return new Control({
    ops: new DockerOps(docker),
    bundles: new BundleCache(paths.cache),
    log: nullLogger,
    info: async (): Promise<RunnerInfo> => ({
      runnerId,
      name,
      version: '0.1.0',
      os: 'linux',
      arch: 'x64',
      labels: [],
      maxEnvironments: null,
      docker: { ok: true, version: '27.3.1', problem: null, detail: null, ncpu: 8, memTotal: 16e9 },
      running: 1,
    }),
    mint: async () => [],
    started: () => undefined,
    removed: () => undefined,
    maxEnvironments: () => null,
  });
}

function daemonClient(open: () => Promise<ByteChannel>, cursor: { seq: number | null }, seen: { seq: number; ev: DaemonEvent }[], states: AttachState[], snapshots: Snapshot[] = []) {
  const c = new DaemonClient({
    envId: ENV,
    open,
    since: () => cursor.seq,
    saveSeq: (seq) => (cursor.seq = seq),
    onEvent: (seq, _at, ev) => seen.push({ seq, ev }),
    onSnapshot: (s) => snapshots.push(s),
    onState: (s) => states.push(s),
    client: { app: 'puck', build: 'test' },
    timing: { backoffMs: [20, 40] },
  });
  clients.push(c);
  return c;
}

describe('through the Puck server relay', { timeout: 30_000 }, () => {
  it('lists the runner, opens encrypted control and attach channels, replays after a reattach', async () => {
    h = await startServer();
    h.github.addUser('octo');
    h.github.addRepo('octo/app', { pushers: ['octo'] });
    const session = await signIn(h, 'octo');
    const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: session.accessToken });
    const paths = runnerPaths(path.join(dir, 'runner'));
    const docker = fakeDocker(() => 'running');
    await configure(
      { url: h.base, token: String(reg.body.token), name: 'build-box', unattended: true, replace: false, disableUpdate: true },
      { paths, docker, io: { print: () => undefined, ask: async (_q, f) => f, interactive: false }, version: '0.1.0', platform: { os: 'linux', arch: 'x64' } },
    );
    const config = readConfig(paths);
    const key = loadRunnerKey(paths);
    const api = new ServerApi(h.base);
    const runnerSession = new RunnerSession(api, config.runnerId, key, config.serverUrl, '0.1.0', () => (h as Harness).clock.now());
    relay = new RelayConnection({
      runnerId: config.runnerId,
      version: '0.1.0',
      serverUrl: h.base,
      session: runnerSession,
      key: key.privateKey,
      log: nullLogger,
      control: control(config.runnerId, config.name, docker, paths),
      spawner: daemonSpawner(path.join(dir, 'daemon.json')),
      status: async () => ({ version: '0.1.0', docker: { ok: true, version: '27.3.1', problem: null, ncpu: 8, memTotal: 16e9 }, maxEnvironments: null, instances: [{ envId: ENV, state: 'running' }] }),
      instanceState: async () => 'running',
      onRemoved: () => undefined,
      onOutdated: () => undefined,
    });
    relay.start();
    await until('runner connected', () => !!relay?.connected);

    // The environment is in the index on that runner (the server checks the repository).
    const created = await call(h, 'POST', '/v1/instances', { token: session.accessToken, body: { runnerId: config.runnerId, definition: 'example', repos: ['octo/app'] } });
    expect(created.status).toBe(201);
    const envId = String(created.body.envId);

    const pushes: ServerPush[] = [];
    let connectedCount = 0;
    conn = new ServerConnection({
      url: () => (h as Harness).base,
      session: async () => ({ accessToken: session.accessToken, accessExpiresAt: (h as Harness).clock.now() + 15 * 60_000 }),
      onPush: (p) => pushes.push(p),
      onConnected: () => connectedCount++,
      log: quiet,
      now: () => (h as Harness).clock.now(),
    });
    conn.start();
    await until('app socket', () => conn?.socketState === 'connected');
    expect(connectedCount).toBe(1);

    const listed = await call(h, 'GET', '/v1/runners', { token: session.accessToken });
    const runner = readRunner((listed.body.runners as unknown[])[0]);
    expect(runner).toMatchObject({ name: 'build-box', status: 'active', docker: { version: '27.3.1', ncpu: 8 } });

    // Control: welcome, then a typed command.
    const ch = await conn.openChannel(config.runnerId, (runner as { publicKey: string }).publicKey, 'control');
    const ctl = new ControlClient(ch);
    expect(await ctl.welcome).toMatchObject({ runnerId: config.runnerId });
    expect(await ctl.cmd('runner.info', {})).toMatchObject({ name: 'build-box', docker: { version: '27.3.1' } });
    ctl.close();

    // A key the runner cannot prove gets no channel.
    const other = loadRunnerKey(paths).fingerprint ? 'A'.repeat(43) : '';
    await expect(conn.openChannel(config.runnerId, other, 'control')).rejects.toThrow(/did not prove the key/);

    // Attach: the daemon client's handshake and replay, over the relay.
    const envCursor = { seq: null as number | null };
    const seen: { seq: number; ev: DaemonEvent }[] = [];
    const states: AttachState[] = [];
    const snapshots: Snapshot[] = [];
    const publicKey = (runner as { publicKey: string }).publicKey;
    const first = daemonClient(() => (conn as ServerConnection).openChannel(config.runnerId, publicKey, 'attach', envId), envCursor, seen, states, snapshots);
    first.start();
    await until('attached', () => first.attachState === 'attached');
    await until('snapshot', () => snapshots.length === 1);
    expect(await first.cmd('chat.send', { text: 'hello' })).toMatchObject({ queued: false });
    await until('the orchestrator answers', () => seen.some((e) => e.ev.kind === 'turn.event'));
    const answer = seen.find((e) => e.ev.kind === 'turn.event')?.ev as Extract<DaemonEvent, { kind: 'turn.event' }>;
    expect(answer.event).toMatchObject({ kind: 'text-delta', text: 'echo: hello' });
    await until('turn end', () => seen.some((e) => e.ev.kind === 'turn.end'));
    const cursorAfter = envCursor.seq as number;
    expect(cursorAfter).toBe(Math.max(...seen.map((e) => e.seq)));
    first.stop();

    // More happens while the app is away (as if another client talked to the daemon).
    const away = daemonClient(() => (conn as ServerConnection).openChannel(config.runnerId, publicKey, 'attach', envId), { seq: cursorAfter }, [], []);
    away.start();
    await until('away attached', () => away.attachState === 'attached');
    await away.cmd('chat.send', { text: 'while you were out' });
    await new Promise((r) => setTimeout(r, 100));
    away.stop();

    // Reattaching (the app reopened) replays exactly what it missed, from its cursor.
    const replayed: { seq: number; ev: DaemonEvent }[] = [];
    const again = daemonClient(() => (conn as ServerConnection).openChannel(config.runnerId, publicKey, 'attach', envId), envCursor, replayed, []);
    again.start();
    await until('replayed', () => replayed.some((e) => e.ev.kind === 'turn.end'));
    expect(replayed.every((e) => e.seq > cursorAfter)).toBe(true);
    expect(replayed[0].seq).toBe(cursorAfter + 1);
    expect(replayed.find((e) => e.ev.kind === 'turn.user')?.ev).toMatchObject({ entry: { text: 'while you were out' } });

    // The server going away: channels close, the daemon client reconnects when it is back.
    conn.stop('test');
    await until('reconnecting', () => again.attachState !== 'attached');
    conn.start();
    await until('reattached after the relay came back', () => again.attachState === 'attached', 15_000);

    // Pushes arrive for runner changes.
    await call(h, 'PATCH', `/v1/runners/${config.runnerId}`, { token: session.accessToken, body: { name: 'big-box' } });
    await until('runner.upsert push', () => pushes.some((p) => p.type === 'runner.upsert' && p.runner.name === 'big-box'));
  });
});

describe("over This Mac's local socket", { timeout: 20_000 }, () => {
  it('answers control and attach with no server, and refuses a missing environment', async () => {
    const paths = runnerPaths(path.join(dir, 'runner'));
    const socket = path.join(dir, 's.sock');
    let state: string | null = 'running';
    const docker = fakeDocker(() => state);
    local = new LocalListener({
      path: socket,
      runnerId: 'rnr_01J8Z3X0000000000000000002',
      version: '0.1.0',
      control: control('rnr_01J8Z3X0000000000000000002', 'This Mac', docker, paths),
      spawner: daemonSpawner(path.join(dir, 'daemon.json')),
      instanceState: async () => state,
      log: nullLogger,
    });
    await local.start();
    expect(fs.statSync(socket).mode & 0o777).toBe(0o600);

    const ctl = new ControlClient(await openLocalChannel(socket, 'control'));
    expect(await ctl.welcome).toMatchObject({ runnerId: 'rnr_01J8Z3X0000000000000000002' });
    expect(await ctl.cmd('runner.info', {})).toMatchObject({ name: 'This Mac' });
    ctl.close();

    const cursor = { seq: null as number | null };
    const seen: { seq: number; ev: DaemonEvent }[] = [];
    const client = daemonClient(() => openLocalChannel(socket, 'attach', ENV), cursor, seen, []);
    client.start();
    await until('attached', () => client.attachState === 'attached');
    await client.cmd('chat.send', { text: 'local' });
    await until('answer', () => seen.some((e) => e.ev.kind === 'turn.event'));
    expect(await client.cmd('credentials.get', {})).toEqual({ harness: [] });
    client.stop();

    state = 'exited';
    await expect(openLocalChannel(socket, 'attach', ENV)).rejects.toThrow(/stopped/);
    state = null;
    await expect(openLocalChannel(socket, 'attach', ENV)).rejects.toThrow(/no container/);
    await expect(openLocalChannel(socket, 'attach', 'env_bad')).rejects.toThrow(/bad-open/);
    await local.stop();
    await expect(openLocalChannel(socket, 'control')).rejects.toThrow(/not running/);
  });
});
