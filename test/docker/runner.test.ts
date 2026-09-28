import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Snapshot } from '../../src/harness/daemon-protocol';
import type { RunnerInfo } from '../../src/harness/runner-protocol';
import { ControlClient, DaemonClient, RelayApp } from '../relay-client';
import { call, type SignedIn } from '../unit/server-fakes';
import { definition, docker, exec, IMAGE, TEST_BUNDLE, turnEvents } from './helpers';
import {
  configureRunner,
  containerStart,
  liveServer,
  removeEnvironments,
  runnerDir,
  RunnerProcess,
  runnerView,
  sh,
  tokenFor,
  uploadBundle,
  waitFor,
  type LiveServer,
} from './runner-helpers';

// Runner scenarios: a real puck-runner process (config.sh, run.sh) against
// the Puck server (in this process, fake GitHub), hosting real environment
// containers that run the test daemon. The suite acts as the app: it opens
// end-to-end encrypted channels through the server's relay.
//
//   1. register against a test server
//   2. create, attach and run a turn through the relay
//   3. the GitHub token pump
//   4. restarting the runner mid-turn leaves the turn unaffected
//      (and a daemon restart mid-turn resumes the conversation by itself)
//   5. removal keeping the environments
//   6. removal deleting them

let server: LiveServer;
let session: SignedIn;
let dirA: string;
let dirB: string;
let runnerA: RunnerProcess | null = null;
let runnerB: RunnerProcess | null = null;
let runnerAId = '';
let runnerKey = '';
let app: RelayApp;
let envId = '';
const envIds: string[] = [];
const bundle = fs.readFileSync(TEST_BUNDLE);

beforeAll(async () => {
  ({ server, session } = await liveServer());
  // Tokens inside the pump's refresh margin from the start, so it renews them right away.
  server.github.installationTokenLifeMs = 14 * 60_000;
  dirA = runnerDir();
  dirB = runnerDir();
});

