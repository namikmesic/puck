import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent, DaemonFrame, Snapshot, WorkItem } from '../../src/harness/daemon-protocol';
import type { TranscriptEntry } from '../../src/harness/transcript';
import { expectedPackages } from '../../src/harness/provisioning';
import { harnessDescriptors } from '../../src/harness/providers';
import { Daemon } from '../../src/daemon/daemon';
import type { AdapterContext, AdapterRequest, HarnessAdapter } from '../../src/daemon/harness/types';
import { createLogger } from '../../src/daemon/log';
import { continuePrompt, workerPrompt } from '../../src/daemon/prompts';
import { defined, exampleDefinition, fakeRunner, tempRoot, type RecordedCommand } from './daemon-fakes';

// Orchestration end to end, in process: real stores, socket and turn loop
// under a temporary root, a fake command runner standing in for git, and a
// scripted harness. Worker turns are scripted per call; the orchestrator
// echoes.

const ENV_ID = 'env_01J0000000000000000000000A';
const BASE = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);
const installed = expectedPackages(harnessDescriptors)
  .map((p) => `${p.name} ${p.version}`)
  .join('\n');

type Step = (req: AdapterRequest, ctx: AdapterContext) => Promise<void> | void;

let root: ReturnType<typeof tempRoot>;
let daemon: Daemon;
let sockets: net.Socket[];
let calls: RecordedCommand[];
let workerCalls: AdapterRequest[];
let orchestratorCalls: AdapterRequest[];
let workerSteps: Step[];
let commits: string;
let onGit: ((argv: string[]) => Promise<void>) | null;
let trace: string[];

const end = (ctx: AdapterContext): void => ctx.emit({ kind: 'turn-end', stats: { inputTokens: 1, outputTokens: 1, durationMs: 1 } });
const say = (text: string): Step => (req, ctx) => {
  ctx.reportSession(req.resumeId ?? `worker-${req.sessionId}`);
  ctx.emit({ kind: 'text-delta', text });
  end(ctx);
};

const adapter: HarnessAdapter = {
  id: 'claude-code',
  run: async (req, ctx) => {
    if (req.tools === 'orchestrator') {
      orchestratorCalls.push(req);
      ctx.reportSession(req.resumeId ?? 'orch-1');
      ctx.emit({ kind: 'text-delta', text: 'Noted.' });
      end(ctx);
      return;
    }
    workerCalls.push(req);
    trace.push('worker');
    const step = workerSteps.shift() ?? say('Done.');
    await step(req, ctx);
  },
};

/** Auto-wake off: these tests deliver notices through user messages, never through the 3 s window. */
const quiet = (over: Record<string, unknown> = {}) =>
  exampleDefinition({ orchestrator: { agent: 'lead', autoWake: false, maxAutoTurnsPerHour: 30 }, ...over });

function deliver(definition = quiet()): void {
  fs.mkdirSync(root.paths.inbox, { recursive: true });
  fs.writeFileSync(
    path.join(root.paths.inbox, 'instance.json'),
    JSON.stringify({ envId: ENV_ID, name: 'Example', pin: { kind: 'tag', name: 'v1', sha: 'abc1234' }, definition }),
  );
}

async function launch(): Promise<void> {
  const fake = fakeRunner((argv) => {
    if (argv[0] === 'id' || argv[0] === 'getent') return { code: 1 };
    if (argv.join(' ') === 'git config --global user.name Broken Name') return { code: 1, stderr: 'fatal: could not lock config file' };
    if (argv[0] === 'sh' && argv[1] === '-lc' && argv[2].includes('echo "')) return { stdout: installed };
    if (argv[0] !== 'git') return undefined;
    const i = argv.indexOf('-C');
    const sub = i >= 0 ? argv[i + 2] : argv[1];
    const rest = argv.slice(i + 3);
    if (sub === 'rev-parse' && rest.includes('origin/HEAD')) return { stdout: 'origin/main\n' };
    if (sub === 'rev-parse' && rest[0] === '--abbrev-ref') return { code: 128, stderr: 'not a git repository' };
    if (sub === 'rev-parse' && rest.includes('--quiet')) return { code: 1 };
    if (sub === 'rev-parse' && rest.some((a) => a.startsWith('refs/remotes/origin/'))) return { stdout: `${BASE}\n` };
    if (sub === 'rev-parse') return { stdout: `${HEAD}\n` };
    if (sub === 'log') return { stdout: commits };
    if (sub === 'diff' && rest.includes('--shortstat')) return { stdout: commits ? ' 1 file changed, 2 insertions(+)\n' : '' };
    if (sub === 'diff') return { stdout: commits ? ' a.txt | 2 ++\n' : '' };
    return undefined;
  });
  calls = fake.calls;
  const run: typeof fake.run = async (argv, opts) => {
    if (argv.join(' ').includes('user.name Someone Else')) trace.push('provision');
    if (onGit) await onGit(argv);
    return fake.run(argv, opts);
  };
  daemon = new Daemon({
    paths: root.paths,
    log: createLogger({ dir: root.paths.logs }),
    identity: { daemonVersion: '0.0.1+test', protocolVersion: 1, build: 'b'.repeat(64) },
    env: {},
    privileged: false,
    exit: vi.fn(),
    run,
    shutdownGraceMs: 2_000,
    adapters: { 'claude-code': adapter, codex: { ...adapter, id: 'codex' } },
  });
  await daemon.start();
}

