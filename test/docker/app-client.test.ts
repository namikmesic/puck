import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartSpec } from '../../src/harness/bridge';
import type { DaemonEvent, Pin } from '../../src/harness/daemon-protocol';
import type { ResolvedEnvironment } from '../../src/harness/definitions/types';
import type { RunnerInfo } from '../../src/harness/runner-protocol';
import { readRunner, type ServerRunner } from '../../src/harness/server-api';
import { DaemonClient, type AttachState } from '../../src/main/instances/daemon-client';
import { create, type StartDeps } from '../../src/main/instances/start-flow';
import type { ByteChannel } from '../../src/main/runners/channel';
import { ControlClient } from '../../src/main/runners/control-client';
import { openLocalChannel } from '../../src/main/runners/local';
import { ServerConnection } from '../../src/main/server/connection';
import { call, type SignedIn } from '../unit/server-fakes';
import { definition, IMAGE, TEST_BUNDLE } from './helpers';
import { liveServer, removeEnvironments, runnerDir, RunnerProcess, runnerView, sh, tokenFor, waitFor, type LiveServer } from './runner-helpers';

// The desktop app's client against a real runner process and real
// environment containers running the test daemon: the app's own server
// socket and encrypted relay channels, its control client, the start
// flow's create sequence, and its daemon client (handshake, orchestrator
// turn, replay from the cursor after a reattach). The same runner also
// listens on its local socket, as the This Mac runner does, and the same
// clients work over it with no relay.

let server: LiveServer;
let session: SignedIn;
let dir = '';
let socket = '';
let proc: RunnerProcess | null = null;
let conn: ServerConnection;
let runner: ServerRunner;
let envId = '';
const clients: DaemonClient[] = [];
const bundle = fs.readFileSync(TEST_BUNDLE);
const pin: Pin = { kind: 'tag', name: 'v1.0.0', sha: 'a'.repeat(40) };

beforeAll(async () => {
  ({ server, session } = await liveServer());
  dir = runnerDir();
  socket = path.join(dir, 'local.sock');
  const token = await tokenFor(server, session, 'registration');
  const r = await sh(dir, 'config.sh', ['--url', server.base, '--token', token, '--name', 'suite-app', '--unattended', '--local-socket', socket]);
  if (r.code !== 0) throw new Error(`config.sh failed: ${r.out}`);
  proc = new RunnerProcess(dir);
  const runnerId = (JSON.parse(fs.readFileSync(path.join(dir, '.runner'), 'utf8')) as { runnerId: string }).runnerId;
  const view = await waitFor('the runner online', async () => {
    const v = await runnerView(server, session, runnerId);
    return v && v.status !== 'offline' ? v : undefined;
  });
  runner = readRunner(view) as ServerRunner;
  await waitFor('the local socket', async () => fs.existsSync(socket));
  conn = new ServerConnection({
    url: () => server.base,
    session: async () => ({ accessToken: session.accessToken, accessExpiresAt: Date.now() + 14 * 60_000 }),
    onPush: () => undefined,
    onConnected: () => undefined,
    log: { info: () => undefined, warn: () => undefined },
  });
  conn.start();
  await waitFor('the app socket', async () => conn.socketState === 'connected');
});