afterAll(async () => {
  app?.close();
  await runnerA?.stop();
  await runnerB?.stop();
  await removeEnvironments(envIds);
  await server?.close();
  for (const d of [dirA, dirB]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

async function createEnvironment(runnerId: string, publicKey: string, name: string): Promise<{ id: string; control: ControlClient }> {
  const created = await call(server, 'POST', '/v1/instances', {
    token: session.accessToken,
    body: { runnerId, definition: name, repos: ['octo/app'] },
  });
  if (created.status !== 201) throw new Error(`POST /v1/instances: ${JSON.stringify(created.body)}`);
  const id = String(created.body.envId);
  envIds.push(id);
  const control = new ControlClient(await app.open(runnerId, publicKey, 'control'));
  await control.welcome();
  const bundleSha = await uploadBundle(control, bundle);
  await control.cmd('instance.create', {
    envId: id,
    image: IMAGE,
    bundleSha,
    containerEnv: { PUCK_SKIP_PACKAGES: '1', PUCK_TEST_GIT_BASE: 'file:///srv/git/' },
    inbox: { instance: { envId: id, name: 'Example', definition: { ...definition(), name } } },
  });
  return { id, control };
}

async function attachReady(runnerId: string, publicKey: string, id: string, since: number | null = null): Promise<DaemonClient> {
  const channel = await waitFor('an attach channel', async () => app.open(runnerId, publicKey, 'attach', id).catch(() => null), 60_000);
  const d = new DaemonClient(channel);
  await d.hello(since);
  await waitFor('the environment to be ready', async () => {
    const snap = await d.cmd<Snapshot>('snapshot.get');
    if (snap.instance.status === 'failed') throw new Error(`environment failed: ${snap.instance.error}`);
    return snap.instance.status === 'ready';
  }, 120_000);
  return d;
}

describe('Docker scenarios: puck-runner', () => {
  it('1. registers against the test server and reports Docker', async () => {
    const reg = await configureRunner(server, session, dirA, 'suite-a');
    runnerAId = reg.runnerId;
    expect(reg.out).toMatch(/Checking Docker…\nDocker \d+\.\d+/);
    expect(reg.out).toContain('✓ Runner suite-a');
    expect(fs.statSync(path.join(dirA, '.runner_key')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dirA, '.credentials')).mode & 0o777).toBe(0o600);

    runnerA = new RunnerProcess(dirA);
    const view = await waitFor('the runner online with its Docker version', async () => {
      const v = await runnerView(server, session, runnerAId);
      return v && v.status !== 'offline' && (v.docker as { version: string | null } | null)?.version ? v : undefined;
    });
    expect(view).toMatchObject({ name: 'suite-a', status: 'idle', docker: { ok: true } });
    expect((view.docker as { ncpu: number }).ncpu).toBeGreaterThan(0);
    runnerKey = String(view.publicKey);
    app = await RelayApp.connect(server.base, session.accessToken);
  });

  it('2. creates an environment, attaches, and runs a turn through the relay', async () => {
    const { id, control } = await createEnvironment(runnerAId, runnerKey, 'example');
    envId = id;
    expect(control.events().map((e) => e.stage)).toEqual(
      expect.arrayContaining(['checking-image', 'creating-volumes', 'creating-container', 'copying-files', 'starting-container']),
    );
    const listed = await control.cmd<{ instances: { envId: string; state: string }[] }>('instance.list');
    expect(listed.instances).toContainEqual(expect.objectContaining({ envId, state: 'running' }));
    expect((await control.cmd<RunnerInfo>('runner.info')).running).toBeGreaterThanOrEqual(1);

    const d = await attachReady(runnerAId, runnerKey, envId);
    const sent = await d.cmd<{ turnId: string }>('chat.send', { text: 'hello through the relay' });
    await d.untilEvent('turn.end', (ev) => ev.turnId === sent.turnId);
    const text = turnEvents(d.events(), sent.turnId)
      .filter((e) => e.kind === 'text-delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(text).toBe('Echo (fresh): hello through the relay');
    d.channel.close();

    // Hosting a running environment makes the runner Active.
    await waitFor('the runner to read Active', async () => (await runnerView(server, session, runnerAId))?.status === 'active');
  });

  it('3. pumps GitHub installation tokens into the environment, never through argv', async () => {
    const d = await attachReady(runnerAId, runnerKey, envId);
    // The first grant went into the inbox; the pump renewed it because it was inside the refresh margin.
    await waitFor('a second mint', async () => server.github.mints.length >= 2, 90_000);
    expect(server.github.mints[0]).toMatchObject({ installationId: 42, permissions: expect.objectContaining({ contents: 'write' }) });
    const snap = await d.cmd<Snapshot>('snapshot.get');
    expect(snap.github.state).toMatch(/ok|expiring/);
    const stored = await exec(`puck-${envId}`, ['cat', '/puck/state/secrets/github.json']);
    const grants = (JSON.parse(stored.stdout) as { grants: { owner: string; repos: string[]; token: string; expiresAt: number }[] }).grants;
    expect(grants).toEqual([expect.objectContaining({ owner: 'octo', repos: ['octo/app'], token: expect.stringMatching(/^ghs_/) })]);
    expect(snap.github.expiresAt).toBe(grants[0].expiresAt);
    // The token is in no container config and no runner log line.
    const inspect = await docker(['container', 'inspect', `puck-${envId}`]);
    expect(inspect.stdout).not.toContain(grants[0].token);
    expect(runnerA?.log()).not.toContain(grants[0].token);
    expect(runnerA?.log()).toContain('pump.pushed');
    d.channel.close();
  });

  it('4. restarting the runner mid-turn leaves the turn unaffected', async () => {
    const before = await containerStart(envId);
    const d = await attachReady(runnerAId, runnerKey, envId);
    const sent = await d.cmd<{ turnId: string }>('chat.send', { text: '!sleep 8000' });
    const started = await d.untilEvent('turn.start', (ev) => ev.turnId === sent.turnId);

    // Stop the runner mid-turn: the channel drops, the daemon keeps working.
    expect(await runnerA?.stop()).toBe(0);
    await waitFor('the attach channel to close', async () => d.channel.closed !== null, 30_000);
    const during = await containerStart(envId);
    expect(during).toEqual(before);

    runnerA = new RunnerProcess(dirA);
    // Re-attach from the last event seen: the rest of the turn replays and ends normally.
    const lastSeq = Math.max(started.seq, ...d.events().map((f) => f.seq));
    const channel = await waitFor('an attach channel after the restart', async () => app.open(runnerAId, runnerKey, 'attach', envId).catch(() => null), 60_000);
    const again = new DaemonClient(channel);
    expect((await again.hello(lastSeq)).replay).toBe('events');
    const end = await again.untilEvent('turn.end', (ev) => ev.turnId === sent.turnId, 60_000);
    expect(end.ev).toMatchObject({ kind: 'turn.end', turnId: sent.turnId });
    const events = [...turnEvents(d.events(), sent.turnId), ...turnEvents(again.events(), sent.turnId)];
    expect(events.some((e) => e.kind === 'error')).toBe(false);
    expect(events[events.length - 1].kind).toBe('turn-end');
    const snap = await again.cmd<Snapshot>('snapshot.get');
    expect(snap.sessions.find((s) => s.id === snap.orchestratorSessionId)?.status).toBe('idle');
    expect(await containerStart(envId)).toEqual(before);
    again.channel.close();
  });

  it('4b. a daemon restart mid-turn resumes the conversation through the harness session, behind the same runner', async () => {
    const d = await attachReady(runnerAId, runnerKey, envId);
    const sent = await d.cmd<{ turnId: string }>('chat.send', { text: '!sleep 8000' });
    await d.untilEvent('turn.start', (ev) => ev.turnId === sent.turnId);
    await docker(['restart', '-t', '30', `puck-${envId}`], { timeoutMs: 90_000 });
    await waitFor('the attach channel to close', async () => d.channel.closed !== null, 30_000);

    // The runner never restarted; the daemon comes back and continues the interrupted conversation itself.
    const again = await attachReady(runnerAId, runnerKey, envId);
    const snap = await again.cmd<Snapshot>('snapshot.get');
    const resumed = await waitFor('the resumed turn', async () => {
      const history = await again.cmd<{ entries: { kind: string; author?: string; text?: string; turnId?: string; events?: { kind: string; text?: string }[] }[] }>(
        'session.history',
        { sessionId: snap.orchestratorSessionId },
      );
      const i = history.entries.findIndex((e) => e.kind === 'user' && e.author === 'system' && e.text === 'Continue.');
      const turn = i >= 0 ? history.entries.slice(i + 1).find((e) => e.kind === 'turn') : undefined;
      return turn?.events?.some((e) => e.kind === 'turn-end') ? turn : undefined;
    }, 60_000);
    const text = (resumed.events ?? []).filter((e) => e.kind === 'text-delta').map((e) => e.text).join('');
    expect(text).toBe('Echo (resumed): Continue.');
    again.channel.close();
  });

  it('5. removes a runner and keeps its environments', async () => {
    const token = await tokenFor(server, session, 'removal');
    const r = await sh(dirA, 'config.sh', ['remove', '--token', token, '--keep-environments']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('✓ Runner suite-a removed.');
    // The server drops the removed runner's socket, and run.sh stops for good.
    expect(await runnerA?.exit).toBe(78);
    runnerA = null;
    for (const f of ['.runner', '.credentials', '.runner_key']) expect(fs.existsSync(path.join(dirA, f))).toBe(false);
    expect((await containerStart(envId))?.running).toBe(true);
    const instance = await call(server, 'GET', `/v1/instances/${envId}`, { token: session.accessToken });
    expect(instance.body).toMatchObject({ instance: { status: 'orphaned' } });
    // The user deletes the kept environment by hand later, with docker.
    await removeEnvironments([envId]);
  });

  it('6. removes a runner and deletes its environments', async () => {
    // Removal deletes every Puck environment on the machine (it lists them first): never run this
    // next to environments the suite did not create.
    const foreign = (await docker(['ps', '-a', '--filter', 'label=puck=instance', '--format', '{{.Label "puck.env"}}'])).stdout
      .split('\n')
      .filter((id) => id && !envIds.includes(id));
    if (foreign.length) throw new Error(`This Docker engine hosts Puck environments the suite did not create (${foreign.join(', ')}); not deleting them.`);
    const { runnerId } = await configureRunner(server, session, dirB, 'suite-b');
    runnerB = new RunnerProcess(dirB);
    const view = await waitFor('runner B online', async () => {
      const v = await runnerView(server, session, runnerId);
      return v && v.status !== 'offline' ? v : undefined;
    });
    const { id } = await createEnvironment(runnerId, String(view.publicKey), 'doomed');
    expect((await containerStart(id))?.running).toBe(true);

    const token = await tokenFor(server, session, 'removal');
    const r = await sh(dirB, 'config.sh', ['remove', '--token', token, '--delete-environments']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('and its environments deleted');
    expect(await runnerB?.exit).toBe(78);
    runnerB = null;
    expect(await containerStart(id)).toBeNull();
    const volumes = await docker(['volume', 'ls', '-q', '--filter', `label=puck.env=${id}`]);
    expect(volumes.stdout.trim()).toBe('');
    expect((await call(server, 'GET', `/v1/instances/${id}`, { token: session.accessToken })).status).toBe(404);
  });
});