function client() {
  const socket = net.connect(root.paths.socket);
  sockets.push(socket);
  const frames: DaemonFrame[] = [];
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (d: string) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buf.slice(0, nl)) as DaemonFrame);
      buf = buf.slice(nl + 1);
    }
  });
  const send = (frame: unknown) => socket.write(JSON.stringify(frame) + '\n');
  send({ t: 'hello', protocol: 1, client: { app: 'test', build: 'x' }, since: null });
  let n = 0;
  async function raw(op: string, args: unknown = {}) {
    const id = `c${++n}`;
    send({ t: 'cmd', id, op, args });
    let res: Extract<DaemonFrame, { t: 'res' }> | undefined;
    await vi.waitFor(
      () => {
        res = frames.find((f): f is Extract<DaemonFrame, { t: 'res' }> => f.t === 'res' && f.id === id);
        expect(res).toBeDefined();
      },
      { timeout: 3000, interval: 5 },
    );
    return defined(res);
  }
  async function cmd<T = unknown>(op: string, args: unknown = {}): Promise<T> {
    const res = await raw(op, args);
    if (!res.ok) throw new Error(`${op}: ${res.error.code}: ${res.error.message}`);
    return res.result as T;
  }
  const events = (): DaemonEvent[] => frames.flatMap((f) => (f.t === 'event' ? [f.ev] : []));
  /** Several commands in one write, so the daemon accepts them in one turn. */
  function burst(list: { op: string; args?: unknown }[]): Promise<Array<Extract<DaemonFrame, { t: 'res' }>>> {
    const ids = list.map(() => `c${++n}`);
    socket.write(list.map((item, i) => JSON.stringify({ t: 'cmd', id: ids[i], op: item.op, args: item.args ?? {} }) + '\n').join(''));
    return vi.waitFor(
      () => {
        const found = ids.map((id) => frames.find((f): f is Extract<DaemonFrame, { t: 'res' }> => f.t === 'res' && f.id === id));
        expect(found.every(Boolean)).toBe(true);
        return found as Array<Extract<DaemonFrame, { t: 'res' }>>;
      },
      { timeout: 3000, interval: 5 },
    );
  }
  return { cmd, raw, events, burst };
}

async function item(c: ReturnType<typeof client>, number: number): Promise<WorkItem> {
  const snap = await c.cmd<Snapshot>('snapshot.get');
  return defined(snap.items.find((i) => i.number === number));
}

async function until(c: ReturnType<typeof client>, number: number, status: WorkItem['status']): Promise<WorkItem> {
  let found: WorkItem | undefined;
  await vi.waitFor(
    async () => {
      found = await item(c, number);
      expect(found.status).toBe(status);
    },
    { timeout: 3000, interval: 10 },
  );
  return defined(found);
}

async function history(c: ReturnType<typeof client>, sessionId: string): Promise<TranscriptEntry[]> {
  return (await c.cmd<{ entries: TranscriptEntry[] }>('session.history', { sessionId })).entries;
}

function notices(entries: TranscriptEntry[]) {
  return entries.flatMap((e) => (e.kind === 'notice' ? e.notices : []));
}

beforeEach(async () => {
  root = tempRoot('pd-work-');
  sockets = [];
  workerCalls = [];
  orchestratorCalls = [];
  workerSteps = [];
  commits = `${HEAD}\tAdd a.txt\n`;
  onGit = null;
  trace = [];
  deliver();
  await launch();
});
afterEach(async () => {
  await daemon.shutdown();
  for (const s of sockets) s.destroy();
  await new Promise((r) => setTimeout(r, 10));
  root.cleanup();
});