afterAll(async () => {
  for (const c of clients) c.stop();
  conn?.stop();
  await proc?.stop();
  await removeEnvironments(envId ? [envId] : []);
  await server?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function resolved(): ResolvedEnvironment {
  return {
    ...(definition() as unknown as ResolvedEnvironment),
    source: { repo: 'octo/config', pin, path: 'environments/example.yaml' },
    image: IMAGE,
    dockerfile: null,
    resources: { cpus: null, memory: null },
    policies: { asks: 'orchestrator-first', publish: 'manual', draftPullRequests: true },
  };
}

function attach(open: () => Promise<ByteChannel>, cursor: { seq: number | null }, seen: { seq: number; ev: DaemonEvent }[]): DaemonClient {
  const states: AttachState[] = [];
  const c = new DaemonClient({
    envId,
    open,
    since: () => cursor.seq,
    saveSeq: (s) => (cursor.seq = s),
    onEvent: (seq, _at, ev) => seen.push({ seq, ev }),
    onSnapshot: () => undefined,
    onState: (s) => states.push(s),
    client: { app: 'puck', build: 'docker-suite' },
    timing: { backoffMs: [250, 500, 1000] },
  });
  clients.push(c);
  c.start();
  return c;
}

const text = (seen: { ev: DaemonEvent }[], turnId: string): string =>
  seen
    .map((e) => e.ev)
    .filter((ev): ev is Extract<DaemonEvent, { kind: 'turn.event' }> => ev.kind === 'turn.event' && ev.turnId === turnId)
    .map((ev) => (ev.event.kind === 'text-delta' ? ev.event.text : ''))
    .join('');

async function ready(c: DaemonClient): Promise<void> {
  await waitFor('attached', async () => c.attachState === 'attached', 120_000);
  await waitFor('the environment to be ready', async () => {
    const snap = await c.cmd('snapshot.get', {} as never).catch(() => null);
    if (snap?.instance.status === 'failed') throw new Error(`environment failed: ${snap.instance.error}`);
    return snap?.instance.status === 'ready';
  }, 120_000);
}

describe('Docker scenarios: the app client', () => {
  it('1. starts an environment on a runner through the relay, and the orchestrator answers', async () => {
    const relay = (kind: 'control' | 'attach', env?: string) => conn.openChannel(runner.id, runner.publicKey, kind, env);
    const ctl = new ControlClient(await relay('control'));
    expect((await ctl.cmd('runner.info', {})) as RunnerInfo).toMatchObject({ name: 'suite-app' });
    const stages: string[] = [];
    const deps: StartDeps = {
      resolve: async () => resolved(),
      runner: () => null,
      hosted: () => 0,
      checkTransport: () => undefined,
      harnessSignedIn: () => true,
      harnessLabel: (id) => id,
      harnessCredential: async () => null,
      containerEnv: () => ({ PUCK_SKIP_PACKAGES: '1', PUCK_TEST_GIT_BASE: 'file:///srv/git/' }),
      createIndexEntry: async (req) => {
        const res = await call(server, 'POST', '/v1/instances', { token: session.accessToken, body: req });
        if (res.status !== 201) throw new Error(JSON.stringify(res.body));
        return { envId: String(res.body.envId) };
      },
      forgetIndexEntry: async (id) => void (await call(server, 'DELETE', `/v1/instances/${id}`, { token: session.accessToken })),
      control: (_r, op, args, opts) => ctl.cmd(op, args, opts),
      daemonBundle: () => ({ source: bundle.toString('utf8'), sha: createHash('sha256').update(bundle).digest('hex') }),
      onStage: (_e, stage) => stages.push(stage),
      log: { info: () => undefined },
    };
    const spec: StartSpec = { pin: { kind: 'tag', name: 'v1.0.0' }, definition: 'example', runnerId: runner.id, secrets: { NPM_TOKEN: 'npm-secret' } };
    envId = await create({ definition: resolved(), pin, harnesses: [], runnerId: runner.id }, spec, deps, () => undefined);
    expect(stages).toEqual(expect.arrayContaining(['creating-volumes', 'creating-container', 'copying-files', 'starting-container']));
    ctl.close();

    const cursor = { seq: null as number | null };
    const seen: { seq: number; ev: DaemonEvent }[] = [];
    const c = attach(() => relay('attach', envId), cursor, seen);
    await ready(c);
    const sent = await c.cmd('chat.send', { text: 'hello from the app' });
    await waitFor('the turn to end', async () => seen.some((e) => e.ev.kind === 'turn.end' && e.ev.turnId === sent.turnId), 60_000);
    expect(text(seen, sent.turnId as string)).toBe('Echo (fresh): hello from the app');
    await waitFor('the runner to read Active', async () => (await runnerView(server, session, runner.id))?.status === 'active');

    // Quit and reopen: the next attach replays exactly what happened meanwhile, from the cursor.
    c.stop();
    const at = cursor.seq as number;
    const other = attach(() => relay('attach', envId), { seq: at }, []);
    await ready(other);
    const later = await other.cmd('chat.send', { text: 'while the app was closed' });
    await waitFor('the second turn', async () => {
      const snap = await other.cmd('snapshot.get', {} as never);
      return snap.head > at + 3;
    });
    other.stop();
    const replayed: { seq: number; ev: DaemonEvent }[] = [];
    const reopened = attach(() => relay('attach', envId), cursor, replayed);
    await waitFor('the replay', async () => replayed.some((e) => e.ev.kind === 'turn.end' && e.ev.turnId === later.turnId), 60_000);
    expect(replayed.every((e) => e.seq > at)).toBe(true);
    expect(text(replayed, later.turnId as string)).toBe('Echo (resumed): while the app was closed');
    reopened.stop();
  });

  it("2. reaches the same runner over its local socket, as This Mac's", async () => {
    const ctl = new ControlClient(await openLocalChannel(socket, 'control'));
    expect(await ctl.welcome).toMatchObject({ runnerId: runner.id });
    const listed = await ctl.cmd('instance.list', {});
    expect(listed.instances).toContainEqual(expect.objectContaining({ envId, state: 'running' }));
    ctl.close();
    expect(fs.statSync(socket).mode & 0o777).toBe(0o600);

    // No relay involved: the app's server socket is down and attach still works.
    conn.stop('test');
    const seen: { seq: number; ev: DaemonEvent }[] = [];
    const c = attach(() => openLocalChannel(socket, 'attach', envId), { seq: null }, seen);
    await ready(c);
    const sent = await c.cmd('chat.send', { text: 'over the local socket' });
    await waitFor('the local turn', async () => seen.some((e) => e.ev.kind === 'turn.end' && e.ev.turnId === sent.turnId), 60_000);
    expect(text(seen, sent.turnId as string)).toMatch(/over the local socket$/);
    c.stop();
    conn.start();
  });
});
