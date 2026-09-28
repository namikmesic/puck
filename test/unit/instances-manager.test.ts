/**
 * The environment manager as the app runs it: an environment in the index
 * on This Mac's runner (a real local-socket listener with a scripted daemon
 * behind `attach`), opened, talked to through the renderer's passthrough,
 * then the app quits (cursor flushed by the quit drain) and a fresh launch
 * reattaches from puck-instances.json and replays only what happened
 * meanwhile. Also the cursor store's lenient load.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEventPayload } from '../../src/harness/bridge';
import type { RunnerInfo } from '../../src/harness/runner-protocol';
import { normalizeInstances } from '../../src/main/instances/store';
import { BundleCache } from '../../src/puck-runner/bundles';
import { Control } from '../../src/puck-runner/control';
import type { DockerResult } from '../../src/puck-runner/docker/client';
import { DockerOps } from '../../src/puck-runner/docker/ops';
import { LocalListener } from '../../src/puck-runner/local';
import { nullLogger } from '../../src/puck-runner/log';

type Electron = typeof import('../mocks/electron');
const ENV = 'env_01J8Z3X0000000000000000000';
const RUNNER = 'rnr_01J8Z3X0000000000000000002';
const FAKE_DAEMON = path.resolve(__dirname, '../fixtures/fake-daemon.mjs');

let dir: string;
let listener: LocalListener | null = null;
afterEach(async () => {
  await listener?.stop();
  listener = null;
  vi.resetModules();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const until = async (what: string, ok: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function thisMacRunner(socket: string): Promise<void> {
  const docker = async (args: string[]): Promise<DockerResult> =>
    args[0] === 'container' ? { code: 0, stdout: 'running\n', stderr: '' } : { code: 0, stdout: '', stderr: '' };
  listener = new LocalListener({
    path: socket,
    runnerId: RUNNER,
    version: '0.1.0',
    control: new Control({
      ops: new DockerOps(docker),
      bundles: new BundleCache(path.join(dir, 'cache')),
      log: nullLogger,
      info: async () => ({}) as RunnerInfo,
      mint: async () => [],
      started: () => undefined,
      removed: () => undefined,
      maxEnvironments: () => null,
    }),
    spawner: () =>
      spawn(process.execPath, [FAKE_DAEMON], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FAKE_DAEMON_LOG: path.join(dir, 'daemon.json'), FAKE_DAEMON_ENV: ENV } }),
    instanceState: async () => 'running',
    log: nullLogger,
  });
  await listener.start();
}

/** One app launch over `userData` (a fresh main-process module graph). */
async function launch(userData?: string) {
  vi.resetModules();
  const { app } = (await import('electron')) as unknown as Electron;
  const data = app.getPath();
  if (userData) fs.cpSync(userData, data, { recursive: true });
  const http = await import('../../src/main/server/http');
  const session = await import('../../src/main/server/session');
  // Signed in to Puck (the index is the signed-in user's); This Mac needs no server call.
  http.useServerDeps({}, 'http://puck.test');
  session.account.save({
    server: 'http://puck.test',
    accessToken: 'PSA_x',
    accessExpiresAt: Date.now() + 600_000,
    refreshToken: 'PSR_x',
    refreshExpiresAt: Date.now() + 600_000,
    user: { id: 'usr_1', login: 'octo' },
  });
  const runners = await import('../../src/main/runners');
  const store = await import('../../src/main/runners/store');
  const instances = await import('../../src/main/instances');
  const events: DaemonEventPayload[] = [];
  instances.onDaemonEvent((e) => events.push(e));
  return { data, runners, store, instances, events };
}