describe('work items through the daemon', () => {
  it('dispatches into a worktree and a worker session, captures the result, and moves to review', async () => {
    const c = client();
    const created = await c.cmd<WorkItem>('item.create', { title: 'Fix login redirect', body: 'Make it work.', agent: 'implementer' });
    expect(created).toMatchObject({ number: 1, status: 'queued', createdBy: 'user' });
    const done = await until(c, 1, 'review');
    const worktree = path.join(root.paths.workspace, '.puck', 'worktrees', 'W-1');
    expect(done).toMatchObject({
      attempts: 1,
      repo: 'app',
      branch: 'puck/W-1-fix-login-redirect',
      worktree,
      base: { branch: 'main', sha: BASE },
      result: {
        summary: 'Done.',
        commits: [{ sha: HEAD, subject: 'Add a.txt' }],
        diffStat: { files: 1, insertions: 2, deletions: 0, text: ' a.txt | 2 ++' },
        uncommitted: [],
        interrupted: false,
      },
    });

    // The mirror is fetched by root with hooks off; everything in /workspace runs as puck (here: no uid, unprivileged test).
    const git = calls.filter((x) => x.argv[0] === 'git').map((x) => x.argv.join(' '));
    expect(git).toContain(`git -c core.hooksPath=/dev/null -C ${path.join(root.paths.mirrors, 'app.git')} fetch --prune origin`);
    expect(git).toContain(`git -C ${path.join(root.paths.workspace, 'app')} worktree add -b puck/W-1-fix-login-redirect ${worktree} ${BASE}`);

    // The worker ran in the worktree, without tools, with its agent and assignment instructions.
    const [first] = workerCalls;
    expect(first).toMatchObject({ cwd: worktree, tools: null, resumeId: null });
    expect(first.agent.instructions).toBe('Implement.\n\nStay in scope.');
    expect(first.prompt).toBe(
      workerPrompt({
        number: 1,
        title: 'Fix login redirect',
        body: 'Make it work.',
        github: 'octo/app',
        cwd: worktree,
        branch: 'puck/W-1-fix-login-redirect',
        base: { branch: 'main', sha: BASE },
      }),
    );
    expect(first.prompt).toContain(`based on main at ${BASE.slice(0, 7)}.`);

    // The orchestrator hears about it with its next turn.
    await c.cmd('chat.send', { text: 'status?' });
    await vi.waitFor(() => expect(orchestratorCalls).toHaveLength(1));
    expect(orchestratorCalls[0].prompt).toMatch(
      /^\[Puck\] Updates since your last turn:\n- The user created W-1 "Fix login redirect", assigned to implementer\.\n- W-1 "Fix login redirect" \(implementer\) is ready for review: 1 commit, 1 file changed \(\+2 −0\)\. Summary: Done\.\nDecide what to do next/,
    );
    // Its system prompt carries the orchestration preamble after its own instructions.
    expect(orchestratorCalls[0].agent.instructions).toMatch(/^Lead the work\.\n\nYou are the orchestrator of the Puck environment "example"\./);
    expect(orchestratorCalls[0].agent.instructions).toContain('- implementer: no description (up to 2 at once)');
  });

  it('runs at most maxParallel per agent and the next item when a slot frees', async () => {
    const c = client();
    const gate: Array<() => void> = [];
    workerSteps = [
      async (req, ctx) => {
        await new Promise<void>((r) => gate.push(r));
        await say('first')(req, ctx);
      },
      say('second'),
    ];
    await c.cmd('item.create', { title: 'One', agent: 'reviewer' });
    await c.cmd('item.create', { title: 'Two', agent: 'reviewer' });
    await until(c, 1, 'running');
    await new Promise((r) => setTimeout(r, 50));
    expect((await item(c, 2)).status).toBe('queued');
    const snap = await c.cmd<Snapshot>('snapshot.get');
    expect(snap.capacity.agents.reviewer).toEqual({ running: 1, max: 1 });
    defined(gate.shift())();
    await until(c, 1, 'review');
    await until(c, 2, 'review');
    expect(workerCalls.map((r) => r.agent.name)).toEqual(['reviewer', 'reviewer']);
  });

  it('requeues after an error, counting attempts, and fails at maxAttempts', async () => {
    const c = client();
    workerSteps = [
      (req, ctx) => {
        ctx.reportSession('w-1');
        ctx.emit({ kind: 'error', message: 'rate limited' });
        end(ctx);
      },
      (req, ctx) => {
        ctx.emit({ kind: 'error', message: 'still broken' });
        end(ctx);
      },
    ];
    await c.cmd('item.create', { title: 'Flaky', agent: 'implementer' });
    const failed = await until(c, 1, 'failed');
    expect(failed).toMatchObject({ attempts: 2, lastError: 'still broken' });
    // The second attempt continued the same session with the spec'd continue input.
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[1]).toMatchObject({ sessionId: workerCalls[0].sessionId, resumeId: 'w-1', prompt: continuePrompt(1, 'rate limited') });

    // Retry starts a fresh count in the same session.
    const retried = await c.cmd<WorkItem>('item.retry', { itemId: failed.id });
    expect(retried.status).toBe('queued');
    const back = await until(c, 1, 'review');
    expect(back.attempts).toBe(1);
    expect(workerCalls[2].prompt).toBe(continuePrompt(1, 'it failed: still broken'));

    await c.cmd('chat.send', { text: 'what happened?' });
    await vi.waitFor(() => expect(orchestratorCalls).toHaveLength(1));
    expect(orchestratorCalls[0].prompt).toContain('W-1 "Flaky" (implementer) was requeued after attempt 1 of 2: rate limited');
    expect(orchestratorCalls[0].prompt).toContain('W-1 "Flaky" (implementer) failed after 2 attempts: still broken');
  });

  it('a follow-up in review queues the item again and runs the text in the same session', async () => {
    const c = client();
    await c.cmd('item.create', { title: 'Docs', agent: 'implementer' });
    const reviewed = await until(c, 1, 'review');
    const sent = await c.cmd<{ queued: boolean }>('chat.send', { sessionId: reviewed.sessionId, text: 'Also fix the typo.' });
    expect(sent.queued).toBe(true);
    await until(c, 1, 'review');
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[1]).toMatchObject({ sessionId: reviewed.sessionId, prompt: 'Also fix the typo.', resumeId: `worker-${reviewed.sessionId}` });
    expect((await item(c, 1)).attempts).toBe(1);
    // A done item takes no follow-up.
    await c.cmd('item.accept', { itemId: reviewed.id });
    const refused = await c.raw('chat.send', { sessionId: reviewed.sessionId, text: 'more' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
  });

  it('interrupting a worker puts it in review marked interrupted; cancelling releases the slot', async () => {
    const c = client();
    workerSteps = [
      async (req, ctx) => {
        await new Promise<void>((r) => ctx.onInterrupt(r));
        end(ctx);
      },
      async (req, ctx) => {
        await new Promise<void>((r) => ctx.onInterrupt(r));
        end(ctx);
      },
    ];
    await c.cmd('item.create', { title: 'Long', agent: 'implementer' });
    const running = await until(c, 1, 'running');
    await vi.waitFor(() => expect(workerCalls).toHaveLength(1));
    await c.cmd('session.interrupt', { sessionId: running.sessionId });
    const reviewed = await until(c, 1, 'review');
    expect(reviewed.result?.interrupted).toBe(true);

    await c.cmd('item.create', { title: 'Cancel me', agent: 'implementer' });
    await until(c, 2, 'running');
    await vi.waitFor(() => expect(workerCalls).toHaveLength(2));
    const cancelled = await c.cmd<WorkItem>('item.cancel', { itemId: (await item(c, 2)).id });
    expect(cancelled.status).toBe('cancelled');
    await vi.waitFor(async () => expect((await c.cmd<Snapshot>('snapshot.get')).capacity.agents.implementer.running).toBe(0));
    expect((await item(c, 2)).status).toBe('cancelled');
    await c.cmd('item.delete', { itemId: cancelled.id });
    expect(calls.some((x) => x.argv.includes('worktree') && x.argv.includes('remove'))).toBe(true);
  });

  it('runs a follow-up that was queued during the turn after the user interrupts', async () => {
    const c = client();
    workerSteps = [
      async (req, ctx) => {
        await new Promise<void>((r) => ctx.onInterrupt(r));
        end(ctx);
      },
      say('Applied the follow-up.'),
    ];
    await c.cmd('item.create', { title: 'Long', agent: 'implementer' });
    const running = await until(c, 1, 'running');
    await vi.waitFor(() => expect(workerCalls).toHaveLength(1));
    const sent = await c.cmd<{ queued: boolean }>('chat.send', { sessionId: running.sessionId, text: 'Also handle the edge.' });
    expect(sent.queued).toBe(true);
    await c.cmd('session.interrupt', { sessionId: running.sessionId });
    const done = await until(c, 1, 'review');
    expect(done.attempts).toBe(1);
    expect(done.sessionId).toBe(running.sessionId);
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[1]).toMatchObject({ sessionId: running.sessionId, prompt: 'Also handle the edge.' });
  });

  it('holds publish across a follow-up so the pushed sha is the bundled head', async () => {
    const c = client();
    await c.cmd('item.create', { title: 'Publish me', agent: 'implementer' });
    const reviewed = await until(c, 1, 'review');
    await c.cmd('github.put', {
      grants: [{ owner: 'octo', installationId: 9, repos: ['octo/app'], token: 'ghs_octotoken', expiresAt: Date.now() + 60_000 }],
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return new Response('[]', { status: 200 });
      const body = init?.body ? (JSON.parse(String(init.body)) as { draft?: boolean }) : {};
      return new Response(JSON.stringify({ number: 7, html_url: 'https://github.com/octo/app/pull/7', draft: body.draft ?? true }), { status: 201 });
    });
    let releaseBundle!: () => void;
    const bundleGate = new Promise<void>((resolve) => {
      releaseBundle = resolve;
    });
    let bundleWaiting = false;
    onGit = async (argv) => {
      if (!argv.includes('bundle')) return;
      bundleWaiting = true;
      await bundleGate;
    };
    try {
      const publishing = c.cmd<{ prUrl: string }>('item.publish', { itemId: reviewed.id });
      await vi.waitFor(() => expect(bundleWaiting).toBe(true));
      let followDone = false;
      const follow = c.cmd<{ queued: boolean }>('chat.send', { sessionId: reviewed.sessionId, text: 'One more fix.' }).then((result) => {
        followDone = true;
        return result;
      });
      await new Promise((r) => setTimeout(r, 40));
      expect(followDone).toBe(false);
      expect(workerCalls).toHaveLength(1);
      expect((await item(c, 1)).status).toBe('review');
      releaseBundle();
      const published = await publishing;
      expect(published.prUrl).toBe('https://github.com/octo/app/pull/7');
      expect((await follow).queued).toBe(true);
      const again = await until(c, 1, 'review');
      expect(again.pr?.lastPushedSha).toBe(HEAD);
      expect(workerCalls).toHaveLength(2);
      expect(workerCalls[1].prompt).toBe('One more fix.');
    } finally {
      releaseBundle();
      onGit = null;
      fetchMock.mockRestore();
    }
  });

  it('does not restore an item deleted while its publish is waiting on GitHub', async () => {
    const c = client();
    await c.cmd('item.create', { title: 'Publish me', agent: 'implementer' });
    const reviewed = await until(c, 1, 'review');
    await c.cmd('item.accept', { itemId: reviewed.id });
    await c.cmd('github.put', {
      grants: [{ owner: 'octo', installationId: 9, repos: ['octo/app'], token: 'ghs_octotoken', expiresAt: Date.now() + 60_000 }],
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchWaiting = false;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      fetchWaiting = true;
      await fetchGate;
      const method = init?.method ?? 'GET';
      if (method === 'GET') return new Response('[]', { status: 200 });
      const body = init?.body ? (JSON.parse(String(init.body)) as { draft?: boolean }) : {};
      return new Response(JSON.stringify({ number: 7, html_url: 'https://github.com/octo/app/pull/7', draft: body.draft ?? true }), { status: 201 });
    });
    try {
      const publishing = c.cmd<{ prUrl: string }>('item.publish', { itemId: reviewed.id });
      await vi.waitFor(() => expect(fetchWaiting).toBe(true));
      let deleted = false;
      const deleting = c.cmd('item.delete', { itemId: reviewed.id }).then((result) => {
        deleted = true;
        return result;
      });
      await new Promise((r) => setTimeout(r, 40));
      expect(deleted).toBe(false);
      releaseFetch();
      await publishing;
      await deleting;
      expect((await c.cmd<Snapshot>('snapshot.get')).items.find((i) => i.id === reviewed.id)).toBeUndefined();
      const ev = c.events();
      const removedAt = ev.findIndex((e) => e.kind === 'item.removed' && e.itemId === reviewed.id);
      expect(removedAt).toBeGreaterThanOrEqual(0);
      expect(ev.slice(removedAt + 1).some((e) => e.kind === 'item.upsert' && e.item.id === reviewed.id)).toBe(false);
    } finally {
      releaseFetch();
      fetchMock.mockRestore();
    }
  });

  it('a second delete while the first still holds the item does not emit it again', async () => {
    const c = client();
    await c.cmd('item.create', { title: 'Gone', agent: 'implementer' });
    const reviewed = await until(c, 1, 'review');
    await c.cmd('item.accept', { itemId: reviewed.id });
    const results = await c.burst([
      { op: 'item.delete', args: { itemId: reviewed.id } },
      { op: 'item.delete', args: { itemId: reviewed.id } },
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(c.events().filter((e) => e.kind === 'item.removed' && e.itemId === reviewed.id)).toHaveLength(1);
    expect((await c.cmd<Snapshot>('snapshot.get')).items.find((i) => i.id === reviewed.id)).toBeUndefined();
  });
});

describe('tool notes', () => {
  it('stores cancel reasons and accept notes on the item and the escalate note on the question, never in the log', async () => {
    const reason = 'drop this approach entirely';
    const accept = 'shipped with the redirect fix';
    const escalate = `the user should pick the database ${'n'.repeat(2000)}`;
    const c = client();
    const tools = (daemon as unknown as { tools: Array<{ name: string; run(a: Record<string, unknown>): unknown }> }).tools;
    const tool = (name: string) => defined(tools.find((t) => t.name === name));
    let answer: Record<string, string> | null | undefined;
    workerSteps = [
      say('Done.'),
      async (req, ctx) => {
        answer = await ctx.askUser([{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: '' }] }]);
        end(ctx);
      },
    ];
    await c.cmd('item.create', { title: 'Accept me', agent: 'implementer' });
    const reviewed = await until(c, 1, 'review');
    await tool('work_accept').run({ item: 'W-1', note: accept });
    expect((await item(c, 1)).acceptNote).toBe(accept);
    expect(c.events()).toContainEqual(
      expect.objectContaining({ kind: 'item.upsert', item: expect.objectContaining({ id: reviewed.id, status: 'done', acceptNote: accept }) }),
    );

    await tool('backlog_create').run({ title: 'Later', body: 'not now' });
    await tool('backlog_cancel').run({ item: 'W-2', reason });
    expect((await item(c, 2)).cancelReason).toBe(reason);
    expect(c.events()).toContainEqual(
      expect.objectContaining({ kind: 'item.upsert', item: expect.objectContaining({ number: 2, status: 'cancelled', cancelReason: reason }) }),
    );

    await c.cmd('item.create', { title: 'Ask me', agent: 'implementer' });
    const waiting = await until(c, 3, 'needs-input');
    const sessionId = defined(waiting.sessionId);
    await tool('escalate_to_user').run({ item: 'W-3', note: escalate });
    const snap = await c.cmd<Snapshot>('snapshot.get');
    const ask = defined(snap.asks.find((a) => a.sessionId === sessionId));
    expect(ask.routedTo).toBe('user');
    expect(ask.questions[0]?.question).toBe('Which DB?');
    expect(ask.note).toBe(escalate);
    const streamed = c.events().filter((e) => e.kind === 'turn.event' && e.event.kind === 'ask' && e.event.note === escalate);
    expect(streamed).toHaveLength(1);
    const streamedAsk = streamed[0];
    expect(streamedAsk.kind === 'turn.event' && streamedAsk.event.kind === 'ask' ? streamedAsk.event.questions[0]?.question : '').toBe('Which DB?');
    const recorded = (await history(c, sessionId))
      .flatMap((entry) => (entry.kind === 'turn' ? entry.events : []))
      .find((event) => event.kind === 'ask');
    expect(recorded && recorded.kind === 'ask' ? recorded.questions[0]?.question : '').toBe('Which DB?');
    expect(recorded && recorded.kind === 'ask' ? recorded.note : '').toBe(escalate);
    await c.cmd('ask.answer', { sessionId, askId: waiting.pendingAsk?.askId, answers: { 'Which DB?': 'Postgres' } });
    await vi.waitFor(() => expect(answer).toEqual({ 'Which DB?': 'Postgres' }));

    const log = await c.cmd<{ text: string }>('logs.tail', { lines: 400 });
    expect(log.text).not.toContain(reason);
    expect(log.text).not.toContain(accept);
    expect(log.text).not.toContain(escalate);
  });
});

