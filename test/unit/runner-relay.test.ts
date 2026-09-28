import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunnerInfo } from '../../src/harness/runner-protocol';
import { ServerApi, RunnerSession, type RunnerRemovedError } from '../../src/puck-runner/api';
import { BundleCache } from '../../src/puck-runner/bundles';
import { configure } from '../../src/puck-runner/configure';
import { Control } from '../../src/puck-runner/control';
import type { DockerOptions, DockerResult, DockerSpawner } from '../../src/puck-runner/docker/client';
import { DockerOps } from '../../src/puck-runner/docker/ops';
import { readConfig, runnerPaths } from '../../src/puck-runner/files';
import { loadRunnerKey } from '../../src/puck-runner/identity';
import { createLogger, nullLogger } from '../../src/puck-runner/log';
import { RelayConnection } from '../../src/puck-runner/relay';
import { ControlClient, RelayApp } from '../relay-client';
import { call, signIn, startServer, type Harness, type SignedIn } from './server-fakes';

// A real runner connection (registration, token exchange, WebSocket,
// signed channel handshakes, credit-based flow control) against the real
// Puck server, with Docker faked: a scripted app opens control and attach
// channels through the relay, and the server never sees plaintext.

let dir: string;
let h: Harness;
let relay: RelayConnection | null = null;
let app: RelayApp | null = null;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-relay-'));
});
afterEach(async () => {
  app?.close();
  await relay?.stop();
  relay = null;
  await h?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const DOCKER_INFO = JSON.stringify({ ServerVersion: '27.3.1', NCPU: 8, MemTotal: 16e9 });

function fakeDocker(state: () => string | null) {
  const calls: { args: string[]; input?: DockerOptions['input'] }[] = [];
  const run = async (args: string[], opts: DockerOptions = {}): Promise<DockerResult> => {
    calls.push({ args, input: opts.input });
    if (args[0] === 'info') return { code: 0, stdout: DOCKER_INFO, stderr: '' };
    if (args[0] === 'container' && args[1] === 'inspect') {
      const s = state();
      return s ? { code: 0, stdout: `${s}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'No such container' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

/** Stands in for `docker exec -i … puckd.js attach`: echoes lines, or floods stdout on "flood N". */
const echoSpawner: DockerSpawner = () =>
  spawn(
    process.execPath,
    [
      '-e',
      `let buf='';process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);
       const m=/^flood (\\d+)$/.exec(l);if(m){const n=+m[1];const chunk='x'.repeat(65536);let left=n;const w=()=>{while(left>0){const k=Math.min(left,chunk.length);left-=k;if(!process.stdout.write(chunk.slice(0,k)))return process.stdout.once('drain',w)}process.stdout.write('\\nend\\n')};w()}
       else process.stdout.write('echo:'+l+'\\n')}});`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

async function bringUp(
  session: SignedIn,
  containerState: () => string | null = () => 'running',
  extra: { instanceState?: (envId: string) => Promise<string | null>; spawner?: DockerSpawner } = {},
) {
  const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: session.accessToken });
  const paths = runnerPaths(path.join(dir, 'runner'));
  const docker = fakeDocker(containerState);
  await configure(
    { url: h.base, token: String(reg.body.token), name: 'build-box', labels: 'gpu', unattended: true, replace: false, disableUpdate: true },
    { paths, docker: docker.run, io: { print: () => undefined, ask: async (_q, f) => f, interactive: false }, version: '0.1.0', platform: { os: 'linux', arch: 'x64' } },
  );
  const config = readConfig(paths);
  const key = loadRunnerKey(paths);
  const api = new ServerApi(h.base);
  // Assertions name the server's public URL; the socket goes to where it listens.
  const session2 = new RunnerSession(api, config.runnerId, key, config.serverUrl, () => h.clock.now());
  const ops = new DockerOps(docker.run);
  const bundles = new BundleCache(paths.cache);
  const log = createLogger({ dir: paths.diag });
  const removed: RunnerRemovedError[] = [];
  const control = new Control({
    ops,
    bundles,
    log,
    info: async (): Promise<RunnerInfo> => ({
      runnerId: config.runnerId,
      name: config.name,
      version: '0.1.0',
      os: 'linux',
      arch: 'x64',
      labels: config.labels,
      maxEnvironments: null,
      docker: { ok: true, version: '27.3.1', problem: null, detail: null, ncpu: 8, memTotal: 16e9 },
      running: 0,
    }),
    mint: (envId) => session2.withToken((t) => api.githubToken(envId, t)),
    started: () => undefined,
    removed: () => undefined,
    maxEnvironments: () => null,
  });
  relay = new RelayConnection({
    runnerId: config.runnerId,
    version: '0.1.0',
    serverUrl: h.base,
    session: session2,
    key: key.privateKey,
    log: nullLogger,
    control,
    spawner: extra.spawner ?? echoSpawner,
    status: async () => ({
      version: '0.1.0',
      docker: { ok: true, version: '27.3.1', problem: null, ncpu: 8, memTotal: 16e9 },
      maxEnvironments: null,
      instances: [],
    }),
    instanceState: extra.instanceState ?? ((envId) => ops.state(envId)),
    onRemoved: (err) => removed.push(err),
    onOutdated: () => undefined,
  });
  relay.start();
  for (let i = 0; i < 100 && !relay.connected; i++) await new Promise((r) => setTimeout(r, 20));
  expect(relay.connected).toBe(true);
  return { config, key, docker, removed, paths, bundles };
}

describe('runner relay (in process, real server)', { timeout: 30_000 }, () => {
  it('registers, connects, reports Docker, and answers a control channel end to end encrypted', async () => {
    h = await startServer();
    h.github.addUser('octo');
    const session = await signIn(h, 'octo');
    const { config, key } = await bringUp(session);
    expect(config.serverUrl).toBe('http://puck.test');
    expect(fs.statSync(path.join(dir, 'runner', '.runner_key')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'runner', '.credentials')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, 'runner', '.runner')).mode & 0o777).toBe(0o644);

    await new Promise((r) => setTimeout(r, 50));
    const listed = (await call(h, 'GET', '/v1/runners', { token: session.accessToken })).body.runners as Record<string, unknown>[];
    expect(listed[0]).toMatchObject({
      id: config.runnerId,
      name: 'build-box',
      labels: ['linux', 'x64', 'gpu'],
      status: 'idle',
      fingerprint: key.fingerprint,
      docker: { ok: true, version: '27.3.1', ncpu: 8 },
    });

    app = await RelayApp.connect(h.base, session.accessToken);
    const control = new ControlClient(await app.open(config.runnerId, String(listed[0].publicKey), 'control'));
    expect(await control.welcome()).toMatchObject({ protocol: 1, runnerId: config.runnerId, version: '0.1.0' });
    expect(await control.cmd<RunnerInfo>('runner.info')).toMatchObject({ name: 'build-box', docker: { version: '27.3.1' } });

    // A bundle larger than one frame and one credit window crosses the relay intact.
    const bundle = Buffer.alloc(700 * 1024, 5);
    const sha = createHash('sha256').update(bundle).digest('hex');
    const half = bundle.length / 2;
    await control.cmd('bundle.put', { sha, offset: 0, data: bundle.subarray(0, half).toString('base64'), last: false });
    expect(await control.cmd('bundle.put', { sha, offset: half, data: bundle.subarray(half).toString('base64'), last: true })).toEqual({
      received: bundle.length,
      complete: true,
    });
    expect(await control.cmd('bundle.has', { sha })).toEqual({ has: true });
  });

  it('pipes an attach channel to the environment daemon, with backpressure, and refuses unknown environments', async () => {
    h = await startServer();
    h.github.addUser('octo');
    h.github.addRepo('octo/app', { pushers: ['octo'] });
    const session = await signIn(h, 'octo');
    let state: string | null = 'running';
    const { config } = await bringUp(session, () => state);
    const runner = (await call(h, 'GET', '/v1/runners', { token: session.accessToken })).body.runners as { publicKey: string }[];
    const created = await call(h, 'POST', '/v1/instances', {
      token: session.accessToken,
      body: { runnerId: config.runnerId, definition: 'example', repos: ['octo/app'] },
    });
    expect(created.status).toBe(201);
    const envId = String(created.body.envId);

    app = await RelayApp.connect(h.base, session.accessToken);
    const attach = await app.open(config.runnerId, runner[0].publicKey, 'attach', envId);
    attach.write('hello daemon\n');
    await attach.until((lines) => lines.find((l) => l === 'echo:hello daemon'), 'echo');

    // Three megabytes from the daemon: the runner pauses the exec while the app has no credit.
    attach.write('flood 3145728\n');
    await attach.until((lines) => lines.find((l) => l === 'end'), 'end of flood');
    const flood = attach.lines.find((l) => l.startsWith('xxx')) as string;
    expect(flood.length).toBe(3145728);
    expect(attach.closed).toBeNull();

    state = 'exited';
    await expect(app.open(config.runnerId, runner[0].publicKey, 'attach', envId)).rejects.toThrow('not-running');
  });

  it('creates an environment with the first GitHub grants minted by the server for this runner', async () => {
    h = await startServer();
    h.github.addUser('octo');
    h.github.addRepo('octo/app', { pushers: ['octo'], installationId: 9 });
    const session = await signIn(h, 'octo');
    let state: string | null = null;
    const { config, docker, bundles } = await bringUp(session, () => state);
    const runner = (await call(h, 'GET', '/v1/runners', { token: session.accessToken })).body.runners as { publicKey: string }[];
    const envId = String(
      (await call(h, 'POST', '/v1/instances', { token: session.accessToken, body: { runnerId: config.runnerId, definition: 'example', repos: ['octo/app'] } }))
        .body.envId,
    );
    const bundle = Buffer.from('// puckd');
    const sha = createHash('sha256').update(bundle).digest('hex');
    bundles.put(sha, 0, bundle, true);

    app = await RelayApp.connect(h.base, session.accessToken);
    const control = new ControlClient(await app.open(config.runnerId, runner[0].publicKey, 'control'));
    await control.cmd('instance.create', {
      envId,
      image: 'node:22-bookworm',
      bundleSha: sha,
      inbox: { instance: { envId, name: 'Example', definition: { name: 'example' } } },
    });
    state = 'running';
    expect(control.events().map((e) => e.stage)).toContain('starting-container');
    expect(h.github.mints).toEqual([expect.objectContaining({ installationId: 9, permissions: expect.objectContaining({ contents: 'write' }) })]);
    const cp = docker.calls.find((c) => c.args[0] === 'cp');
    expect((cp?.input as Buffer).toString('latin1')).toMatch(/"grants":\[\{"owner":"octo","installationId":9,"repos":\["octo\/app"\],"token":"ghs_/);
    // The token never appears in any argv.
    expect(docker.calls.map((c) => c.args.join(' ')).join('\n')).not.toMatch(/ghs_/);
  });

  it('drops an attach open when the socket it arrived on is gone', async () => {
    h = await startServer();
    h.github.addUser('octo');
    h.github.addRepo('octo/app', { pushers: ['octo'] });
    const session = await signIn(h, 'octo');
    let releaseState: (state: string | null) => void = () => undefined;
    let sawInspect = false;
    let holdInspect = true;
    const spawned: string[][] = [];
    const { config } = await bringUp(session, () => 'running', {
      instanceState: () => {
        if (!holdInspect) return Promise.resolve('running');
        sawInspect = true;
        return new Promise((resolve) => {
          releaseState = (state) => {
            holdInspect = false;
            resolve(state);
          };
        });
      },
      spawner: (args) => {
        spawned.push(args);
        return echoSpawner(args);
      },
    });
    const runner = (await call(h, 'GET', '/v1/runners', { token: session.accessToken })).body.runners as { publicKey: string }[];
    const envId = String(
      (await call(h, 'POST', '/v1/instances', { token: session.accessToken, body: { runnerId: config.runnerId, definition: 'example', repos: ['octo/app'] } }))
        .body.envId,
    );
    app = await RelayApp.connect(h.base, session.accessToken);
    const first = app.open(config.runnerId, runner[0].publicKey, 'attach', envId).then(
      () => 'accepted' as const,
      (err: unknown) => err,
    );
    for (let i = 0; i < 100 && !sawInspect; i++) await new Promise((r) => setTimeout(r, 20));
    expect(sawInspect).toBe(true);
    const runners = (h.server.relay as unknown as { runners: Map<string, { ws: { terminate(): void } }> }).runners;
    runners.get(config.runnerId)?.ws.terminate();
    for (let i = 0; i < 50 && relay?.connected; i++) await new Promise((r) => setTimeout(r, 20));
    expect(relay?.connected).toBe(false);
    for (let i = 0; i < 150 && !relay?.connected; i++) await new Promise((r) => setTimeout(r, 20));
    expect(relay?.connected).toBe(true);
    releaseState('running');
    await new Promise((r) => setTimeout(r, 50));
    expect(spawned).toEqual([]);
    expect(await first).toBeInstanceOf(Error);

    const attach = await app.open(config.runnerId, runner[0].publicKey, 'attach', envId);
    attach.write('hello daemon\n');
    await attach.until((lines) => lines.find((l) => l === 'echo:hello daemon'), 'echo');
    expect(spawned).toHaveLength(1);
  });

  it('stops for good when the runner is removed from Puck', async () => {
    h = await startServer();
    h.github.addUser('octo');
    const session = await signIn(h, 'octo');
    const { config, removed } = await bringUp(session);
    expect((await call(h, 'DELETE', `/v1/runners/${config.runnerId}`, { token: session.accessToken })).status).toBe(204);
    for (let i = 0; i < 100 && !removed.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(removed).toHaveLength(1);
  });
});