describe('environment manager', { timeout: 30_000 }, () => {
  it('attaches over This Mac, and after quit and relaunch replays from the saved cursor', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-mgr-'));
    const socket = path.join(dir, 's.sock');
    await thisMacRunner(socket);

    const first = await launch();
    first.store.setLocalRunner({ runnerId: RUNNER, dir, socket });
    first.runners.onPush({
      type: 'instance.upsert',
      instance: { id: ENV, runnerId: RUNNER, definition: 'example', status: 'active', createdAt: 1, updatedAt: 1, repos: [{ owner: 'octo', name: 'app', revoked: false }] },
    });
    await first.instances.open(ENV);
    await until('attached', () => first.instances.list()[0]?.attach === 'attached');
    expect(first.instances.list()[0]).toMatchObject({ id: ENV, name: 'example', local: true, current: true, repos: ['octo/app'] });
    await first.instances.daemon(ENV, 'chat.send', { text: 'first' });
    await until('the answer', () => first.events.some((e) => 'ev' in e && e.ev.kind === 'turn.end'));
    const lastSeen = Math.max(...first.events.flatMap((e) => ('seq' in e ? [e.seq] : [])));
    expect(first.instances.list()[0].daemon).toMatchObject({ status: 'ready' });
    // The renderer may not reach credential or GitHub ops, and only the attached environment.
    await expect(first.instances.daemon('env_01J8Z3X0000000000000000009', 'chat.send', { text: 'x' })).rejects.toThrow(/Open this environment first/);

    // Quit: the drain flushes the cursor, then the connection closes; the daemon keeps working.
    first.instances.flushSeq();
    first.instances.shutdown();
    await new Promise((r) => setTimeout(r, 50));
    const saved = JSON.parse(fs.readFileSync(path.join(first.data, 'puck-instances.json'), 'utf8'));
    expect(saved).toMatchObject({ v: 1, currentId: ENV, instances: { [ENV]: { lastSeq: lastSeen, runnerId: RUNNER } } });

    // Meanwhile another client talks to the daemon.
    const other = await launch(first.data);
    other.runners.onPush({ type: 'instance.upsert', instance: { id: ENV, runnerId: RUNNER, definition: 'example', status: 'active', createdAt: 1, updatedAt: 1, repos: [] } });
    await other.instances.open(ENV);
    await until('other attached', () => other.instances.list()[0]?.attach === 'attached');
    await other.instances.daemon(ENV, 'chat.send', { text: 'while away' });
    await until('other answer', () => other.events.some((e) => 'ev' in e && e.ev.kind === 'turn.end' && e.seq > lastSeen));
    other.instances.shutdown();

    // Relaunch from the first launch's data: no server listing needed for This Mac; replay from the cursor.
    const reopened = await launch(first.data);
    reopened.instances.resumeCurrent();
    await until('replayed', () => reopened.events.some((e) => 'ev' in e && e.ev.kind === 'turn.end'));
    const seqs = reopened.events.flatMap((e) => ('seq' in e ? [e.seq] : []));
    expect(Math.min(...seqs)).toBe(lastSeen + 1);
    expect(reopened.events.find((e) => 'ev' in e && e.ev.kind === 'turn.user')).toMatchObject({ ev: { entry: { text: 'while away' } } });
    reopened.instances.shutdown();
  });
});

describe('puck-instances.json', () => {
  it('loads leniently and never points at an environment it does not know', () => {
    expect(normalizeInstances(null)).toEqual({ v: 1, instances: {}, currentId: null });
    const env = 'env_01J8Z3X0000000000000000000';
    expect(
      normalizeInstances({
        instances: { [env]: { lastSeq: 7, pin: { kind: 'tag', name: 'v1', sha: 'abcdef1' }, junk: 1 }, 'not-an-env': {}, env_bad: { lastSeq: -1 } },
        currentId: 'env_01J8Z3X0000000000000000001',
      }),
    ).toEqual({
      v: 1,
      instances: {
        [env]: { runnerId: null, lastSeq: 7, pin: { kind: 'tag', name: 'v1', sha: 'abcdef1' }, harnesses: [], pendingCredentialRemoval: [], lastAttachedAt: null },
      },
      currentId: null,
    });
  });
});
