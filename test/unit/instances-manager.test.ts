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
import { resolveEnvironment } from '../../src/harness/definitions/resolve';
import { validateSnapshot } from '../../src/harness/definitions/validate';
import type { RunnerInfo } from '../../src/harness/runner-protocol';
import { normalizeInstances } from '../../src/main/instances/store';
import { exampleFiles, snapshotOf } from './definitions-fixtures';

const resolveOverride = vi.hoisted(() => ({
  fn: null as null | ((spec: { kind: string; name: string }, name: string) => Promise<unknown>),
}));

vi.mock('../../src/main/config-repo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config-repo')>();
  return {
    ...actual,
    resolveDefinition: (spec: { kind: string; name: string }, name: string) => (resolveOverride.fn ? resolveOverride.fn(spec, name) : actual.resolveDefinition(spec, name)),
  };
});
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
  resolveOverride.fn = null;
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

async function thisMacRunner(socket: string, extraEnv: Record<string, string> = {}): Promise<void> {
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
      spawn(process.execPath, [FAKE_DAEMON], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FAKE_DAEMON_LOG: path.join(dir, 'daemon.json'), FAKE_DAEMON_ENV: ENV, ...extraEnv },
      }),
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

  it('resyncs from a snapshot after a rebuild so the repository list can refresh', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-mgr-'));
    const socket = path.join(dir, 's.sock');
    await thisMacRunner(socket);
    const pin = { kind: 'tag' as const, name: 'v1.0.0', sha: 'a'.repeat(40) };
    const snap = snapshotOf(exampleFiles(), pin.sha);
    resolveOverride.fn = async () => resolveEnvironment(validateSnapshot(snap), snap, 'example', { repo: 'acme/config', pin });

    const app = await launch();
    app.store.setLocalRunner({ runnerId: RUNNER, dir, socket });
    app.runners.onPush({
      type: 'instance.upsert',
      instance: { id: ENV, runnerId: RUNNER, definition: 'example', status: 'active', createdAt: 1, updatedAt: 1, repos: [{ owner: 'octo', name: 'app', revoked: false }] },
    });
    await app.instances.open(ENV);
    await until('attached', () => app.instances.list()[0]?.attach === 'attached');
    await app.instances.daemon(ENV, 'chat.send', { text: 'first' });
    await until('the answer', () => app.events.some((e) => 'ev' in e && e.ev.kind === 'turn.end'));

    const repos = [
      { github: 'octo/app', dir: 'app' },
      { github: 'octo/api', dir: 'api' },
    ];
    const logPath = path.join(dir, 'daemon.json');
    const log = JSON.parse(fs.readFileSync(logPath, 'utf8')) as { repos?: unknown };
    log.repos = repos;
    fs.writeFileSync(logPath, JSON.stringify(log));
    const cursors = await import('../../src/main/instances/store');
    cursors.updateCursor(ENV, { pin });

    const before = app.events.length;
    await app.instances.rebuild(ENV);
    await until('snapshot after rebuild', () => app.events.slice(before).some((e) => 'snapshot' in e));
    const pushed = app.events.slice(before).find((e) => 'snapshot' in e);
    expect(pushed && 'snapshot' in pushed ? pushed.snapshot.repos : null).toEqual(repos);
    app.instances.shutdown();
  });

  it('records a signed-out harness before the live delete and clears it only after success', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-mgr-'));
    const hold = path.join(dir, 'hold');
    const socket = path.join(dir, 's.sock');
    const detached = 'env_01J8Z3X0000000000000000001';
    fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ events: [], credentials: [{ id: 'claude-code', content: '{"token":"s3cret"}' }] }));
    await thisMacRunner(socket, { FAKE_DAEMON_HOLD_NULL_PUT: hold });

    const app = await launch();
    app.store.setLocalRunner({ runnerId: RUNNER, dir, socket });
    app.runners.onPush({
      type: 'instance.upsert',
      instance: { id: ENV, runnerId: RUNNER, definition: 'example', status: 'active', createdAt: 1, updatedAt: 1, repos: [] },
    });
    await app.instances.open(ENV);
    await until('attached', () => app.instances.list()[0]?.attach === 'attached');
    const cursors = await import('../../src/main/instances/store');
    cursors.updateCursor(ENV, { pendingCredentialRemoval: ['codex'] });
    cursors.updateCursor(detached, {});

    const removal = app.instances.onHarnessLogout('claude-code');
    try {
      await until('removal held', () => fs.existsSync(`${hold}.waiting`));
      const { flushWrites } = await import('../../src/main/jsonstore');
      await flushWrites();
      const mid = JSON.parse(fs.readFileSync(path.join(app.data, 'puck-instances.json'), 'utf8')) as {
        instances: Record<string, { pendingCredentialRemoval: string[] }>;
      };
      expect(mid.instances[ENV].pendingCredentialRemoval).toEqual(['codex', 'claude-code']);
      expect(mid.instances[detached].pendingCredentialRemoval).toEqual(['claude-code']);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8')).credentials).toEqual([{ id: 'claude-code', content: '{"token":"s3cret"}' }]);

      fs.writeFileSync(`${hold}.go`, '');
      await removal;
      await flushWrites();
      const after = JSON.parse(fs.readFileSync(path.join(app.data, 'puck-instances.json'), 'utf8')) as {
        instances: Record<string, { pendingCredentialRemoval: string[] }>;
      };
      expect(after.instances[ENV].pendingCredentialRemoval).toEqual(['codex']);
      expect(after.instances[detached].pendingCredentialRemoval).toEqual(['claude-code']);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8')).credentials).toEqual([]);
    } finally {
      fs.writeFileSync(`${hold}.go`, '');
      await removal.catch(() => undefined);
      app.instances.shutdown();
    }
  });

  it('keeps the signed-out harness pending when the live delete fails', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-mgr-'));
    const socket = path.join(dir, 's.sock');
    const detached = 'env_01J8Z3X0000000000000000001';
    fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ events: [], credentials: [{ id: 'claude-code', content: '{"token":"s3cret"}' }] }));
    await thisMacRunner(socket, { FAKE_DAEMON_FAIL_NULL_PUT: '1' });

    const app = await launch();
    app.store.setLocalRunner({ runnerId: RUNNER, dir, socket });
    app.runners.onPush({
      type: 'instance.upsert',
      instance: { id: ENV, runnerId: RUNNER, definition: 'example', status: 'active', createdAt: 1, updatedAt: 1, repos: [] },
    });
    await app.instances.open(ENV);
    await until('attached', () => app.instances.list()[0]?.attach === 'attached');
    const cursors = await import('../../src/main/instances/store');
    cursors.updateCursor(detached, {});

    await app.instances.onHarnessLogout('claude-code');
    const { flushWrites } = await import('../../src/main/jsonstore');
    await flushWrites();
    const saved = JSON.parse(fs.readFileSync(path.join(app.data, 'puck-instances.json'), 'utf8')) as {
      instances: Record<string, { pendingCredentialRemoval: string[] }>;
    };
    expect(saved.instances[ENV].pendingCredentialRemoval).toEqual(['claude-code']);
    expect(saved.instances[detached].pendingCredentialRemoval).toEqual(['claude-code']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8')).credentials).toEqual([{ id: 'claude-code', content: '{"token":"s3cret"}' }]);
    app.instances.shutdown();
  });

  it('a sign-out during an attach sync does not restore that harness credential', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-mgr-'));
    const socket = path.join(dir, 's.sock');
    fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({ events: [], credentials: [{ id: 'claude-code', content: '{"token":"s3cret"}' }] }));
    await thisMacRunner(socket);

    let releaseRefresh: () => void = () => undefined;
    let refreshWaiting = false;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let app: Awaited<ReturnType<typeof launch>> | null = null;
    let claudeAccount: { logout(): Promise<void> } | null = null;
    let codexAccount: { logout(): Promise<void> } | null = null;
    const creds = (): { id: string }[] =>
      (JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8')) as { credentials: { id: string }[] }).credentials;
    try {
      app = await launch();
      app.store.setLocalRunner({ runnerId: RUNNER, dir, socket });
      app.runners.onPush({
        type: 'instance.upsert',
        instance: { id: ENV, runnerId: RUNNER, definition: 'example', status: 'active', createdAt: 1, updatedAt: 1, repos: [] },
      });
      const claude = await import('../../src/main/providers/claude-oauth');
      const codex = await import('../../src/main/providers/codex-oauth');
      claudeAccount = claude.account;
      codexAccount = codex.account;
      claude.account.save({
        accessToken: 'claude-access',
        refreshToken: 'claude-refresh',
        expiresAt: Date.now() + 60 * 60_000,
        scopes: ['user:inference'],
      });
      codex.account.save({
        idToken: 'id',
        accessToken: 'codex-access',
        refreshToken: 'codex-refresh',
        accountId: 'acct',
        lastRefresh: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (!url.includes('auth.openai.com')) throw new Error(`unexpected fetch ${url}`);
          refreshWaiting = true;
          await refreshGate;
          return new Response(JSON.stringify({ id_token: 'id2', access_token: 'access2', refresh_token: 'refresh2' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }),
      );
      const cursors = await import('../../src/main/instances/store');
      cursors.updateCursor(ENV, { harnesses: ['claude-code', 'codex'], pendingCredentialRemoval: ['leftover'] });

      await app.instances.open(ENV);
      await until('codex refresh held', () => refreshWaiting);
      await claude.account.logout();
      const removal = app.instances.onHarnessLogout('claude-code');
      releaseRefresh();
      await removal;
      await until('sync put landed', () => creds().some((c) => c.id === 'codex'));
      const { flushWrites } = await import('../../src/main/jsonstore');
      await flushWrites();
      expect(creds().some((c) => c.id === 'claude-code')).toBe(false);
      const saved = JSON.parse(fs.readFileSync(path.join(app.data, 'puck-instances.json'), 'utf8')) as {
        instances: Record<string, { pendingCredentialRemoval: string[] }>;
      };
      expect(saved.instances[ENV].pendingCredentialRemoval).toEqual(['leftover']);
    } finally {
      releaseRefresh();
      vi.unstubAllGlobals();
      await claudeAccount?.logout().catch(() => undefined);
      await codexAccount?.logout().catch(() => undefined);
      app?.instances.shutdown();
    }
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
