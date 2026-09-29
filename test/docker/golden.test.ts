import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartSpec } from '../../src/harness/bridge';
import type { DaemonEvent, ItemStatus, Pin, Snapshot, WorkItem } from '../../src/harness/daemon-protocol';
import type { PinSpec } from '../../src/harness/definitions/types';
import { readRunner, type ServerRunner } from '../../src/harness/server-api';
import type { TranscriptEntry } from '../../src/harness/transcript';
import { createConfigRepo } from '../../src/main/config-repo';
import { DaemonClient } from '../../src/main/instances/daemon-client';
import { create, preflight, type StartDeps } from '../../src/main/instances/start-flow';
import { applyUpdate, checkUpdate, type UpdateDeps } from '../../src/main/instances/update';
import { ControlClient } from '../../src/main/runners/control-client';
import { openLocalChannel } from '../../src/main/runners/local';
import { fakeConfigRepo } from '../unit/config-repo-fakes';
import { AGENT, ENV, exampleFiles, patchYaml, type Files } from '../unit/definitions-fixtures';
import { call, type SignedIn } from '../unit/server-fakes';
import { copyIn, exec, FAKE_GITHUB, IMAGE, must, TEST_BUNDLE } from './helpers';
import { liveServer, removeEnvironments, runnerDir, RunnerProcess, sh, tokenFor, waitFor, type LiveServer } from './runner-helpers';

// The golden scenario, steps 1-6, with the scripted fake harness in place
// of Claude Code: the app's own start flow, config repo, daemon client and
// update check drive a real Puck server (with a fake GitHub), a real runner
// set up the way This Mac's is (reached over its local socket), and a real
// environment container. Step 7 (a remote Linux runner) and the real
// accounts stay with the owner.
//
//   1. Sign in with GitHub, the App is installed, the config repo holds the
//      example definitions, and Claude Code is connected.
//   2. Start `example` on This Mac at the newest tag.
//   3. Ask the orchestrator for two items for implementer: with
//      maxParallel 2 both run at once and reach review with diff stats.
//   4. Publish one: a draft pull request from `puck/W-1-…`.
//   5. Quit while an item runs; it finishes meanwhile; after reopening it is
//      in review, and the orchestrator's transcript holds the notice and its
//      reaction.
//   6. A new tag changes maxParallel: the update is offered, and applying
//      it is hot and interrupts nothing.

const CONFIG = 'octo/config';
const V1 = '1'.repeat(40);
const V2 = '2'.repeat(40);
const CLAUDE_CREDENTIAL = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-golden', refreshToken: 'sk-ant-ort-golden', expiresAt: 4102444800000 } });

let server: LiveServer;
let session: SignedIn;
let dir = '';
let socket = '';
let proc: RunnerProcess | null = null;
let runner: ServerRunner;
let envId = '';
const clients: DaemonClient[] = [];
const bundle = fs.readFileSync(TEST_BUNDLE);

/** The example config repo, pointed at the suite's repository and image. */
function release(maxParallel: number): Files {
  const files = exampleFiles();
  patchYaml(files, ENV, {
    image: IMAGE,
    resources: undefined,
    repos: [{ github: 'octo/app', dir: 'app', branch: 'main' }],
    agents: [
      { agent: 'implementer', maxParallel },
      { agent: 'reviewer', maxParallel: 1, instructions: 'Review only; never push.' },
    ],
    // Publishing from work detail, as a person does in step 4.
    policies: { asks: 'orchestrator-first', publish: 'manual', draftPullRequests: true },
  });
  patchYaml(files, AGENT, { options: undefined });
  return files;
}

const config = fakeConfigRepo({ repo: CONFIG, commits: { [V1]: { files: release(2) } }, tags: { 'v1.0.0': V1 } });
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-golden-defs-'));
const repo = createConfigRepo({ client: () => config.client, repo: () => CONFIG, cacheDir: () => cacheDir });
const resolve = async (spec: PinSpec, name: string) => repo.resolve(spec, name);