describe('worker questions', () => {
  it('routes a question to the orchestrator first, and escalates it when the orchestrator ignores it', async () => {
    const c = client();
    let answer: Record<string, string> | null | undefined;
    workerSteps = [
      async (req, ctx) => {
        answer = await ctx.askUser([{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }] }]);
        end(ctx);
      },
    ];
    await c.cmd('item.create', { title: 'Store', agent: 'implementer' });
    const waiting = await until(c, 1, 'needs-input');
    expect(waiting.pendingAsk).toMatchObject({ routedTo: 'orchestrator' });
    const snap = await c.cmd<Snapshot>('snapshot.get');
    expect(snap.asks).toEqual([expect.objectContaining({ sessionId: waiting.sessionId, routedTo: 'orchestrator' })]);
    expect(snap.capacity.agents.implementer.running).toBe(1);

    // The orchestrator's turn carries the question but answers nothing: the daemon hands it to the user.
    await c.cmd('chat.send', { text: 'hi' });
    await vi.waitFor(() => expect(orchestratorCalls).toHaveLength(1));
    expect(orchestratorCalls[0].prompt).toContain(
      'W-1 "Store" (implementer) asks: "Which DB?" Options: Postgres, SQLite. Answer with answer_worker or hand it to the user with escalate_to_user.',
    );
    await vi.waitFor(async () => expect((await item(c, 1)).pendingAsk?.routedTo).toBe('user'));
    expect(c.events()).toContainEqual({ kind: 'ask.routed', sessionId: waiting.sessionId, askId: waiting.pendingAsk?.askId, to: 'user' });

    await c.cmd('ask.answer', { sessionId: waiting.sessionId, askId: waiting.pendingAsk?.askId, answers: { 'Which DB?': 'SQLite' } });
    await until(c, 1, 'review');
    expect(answer).toEqual({ 'Which DB?': 'SQLite' });
  });
});