beforeAll(async () => {
  ({ server, session } = await liveServer());
  dir = runnerDir();
  socket = path.join(dir, 'local.sock');
  const token = await tokenFor(server, session, 'registration');
  const r = await sh(dir, 'config.sh', ['--url', server.base, '--token', token, '--name', 'this-mac', '--unattended', '--local-socket', socket]);
  if (r.code !== 0) throw new Error(`config.sh failed: ${r.out}`);
  proc = new RunnerProcess(dir);
  const runnerId = (JSON.parse(fs.readFileSync(path.join(dir, '.runner'), 'utf8')) as { runnerId: string }).runnerId;
  runner = await waitFor('the runner online', async () => {
    const res = await call(server, 'GET', '/v1/runners', { token: session.accessToken });
    const view = (res.body.runners as Record<string, unknown>[]).find((v) => v.id === runnerId);
    return view && view.status !== 'offline' ? (readRunner(view) as ServerRunner) : undefined;
  });
  await waitFor('the local socket', async () => fs.existsSync(socket));
});

afterAll(async () => {
  for (const c of clients) c.stop();
  await proc?.stop();
  await removeEnvironments(envId ? [envId] : []);
  await server?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

/** The app's daemon client over This Mac's local socket, recording every event. */
function attach(cursor: { seq: number | null }, seen: { seq: number; ev: DaemonEvent }[]): DaemonClient {
  const c = new DaemonClient({
    envId,
    open: () => openLocalChannel(socket, 'attach', envId),
    since: () => cursor.seq,
    saveSeq: (s) => (cursor.seq = s),
    onEvent: (seq, _at, ev) => seen.push({ seq, ev }),
    onSnapshot: () => undefined,
    onState: () => undefined,
    client: { app: 'puck', build: 'golden' },
    timing: { backoffMs: [250, 500, 1000] },
  });
  clients.push(c);
  c.start();
  return c;
}

const snapshot = (c: DaemonClient): Promise<Snapshot> => c.cmd('snapshot.get', {} as never);

async function until(c: DaemonClient, what: string, pred: (s: Snapshot) => boolean, ms = 120_000): Promise<Snapshot> {
  return waitFor(what, async () => {
    const s = await snapshot(c).catch(() => null);
    if (s?.instance.status === 'failed') throw new Error(`environment failed: ${s.instance.error}`);
    return s && pred(s) ? s : undefined;
  }, ms);
}

async function ready(c: DaemonClient): Promise<Snapshot> {
  await waitFor('attached', async () => c.attachState === 'attached', 120_000);
  return until(c, 'the environment to be ready', (s) => s.instance.status === 'ready');
}

const tool = (name: string, args: unknown): string => `!tool ${name} ${JSON.stringify(args)}`;

/** A worker body the fake harness runs: one commit, then long enough for overlaps to show. */
const work = (commands: string, subject: string, sleepMs: number): string =>
  [`!exec ${commands} && git commit -qm "${subject}" && echo done`, `!sleep ${sleepMs}`].join('\n');

/** The most items running (or waiting on a question) at once, from the recorded item events. */
function peakRunning(seen: { ev: DaemonEvent }[]): number {
  const status = new Map<string, ItemStatus>();
  let peak = 0;
  for (const { ev } of seen) {
    if (ev.kind !== 'item.upsert') continue;
    status.set(ev.item.id, ev.item.status);
    peak = Math.max(peak, [...status.values()].filter((s) => s === 'running' || s === 'needs-input').length);
  }
  return peak;
}

describe('golden scenario (fake harness)', () => {
  const cursor = { seq: null as number | null };
  const seen: { seq: number; ev: DaemonEvent }[] = [];
  let client: DaemonClient;
  let pin: Pin;

  it('1. signs in with GitHub, finds the App installed and the example definitions, with Claude Code connected', async () => {
    const me = await call(server, 'GET', '/v1/me', { token: session.accessToken });
    expect(me.body.user).toMatchObject({ login: 'octo' });
    expect((me.body.github as { installUrl: string }).installUrl).toMatch(/\/apps\/[^/]+\/installations\/new$/);

    const refs = await repo.refs();
    expect(refs.defaultTag).toBe('v1.0.0');
    const listing = await repo.listing({ kind: 'tag', name: 'v1.0.0' });
    expect(listing.errors).toEqual([]);
    expect(listing.environments.map((e) => e.name)).toContain('example');
  });

  it('2. starts example on This Mac at the newest tag', async () => {
    const ctl = new ControlClient(await openLocalChannel(socket, 'control'));
    const deps: StartDeps = {
      resolve,
      runner: (id) => (id === runner.id ? runner : null),
      hosted: () => 0,
      checkTransport: () => undefined,
      harnessSignedIn: (id) => id === 'claude-code',
      harnessLabel: (id) => id,
      harnessCredential: async (id) => (id === 'claude-code' ? CLAUDE_CREDENTIAL : null),
      containerEnv: () => ({ PUCK_SKIP_PACKAGES: '1', PUCK_TEST_GIT_BASE: 'file:///srv/git/', PUCK_TEST_GITHUB_API: 'http://127.0.0.1:8787' }),
      createIndexEntry: async (req) => {
        const res = await call(server, 'POST', '/v1/instances', { token: session.accessToken, body: req });
        if (res.status !== 201) throw new Error(JSON.stringify(res.body));
        return { envId: String(res.body.envId) };
      },
      forgetIndexEntry: async (id) => void (await call(server, 'DELETE', `/v1/instances/${id}`, { token: session.accessToken })),
      control: (_r, op, args, opts) => ctl.cmd(op, args, opts),
      daemonBundle: () => ({ source: bundle.toString('utf8'), sha: createHash('sha256').update(bundle).digest('hex') }),
      onStage: () => undefined,
      log: { info: () => undefined },
    };
    const spec: StartSpec = { pin: { kind: 'tag', name: (await repo.refs()).defaultTag as string }, definition: 'example', runnerId: runner.id, secrets: {} };
    const plan = await preflight(spec, deps);
    expect(plan.pin).toEqual({ kind: 'tag', name: 'v1.0.0', sha: V1 });
    pin = plan.pin;
    envId = await create(plan, spec, deps, () => undefined);
    ctl.close();

    // The stand-in for GitHub's pull request API (git itself goes to the bare repository).
    await copyIn(`puck-${envId}`, FAKE_GITHUB, '/srv/fake-github.js');
    await must(['exec', '-d', `puck-${envId}`, 'node', '/srv/fake-github.js']);

    client = attach(cursor, seen);
    const snap = await ready(client);
    expect(snap.instance.pin).toEqual(pin);
    expect(snap.capacity.agents.implementer).toEqual({ running: 0, max: 2 });
    // Claude Code's sign-in reached the environment, for the puck user only.
    const creds = await client.cmd('credentials.get', {} as never);
    expect(creds.harness).toEqual([{ id: 'claude-code', content: CLAUDE_CREDENTIAL }]);
    const owner = await exec(`puck-${envId}`, ['stat', '-c', '%U %a', '/puck/home/.claude/.credentials.json']);
    expect(owner.stdout.trim()).toBe('puck 600');
  });

  it('3. the orchestrator creates two items for implementer; both run at once and reach review with diff stats', async () => {
    const orchestrator = (await snapshot(client)).orchestratorSessionId as string;
    const sent = await client.cmd('chat.send', {
      sessionId: orchestrator,
      text: [
        'Create two items: add a Usage section to the README, and fix any typo you find in docs/. Assign both to implementer.',
        tool('backlog_create', {
          title: 'Add a Usage section to the README',
          body: work(`printf '\\n## Usage\\n\\nnpm start\\n' >> README.md && git add README.md`, 'Add a Usage section', 3000),
          agent: 'implementer',
        }),
        tool('backlog_create', {
          title: 'Fix typos in docs',
          body: work(`mkdir -p docs && printf 'Setup\\n' > docs/setup.md && git add docs`, 'Fix a typo in docs', 3000),
          agent: 'implementer',
        }),
        'Two items queued.',
      ].join('\n'),
    });
    await waitFor('the orchestrator turn', async () => seen.some((e) => e.ev.kind === 'turn.end' && e.ev.turnId === sent.turnId), 60_000);

    const done = await until(client, 'both items in review', (s) => s.items.length === 2 && s.items.every((i) => i.status === 'review'));
    expect(peakRunning(seen)).toBe(2);
    const byNumber = (n: number): WorkItem => done.items.find((i) => i.number === n) as WorkItem;
    expect(byNumber(1).branch).toBe('puck/W-1-add-a-usage-section-to-the-readme');
    expect(byNumber(1).result?.diffStat).toMatchObject({ files: 1, insertions: 4, deletions: 0 });
    expect(byNumber(2).result?.diffStat).toMatchObject({ files: 1, insertions: 1, deletions: 0 });
    expect(byNumber(2).result?.commits.map((c) => c.subject)).toEqual(['Fix a typo in docs']);
  });

  it('4. publishes one from work detail: a draft pull request from its puck/W-1 branch', async () => {
    // The runner supplies the environment's installation token from the Puck server.
    await until(client, 'the GitHub grant', (s) => s.github.state === 'ok', 60_000);
    const item = (await snapshot(client)).items.find((i) => i.number === 1) as WorkItem;
    const published = await client.cmd('item.publish', { itemId: item.id });
    expect(published.prUrl).toBe('https://github.com/octo/app/pull/1');

    const container = `puck-${envId}`;
    const heads = await exec(container, ['git', '-C', '/srv/git/octo/app.git', 'for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    expect(heads.stdout.split('\n').filter(Boolean).sort()).toEqual(['main', 'puck/W-1-add-a-usage-section-to-the-readme']);
    const log = (await exec(container, ['cat', '/srv/github.log'])).stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const created = log.find((r) => r.method === 'POST' && r.url === '/repos/octo/app/pulls');
    expect(created?.body).toMatchObject({ head: 'puck/W-1-add-a-usage-section-to-the-readme', base: 'main', draft: true });
    expect(created?.auth).toMatch(/^Bearer ghs_/);
    const after = (await snapshot(client)).items.find((i) => i.number === 1) as WorkItem;
    expect(after.pr).toMatchObject({ number: 1, draft: true });
  });

  it('5. an item that finishes while Puck is closed is in review on reopen, with the notice and the reaction', async () => {
    const item = await client.cmd('item.create', {
      title: 'Add a changelog',
      body: work(`printf '# Changelog\\n' > CHANGELOG.md && git add CHANGELOG.md`, 'Add a changelog', 4000),
      agent: 'implementer',
    });
    await until(client, 'the item running', (s) => s.items.find((i) => i.id === item.id)?.status === 'running', 60_000);

    // Quit: the app's connection goes; the environment keeps working.
    client.stop();
    const at = cursor.seq as number;
    // With no client attached, read the daemon's own backlog store until the item reached review.
    await waitFor('the item to reach review on its own', async () => {
      const r = await exec(`puck-${envId}`, ['node', '-p', `require('/puck/state/items.json').items['${item.id}'].status`]);
      return r.stdout.trim() === 'review';
    }, 60_000);

    // Reopen: everything that happened meanwhile replays from the cursor.
    const replayed: { seq: number; ev: DaemonEvent }[] = [];
    client = attach(cursor, replayed);
    const snap = await until(client, 'the item in review', (s) => s.items.find((i) => i.id === item.id)?.status === 'review');
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.every((e) => e.seq > at)).toBe(true);
    expect(replayed.some((e) => e.ev.kind === 'item.upsert' && e.ev.item.id === item.id && e.ev.item.status === 'review')).toBe(true);

    // The orchestrator's transcript holds the review notice, and it woke on that notice and answered it.
    const reacted = (entries: TranscriptEntry[]): boolean => {
      const noticeAt = entries.findIndex(
        (e) => e.kind === 'notice' && e.notices.some((n) => n.kind === 'item.review' && n.text.includes(`W-${item.number}`)),
      );
      return noticeAt >= 0 && entries.slice(noticeAt + 1).some((e) => e.kind === 'turn' && e.events.some((ev) => ev.kind === 'text-delta'));
    };
    await waitFor('the notice and the orchestrator reaction', async () => {
      const history = await client.cmd('session.history', { sessionId: snap.orchestratorSessionId as string, limit: 200 });
      return reacted(history.entries);
    }, 60_000);
    seen.push(...replayed);
  });

  it('6. a new tag changing maxParallel is offered as an update, and applying it is hot and interrupts nothing', async () => {
    // A long-running item, so the update lands while work is in flight.
    const running = await client.cmd('item.create', {
      title: 'Add a license',
      body: work(`printf 'MIT\\n' > LICENSE && git add LICENSE`, 'Add a license', 6000),
      agent: 'implementer',
    });
    await until(client, 'the item running', (s) => s.items.find((i) => i.id === running.id)?.status === 'running', 60_000);

    config.tag('v1.1.0', V2, release(3));
    let current: Pin = pin;
    const deps: UpdateDeps = {
      pin: () => current,
      definition: () => 'example',
      check: (p) => repo.checkUpdate(p),
      resolve,
      apply: async (_envId, def) => void (await client.cmd('definition.apply', { definition: def, pin: def.source.pin })),
      rebuild: async () => {
        throw new Error('a maxParallel change must not rebuild');
      },
      applied: (_envId, def) => (current = def.source.pin),
    };
    const update = await checkUpdate(envId, deps);
    expect(update?.pin).toEqual({ kind: 'tag', name: 'v1.1.0', sha: V2 });
    expect(update?.changes.rebuild).toEqual([]);
    expect(update?.changes.reprovision).toEqual([]);
    expect(update?.changes.hot.length).toBeGreaterThan(0);

    const tail: { seq: number; ev: DaemonEvent }[] = [];
    const recorder = attach({ seq: cursor.seq }, tail);
    await waitFor('the recorder attached', async () => recorder.attachState === 'attached', 60_000);
    expect(await applyUpdate(envId, update?.pin as Pin, deps)).toBe('hot');
    expect(current).toEqual({ kind: 'tag', name: 'v1.1.0', sha: V2 });

    const snap = await until(client, 'the new capacity', (s) => s.capacity.agents.implementer?.max === 3, 30_000);
    expect(snap.instance.pin).toEqual({ kind: 'tag', name: 'v1.1.0', sha: V2 });
    expect(snap.items.find((i) => i.id === running.id)?.status).toBe('running');
    const finished = await until(client, 'the running item in review', (s) => s.items.find((i) => i.id === running.id)?.status === 'review');
    const item = finished.items.find((i) => i.id === running.id) as WorkItem;
    expect(item.attempts).toBe(1);
    expect(item.result?.commits.map((c) => c.subject)).toEqual(['Add a license']);
    // Applied in place: no session was interrupted and the environment never reprovisioned.
    const applied = tail.find((e) => e.ev.kind === 'instance.definition' && e.ev.pin.name === 'v1.1.0')?.ev;
    expect(applied).toMatchObject({ classes: ['hot'] });
    expect(tail.some((e) => e.ev.kind === 'session.upsert' && e.ev.session.status === 'interrupted')).toBe(false);
    expect(tail.some((e) => e.ev.kind === 'instance.status' && e.ev.status !== 'ready')).toBe(false);
    recorder.stop();
  });
});