describe('orchestrator tools', () => {
  it('create, assign, read and answer through the in-process tools; publishing obeys the policy', async () => {
    await daemon.shutdown();
    root.cleanup();
    root = tempRoot('pd-work-');
    deliver(quiet({ policies: { publish: 'manual' } }));
    await launch();
    const c = client();
    const tools = (daemon as unknown as { tools: Array<{ name: string; run(a: Record<string, unknown>): unknown }> }).tools;
    const tool = (name: string) => defined(tools.find((t) => t.name === name));
    expect(tools.map((t) => t.name)).toEqual([
      'backlog_list',
      'backlog_get',
      'backlog_create',
      'backlog_update',
      'backlog_move',
      'backlog_assign',
      'backlog_cancel',
      'work_retry',
      'work_accept',
      'work_request_changes',
      'work_publish',
      'work_read',
      'answer_worker',
      'escalate_to_user',
      'agents_list',
      'environment_info',
    ]);
    const created = (await tool('backlog_create').run({ title: 'Plan', body: 'Write the plan.' })) as { item: string; status: string };
    expect(created).toMatchObject({ item: 'W-1', status: 'backlog' });
    expect((await item(c, 1)).createdBy).toBe('orchestrator');
    await tool('backlog_create').run({ title: 'First', body: '', position: { before: 'W-1' } });
    expect(((await tool('backlog_list').run({})) as { items: Array<{ item: string }> }).items.map((i) => i.item)).toEqual(['W-2', 'W-1']);
    expect(() => tool('backlog_assign').run({ item: 'W-1', agent: 'nobody' })).toThrow(/not assigned in this environment/);
    await tool('backlog_assign').run({ item: 'W-1', agent: 'implementer' });
    await until(c, 1, 'review');
    expect(tool('work_read').run({ item: 'W-1' })).toMatch(/\[system\] You are working on work item W-1: Plan[\s\S]*\[assistant\] Done\./);
    await expect(Promise.resolve().then(() => tool('work_publish').run({ item: 'W-1' }))).rejects.toThrow(/Publishing is manual/);
    expect(tool('agents_list').run({})).toEqual({
      agents: [
        { name: 'implementer', description: '', harness: 'claude-code', model: 'auto', maxParallel: 2, running: 0 },
        { name: 'reviewer', description: '', harness: 'codex', model: 'auto', maxParallel: 1, running: 0 },
      ],
    });
    expect(tool('environment_info').run({})).toMatchObject({ name: 'Example', pin: { name: 'v1' }, repos: [{ dir: 'app', github: 'octo/app' }] });
    // User changes reach the orchestrator; its own do not come back as notices.
    const pending = (daemon as unknown as { orchestrator: { pending(): Array<{ kind: string }> } }).orchestrator.pending();
    expect(pending.map((n) => n.kind)).toEqual(['item.review']);
  });
});

describe('restart', () => {
  it('requeues a running item without counting an attempt and resumes its existing session', async () => {
    const c = client();
    workerSteps = [
      async (req, ctx) => {
        ctx.reportSession('worker-conversation-1');
        ctx.emit({ kind: 'text-delta', text: 'working…' });
        await new Promise<void>((r) => ctx.onInterrupt(r));
        end(ctx);
      },
    ];
    await c.cmd('item.create', { title: 'Big job', agent: 'implementer' });
    const running = await until(c, 1, 'running');
    await vi.waitFor(() => expect(workerCalls).toHaveLength(1));
    await daemon.shutdown();

    // A new daemon on the same state.
    workerSteps = [say('Finished after the restart.')];
    await launch();
    const d = client();
    const after = await until(d, 1, 'review');
    expect(after.attempts).toBe(1);
    expect(after.sessionId).toBe(running.sessionId);
    expect(workerCalls).toHaveLength(2);
    expect(workerCalls[1]).toMatchObject({
      sessionId: running.sessionId,
      resumeId: 'worker-conversation-1',
      prompt: continuePrompt(1, 'the environment restarted'),
    });
    const snap = await d.cmd<Snapshot>('snapshot.get');
    expect(snap.sessions.filter((s) => s.kind === 'worker')).toHaveLength(1);

    await d.cmd('chat.send', { text: 'what happened?' });
    await vi.waitFor(() => expect(orchestratorCalls.length).toBeGreaterThanOrEqual(1));
    const orch = defined(snap.orchestratorSessionId);
    await vi.waitFor(async () => expect(notices(await history(d, orch)).map((n) => n.kind)).toContain('environment.restarted'));
    const restarted = defined(notices(await history(d, orch)).find((n) => n.kind === 'environment.restarted'));
    expect(restarted.text).toContain('requeued without counting an attempt, each continuing its existing worker session: W-1 "Big job"');
  });
});

describe('definition.apply', () => {
  it('applies hot changes at once, refuses rebuilds, and reprovisions in place', async () => {
    const c = client();
    const pin = { kind: 'tag', name: 'v2', sha: 'def5678' };
    const hot = quiet({
      agents: [
        { agent: 'implementer', maxParallel: 4, instructions: 'Stay in scope.' },
        { agent: 'reviewer', maxParallel: 1 },
      ],
    });
    expect(await c.cmd('definition.apply', { definition: hot, pin })).toEqual({ classes: ['hot'] });
    expect((await c.cmd<Snapshot>('snapshot.get')).capacity.agents.implementer.max).toBe(4);
    expect(c.events()).toContainEqual({ kind: 'instance.definition', sha: 'def5678', pin, classes: ['hot'] });

    const rebuild = await c.raw('definition.apply', { definition: { ...hot, image: 'node:24' }, pin });
    expect(rebuild).toMatchObject({ ok: false, error: { code: 'invalid-state', message: expect.stringContaining('image') } });

    const before = calls.length;
    const reprovision = { ...hot, git: { userName: 'Someone Else', userEmail: 'else@example.com' } };
    expect(await c.cmd('definition.apply', { definition: reprovision, pin: { ...pin, sha: 'fed9876' } })).toEqual({ classes: ['reprovision'] });
    await vi.waitFor(async () => {
      expect(calls.slice(before).some((x) => x.argv.join(' ') === 'git config --global user.name Someone Else')).toBe(true);
      expect((await c.cmd<Snapshot>('snapshot.get')).instance.status).toBe('ready');
    });
    const snap = await c.cmd<Snapshot>('snapshot.get');
    expect(snap.instance.sha).toBe('fed9876');
    const refused = await c.raw('definition.apply', { definition: { ...hot, name: 'other' }, pin });
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid-args' } });

    // A reprovision that fails leaves the environment degraded, still taking work and messages.
    const broken = { ...hot, git: { userName: 'Broken Name', userEmail: 'else@example.com' } };
    expect(await c.cmd('definition.apply', { definition: broken, pin: { ...pin, sha: 'bad0001' } })).toEqual({ classes: ['reprovision'] });
    await vi.waitFor(async () => expect((await c.cmd<Snapshot>('snapshot.get')).instance.status).toBe('degraded'));
    expect((await c.cmd<Snapshot>('snapshot.get')).instance).toMatchObject({ stage: 'configuring-git', error: expect.stringContaining('could not lock config file') });
    await c.cmd('chat.send', { text: 'still there?' });
    await vi.waitFor(() => expect(orchestratorCalls).toHaveLength(1));
    await c.cmd('item.create', { title: 'Keeps going', agent: 'implementer' });
    await until(c, 1, 'review');
  });

  it('waits for an in-flight prepare and starts the worker only after provisioning', async () => {
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    let prepareWaiting = false;
    onGit = async (argv) => {
      if (!argv.includes('worktree') || !argv.includes('add')) return;
      prepareWaiting = true;
      await prepareGate;
    };
    const c = client();
    try {
      const creating = c.cmd('item.create', { title: 'Overlap', agent: 'implementer' });
      await vi.waitFor(() => expect(prepareWaiting).toBe(true));
      expect(trace).not.toContain('worker');
      const pin = { kind: 'tag' as const, name: 'v2', sha: 'fed9876' };
      const reprovision = quiet({ git: { userName: 'Someone Else', userEmail: 'else@example.com' } });
      expect(await c.cmd('definition.apply', { definition: reprovision, pin })).toEqual({ classes: ['reprovision'] });
      await new Promise((r) => setTimeout(r, 40));
      expect(trace).not.toContain('provision');
      expect(trace).not.toContain('worker');
      releasePrepare();
      await creating;
      await vi.waitFor(() => expect(trace).toEqual(['provision', 'worker']));
      await until(c, 1, 'review');
    } finally {
      releasePrepare();
      onGit = null;
    }
  });
});

