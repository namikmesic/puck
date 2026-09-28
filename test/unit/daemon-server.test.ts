import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WIRE_LIMITS, type DaemonEvent, type DaemonFrame, type Snapshot } from '../../src/harness/daemon-protocol';
import { expectedPackages } from '../../src/harness/provisioning';
import { harnessDescriptors } from '../../src/harness/providers';
import { attach } from '../../src/daemon/attach';
import { Daemon } from '../../src/daemon/daemon';
import { EventLog } from '../../src/daemon/eventlog';
import type { HarnessAdapter } from '../../src/daemon/harness/types';
import { createLogger, nullLogger } from '../../src/daemon/log';
import { writeJsonAtomicSync } from '../../src/daemon/store/jsonfile';
import { DaemonServer } from '../../src/daemon/server';
import { defined, exampleDefinition, fakeRunner, tempRoot } from './daemon-fakes';

// The daemon end to end, in process: real socket, real stores and event
// log under a temporary root; fake commands (no users, git or npm) and a
// scripted harness.

const ENV_ID = 'env_01J0000000000000000000000A';
const installed = expectedPackages(harnessDescriptors)
  .map((p) => `${p.name} ${p.version}`)
  .join('\n');

let root: ReturnType<typeof tempRoot>;
let daemon: Daemon;
let exit: ReturnType<typeof vi.fn>;
let clients: net.Socket[];

const echo: HarnessAdapter = {
  id: 'claude-code',
  run: async (req, ctx) => {
    ctx.reportSession(req.resumeId ?? 'sess-1');
    for (const word of ['Echo: ', req.prompt]) ctx.emit({ kind: 'text-delta', text: word });
    ctx.emit({ kind: 'turn-end', stats: { inputTokens: 3, outputTokens: 4, durationMs: 1 } });
  },
};

function deliver(files: Record<string, unknown>): void {
  fs.mkdirSync(root.paths.inbox, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(root.paths.inbox, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
}

function launch(
  over: { adapters?: Record<string, HarnessAdapter>; shutdownGraceMs?: number; onCommand?: () => void; hold?: () => Promise<void> } = {},
): Promise<void> {
  const { run: recorded } = fakeRunner((argv) => {
    if (argv[0] === 'id' || argv[0] === 'getent') return { code: 1 };
    if (argv[0] === 'sh' && argv[1] === '-lc' && argv[2].includes('echo "')) return { stdout: installed };
    return undefined;
  });
  const run: typeof recorded = async (argv, opts) => {
    over.onCommand?.();
    await over.hold?.();
    return recorded(argv, opts);
  };
  exit = vi.fn();
  daemon = new Daemon({
    paths: root.paths,
    log: createLogger({ dir: root.paths.logs }),
    identity: { daemonVersion: '0.0.1+test', protocolVersion: 1, build: 'b'.repeat(64) },
    env: {},
    privileged: false,
    exit,
    run,
    shutdownGraceMs: over.shutdownGraceMs,
    adapters: over.adapters ?? { 'claude-code': echo, codex: { ...echo, id: 'codex' } },
  });
  return daemon.start();
}

async function boot(over: Parameters<typeof launch>[0] = {}): Promise<void> {
  await launch(over);
}

async function waitForExit(): Promise<void> {
  for (let i = 0; i < 50 && !exit.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 20));
}

/** A raw protocol client over the unix socket. */
function client() {
  const socket = net.connect(root.paths.socket);
  clients.push(socket);
  const frames: DaemonFrame[] = [];
  const waiters: Array<() => void> = [];
  let buf = '';
  let closed = false;
  socket.setEncoding('utf8');
  socket.on('data', (d: string) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buf.slice(0, nl)) as DaemonFrame);
      buf = buf.slice(nl + 1);
    }
    waiters.splice(0).forEach((w) => w());
  });
  socket.on('close', () => {
    closed = true;
    waiters.splice(0).forEach((w) => w());
  });
  const send = (frame: unknown) => socket.write(JSON.stringify(frame) + '\n');
  async function until<T extends DaemonFrame>(pred: (f: DaemonFrame) => f is T, timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = frames.find(pred);
      if (hit) return hit;
      if (closed || Date.now() > deadline) throw new Error(`no matching frame; got ${JSON.stringify(frames).slice(0, 800)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  let n = 0;
  async function cmd(op: string, args: unknown = {}) {
    const id = `c${++n}`;
    send({ t: 'cmd', id, op, args });
    return until((f): f is Extract<DaemonFrame, { t: 'res' }> => f.t === 'res' && f.id === id);
  }
  const hello = (since: number | null, protocol = 1) => send({ t: 'hello', protocol, client: { app: 'test', build: 'x' }, since });
  const events = () => frames.filter((f): f is Extract<DaemonFrame, { t: 'event' }> => f.t === 'event');
  return { socket, frames, send, until, cmd, hello, events, isClosed: () => closed };
}

const isWelcome = (f: DaemonFrame): f is Extract<DaemonFrame, { t: 'welcome' }> => f.t === 'welcome';

beforeEach(() => {
  root = tempRoot('pd-');
  clients = [];
});
afterEach(async () => {
  for (const c of clients) c.destroy();
  await new Promise((r) => setTimeout(r, 10));
  root.cleanup();
});

describe('puckd server (in process)', () => {
  beforeEach(async () => {
    deliver({
      'instance.json': { envId: ENV_ID, name: 'Example', pin: { kind: 'tag', name: 'v1', sha: 'abc1234' }, definition: exampleDefinition() },
      'github.json': { grants: [{ owner: 'octo', installationId: 42, repos: ['octo/app'], token: 'ghs_abcdefghijk', expiresAt: 4102444800000 }] },
    });
    await boot();
  });

  it('boots to ready, with a root-only socket and an orchestrator session', async () => {
    expect(fs.statSync(root.paths.socket).mode & 0o777).toBe(0o600);
    expect(fs.statSync(root.paths.state).mode & 0o777).toBe(0o700);
    const c = client();
    c.hello(null);
    const welcome = await c.until(isWelcome);
    expect(welcome).toMatchObject({ protocol: 1, envId: ENV_ID, replay: 'resync', daemon: { version: '0.0.1+test' } });
    const snap = (await c.cmd('snapshot.get')) as { ok: true; result: Snapshot };
    expect(snap.result.instance).toMatchObject({ status: 'ready', pin: { name: 'v1' }, sha: 'abc1234' });
    expect(snap.result.github).toEqual({ state: 'ok', expiresAt: 4102444800000 });
    expect(snap.result.sessions).toHaveLength(1);
    expect(snap.result.sessions[0]).toMatchObject({ kind: 'orchestrator', agent: 'lead', cwd: root.paths.workspace, status: 'idle' });
    expect(snap.result.orchestratorSessionId).toBe(snap.result.sessions[0].id);
    expect(snap.result.capacity).toEqual({
      agents: { implementer: { running: 0, max: 2 }, reviewer: { running: 0, max: 1 } },
      workers: { running: 0, max: 3 },
      paused: false,
    });
    expect(snap.result.head).toBe(welcome.head);
  });

  it('streams a turn, persists it, and replays exactly the missed events after a reattach', async () => {
    const a = client();
    a.hello(0);
    const welcome = await a.until(isWelcome);
    expect(welcome.replay).toBe('events');
    const sent = await a.cmd('chat.send', { text: 'hello there' });
    expect(sent).toMatchObject({ ok: true, result: { queued: false } });
    await a.until((f): f is Extract<DaemonFrame, { t: 'event' }> => f.t === 'event' && f.ev.kind === 'turn.end');
    const seen = a.events();
    const seqs = seen.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    const kinds = seen.map((e) => e.ev.kind).filter((k) => k.startsWith('turn.'));
    expect(kinds).toEqual(['turn.user', 'turn.start', 'turn.event', 'turn.event', 'turn.end']);
    const deltas = seen
      .map((e) => e.ev)
      .filter((ev): ev is Extract<DaemonEvent, { kind: 'turn.event' }> => ev.kind === 'turn.event' && ev.event.kind === 'text-delta');
    expect(deltas.map((d) => (d.event as { text: string }).text).join('')).toBe('Echo: hello there');

    // Reattach from the middle of the turn: only later events come back.
    const turnStart = defined(seen.find((e) => e.ev.kind === 'turn.start'));
    const b = client();
    b.hello(turnStart.seq);
    expect((await b.until(isWelcome)).replay).toBe('events');
    await b.until((f): f is Extract<DaemonFrame, { t: 'event' }> => f.t === 'event' && f.ev.kind === 'turn.end');
    expect(b.events().map((e) => e.seq)).toEqual(seqs.filter((s) => s > turnStart.seq));

    const sessionId = (turnStart.ev as { sessionId: string }).sessionId;
    const history = await b.cmd('session.history', { sessionId });
    expect(history).toMatchObject({ ok: true, result: { total: 2, hasMore: false } });
    const entries = (history as { result: { entries: Array<{ kind: string }> } }).result.entries;
    expect(entries.map((e) => e.kind)).toEqual(['user', 'turn']);
    const file = JSON.parse(fs.readFileSync(path.join(root.paths.transcripts, `${sessionId}.json`), 'utf8'));
    expect(file).toMatchObject({ v: 2, sessionId, turns: 1, lastTurnTokens: 7 });
  });

  it('answers pings, rejects bad commands by id, and keeps the connection', async () => {
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    c.send({ t: 'ping', at: 1 });
    await c.until((f): f is Extract<DaemonFrame, { t: 'pong' }> => f.t === 'pong');
    expect(await c.cmd('no.such.op')).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(await c.cmd('chat.send', { text: '' })).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(await c.cmd('item.create', { title: 'Later', agent: 'nobody' })).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(await c.cmd('item.accept', { itemId: 'itm_01J0000000000000000000000A' })).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(await c.cmd('session.interrupt', { sessionId: 'ses_01J0000000000000000000000A' })).toMatchObject({
      ok: false,
      error: { code: 'not-found' },
    });
    expect(await c.cmd('logs.tail', { lines: 5 })).toMatchObject({ ok: true });
    expect(c.isClosed()).toBe(false);
  });

  it('refuses an unsupported protocol and a first frame that is not hello', async () => {
    const a = client();
    a.hello(null, 99);
    const err = await a.until((f): f is Extract<DaemonFrame, { t: 'error' }> => f.t === 'error');
    expect(err.code).toBe('protocol-mismatch');
    const b = client();
    b.send({ t: 'ping', at: 1 });
    expect((await b.until((f): f is Extract<DaemonFrame, { t: 'error' }> => f.t === 'error')).code).toBe('bad-frame');
  });

  it('takes credentials and secrets from the app and hands harness files back', async () => {
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    expect(await c.cmd('secrets.put', { values: { NPM_TOKEN: 'x' } })).toMatchObject({ ok: true });
    expect(await c.cmd('secrets.put', { values: { PUCK_X: 'x' } })).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    // Only installation token grants are accepted; a bare token or a user-token pair is not.
    expect(await c.cmd('github.put', { token: 'ghp_abcdefghij' })).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(await c.cmd('github.put', { grants: [{ owner: 'octo', token: 'ghp_abcdefghij' }] })).toMatchObject({
      ok: false,
      error: { code: 'invalid-args' },
    });
    const pair = { accessToken: 'ghu_rotatedtoken', refreshToken: 'ghr_rotatedtoken', expiresAt: 4102444800000 };
    expect(await c.cmd('github.put', { grants: [pair] })).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    const grants = [{ owner: 'octo', installationId: 42, repos: ['octo/app'], token: 'ghs_rotatedtoken', expiresAt: 4102444900000 }];
    expect(await c.cmd('github.put', { grants })).toMatchObject({ ok: true });
    const auth = await c.until(
      (f): f is Extract<DaemonFrame, { t: 'event' }> => f.t === 'event' && f.ev.kind === 'github.auth' && f.ev.expiresAt === 4102444900000,
    );
    expect(auth.ev).toMatchObject({ state: 'ok' });
    expect(await c.cmd('credentials.put', { harness: [{ id: 'claude-code', content: 'nope' }] })).toMatchObject({
      ok: false,
      error: { code: 'invalid-args' },
    });
  });

  it('attach pipes a client through to the socket', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = '';
    stdout.on('data', (d: Buffer) => (out += d.toString()));
    const done = attach(root.paths.socket, stdin, stdout);
    stdin.write(JSON.stringify({ t: 'hello', protocol: 1, client: { app: 't', build: 'x' }, since: null }) + '\n');
    for (let i = 0; i < 50 && !out.includes('welcome'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(out).toContain('"t":"welcome"');
    stdin.end();
    expect(await done).toBe(0);
  });

  it('upgrades: persists, swaps in the staged bundle, and exits 75', async () => {
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    expect(await c.cmd('daemon.upgrade', { mode: 'now' })).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
    fs.mkdirSync(root.paths.opt, { recursive: true });
    fs.writeFileSync(root.paths.nextBundle, '// new daemon');
    expect(await c.cmd('daemon.upgrade', { mode: 'now' })).toMatchObject({ ok: true });
    for (let i = 0; i < 50 && !exit.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(exit).toHaveBeenCalledWith(75);
    expect(fs.readFileSync(root.paths.bundle, 'utf8')).toBe('// new daemon');
    expect(fs.existsSync(root.paths.nextBundle)).toBe(false);
    expect(c.events().some((e) => e.ev.kind === 'daemon.upgrading')).toBe(true);
  });

  it('a failed upgrade exits instead of keeping the daemon up', async () => {
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    fs.mkdirSync(root.paths.opt, { recursive: true });
    fs.writeFileSync(root.paths.nextBundle, '// new daemon');
    // A non-empty directory where the bundle goes makes the swap fail.
    fs.mkdirSync(path.join(root.paths.bundle, 'blocker'), { recursive: true });
    expect(await c.cmd('daemon.upgrade', { mode: 'now' })).toMatchObject({ ok: true });
    await waitForExit();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.readFileSync(root.paths.nextBundle, 'utf8')).toBe('// new daemon');
    expect(fs.statSync(root.paths.bundle).isDirectory()).toBe(true);
  });

  it('exits nonzero when shutdown cannot persist', async () => {
    const segment = fs.readdirSync(root.paths.events).find((name) => name.endsWith('.ndjson'));
    if (!segment) throw new Error('expected an event segment');
    const file = path.join(root.paths.events, segment);
    fs.rmSync(file);
    fs.mkdirSync(file);
    await daemon.shutdown();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    await daemon.shutdown();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits shutdown after a failed synchronous write', async () => {
    const parent = path.join(root.paths.state, 'not-a-directory');
    fs.writeFileSync(parent, 'x');
    expect(() => writeJsonAtomicSync(path.join(parent, 'child.json'), { n: 1 })).toThrow();
    await daemon.shutdown();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('puckd without a usable state', () => {
  it('fails without a definition but still answers snapshots and logs', async () => {
    await boot();
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    const snap = (await c.cmd('snapshot.get')) as { ok: true; result: Snapshot };
    expect(snap.result.instance).toMatchObject({ status: 'failed', error: expect.stringMatching(/No environment definition/) });
    expect(await c.cmd('chat.send', { text: 'hi' })).toMatchObject({ ok: false, error: { code: 'not-ready' } });
    const logs = (await c.cmd('logs.tail', { lines: 50 })) as { ok: true; result: { text: string } };
    expect(logs.result.text).toContain('daemon.failed');
  });

  it('fails on state from a newer daemon without touching it', async () => {
    fs.mkdirSync(root.paths.state, { recursive: true });
    fs.writeFileSync(path.join(root.paths.state, 'meta.json'), JSON.stringify({ formatVersion: 99, daemonVersion: 'x', createdAt: 1 }));
    await boot();
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    const snap = (await c.cmd('snapshot.get')) as { ok: true; result: Snapshot };
    expect(snap.result.instance).toMatchObject({ status: 'failed', error: expect.stringMatching(/newer daemon/) });
  });
});

describe('inbox instance durability', () => {
  it('has the instance record on disk before provisioning starts', async () => {
    const stateFile = path.join(root.paths.state, 'instance.json');
    const inboxFile = path.join(root.paths.inbox, 'instance.json');
    deliver({
      'instance.json': {
        envId: ENV_ID,
        name: 'Example',
        pin: { kind: 'tag', name: 'v1', sha: 'abc1234' },
        definition: exampleDefinition(),
      },
    });
    let atFirstCommand: { inbox: boolean; envId: string | null } | null = null;
    await boot({
      onCommand: () => {
        if (atFirstCommand) return;
        let envId: string | null = null;
        try {
          envId = (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { envId?: string }).envId ?? null;
        } catch {
          envId = null;
        }
        atFirstCommand = { inbox: fs.existsSync(inboxFile), envId };
      },
    });
    expect(atFirstCommand).toEqual({ inbox: false, envId: ENV_ID });
  });
});

function exampleInbox(): Record<string, unknown> {
  return {
    'instance.json': {
      envId: ENV_ID,
      name: 'Example',
      pin: { kind: 'tag', name: 'v1', sha: 'abc1234' },
      definition: exampleDefinition(),
    },
  };
}

describe('upgrade failure restarts instead of rolling back', () => {
  it('exits nonzero without swapping when a turn ignores the interrupt', async () => {
    deliver(exampleInbox());
    const prompts: string[] = [];
    const hang: HarnessAdapter = {
      id: 'claude-code',
      run: async (req) => {
        prompts.push(req.prompt);
        return new Promise<void>(() => undefined);
      },
    };
    await boot({
      shutdownGraceMs: 40,
      adapters: { 'claude-code': hang, codex: { id: 'codex', run: () => Promise.resolve() } },
    });
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    expect(await c.cmd('chat.send', { text: 'hang' })).toMatchObject({ ok: true, result: { queued: false } });
    fs.mkdirSync(root.paths.opt, { recursive: true });
    fs.writeFileSync(root.paths.nextBundle, '// new daemon');
    expect(await c.cmd('daemon.upgrade', { mode: 'now' })).toMatchObject({ ok: true });
    await waitForExit();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.readFileSync(root.paths.nextBundle, 'utf8')).toBe('// new daemon');
    expect(fs.existsSync(root.paths.bundle)).toBe(false);
    expect(prompts).toEqual(['hang']);
  });

  it('exits 75 when the interrupted turn finishes within the grace', async () => {
    deliver(exampleInbox());
    const finishing: HarnessAdapter = {
      id: 'claude-code',
      run: async (_req, ctx) => {
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) return resolve();
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        ctx.emit({ kind: 'turn-end', stats: { inputTokens: 1, outputTokens: 1, durationMs: 1 } });
      },
    };
    await boot({
      shutdownGraceMs: 40,
      adapters: { 'claude-code': finishing, codex: { id: 'codex', run: () => Promise.resolve() } },
    });
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    expect(await c.cmd('chat.send', { text: 'hang' })).toMatchObject({ ok: true, result: { queued: false } });
    fs.mkdirSync(root.paths.opt, { recursive: true });
    fs.writeFileSync(root.paths.nextBundle, '// new daemon');
    expect(await c.cmd('daemon.upgrade', { mode: 'now' })).toMatchObject({ ok: true });
    await waitForExit();
    expect(exit).toHaveBeenCalledWith(75);
    expect(fs.readFileSync(root.paths.bundle, 'utf8')).toBe('// new daemon');
    expect(fs.existsSync(root.paths.nextBundle)).toBe(false);
  });

  it('a restarted daemon delivers a queued follow-up and reconciles the interrupted turn', async () => {
    deliver(exampleInbox());
    const hang: HarnessAdapter = {
      id: 'claude-code',
      run: () => new Promise<void>(() => undefined),
    };
    await boot({
      shutdownGraceMs: 40,
      adapters: { 'claude-code': hang, codex: { id: 'codex', run: () => Promise.resolve() } },
    });
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    expect(await c.cmd('chat.send', { text: 'hang' })).toMatchObject({ ok: true, result: { queued: false } });
    expect(await c.cmd('chat.send', { text: 'later' })).toMatchObject({ ok: true, result: { queued: true } });
    fs.mkdirSync(root.paths.opt, { recursive: true });
    fs.writeFileSync(root.paths.nextBundle, '// new daemon');
    expect(await c.cmd('daemon.upgrade', { mode: 'now' })).toMatchObject({ ok: true });
    await waitForExit();
    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.existsSync(root.paths.bundle)).toBe(false);
    const sessions = JSON.parse(fs.readFileSync(path.join(root.paths.state, 'sessions.json'), 'utf8')) as Record<
      string,
      { status: string; queue: { text: string; author: string }[] }
    >;
    const saved = Object.values(sessions).find((s) => s.status === 'running');
    expect(saved?.queue).toEqual([{ text: 'later', author: 'user' }]);

    const prompts: string[] = [];
    const completing: HarnessAdapter = {
      id: 'claude-code',
      run: async (req, ctx) => {
        prompts.push(req.prompt);
        ctx.emit({ kind: 'turn-end', stats: { inputTokens: 1, outputTokens: 1, durationMs: 1 } });
      },
    };
    await boot({
      shutdownGraceMs: 40,
      adapters: { 'claude-code': completing, codex: { id: 'codex', run: () => Promise.resolve() } },
    });
    const again = client();
    again.hello(0);
    const notice = await again.until(
      (f): f is Extract<DaemonFrame, { t: 'event' }> => f.t === 'event' && f.ev.kind === 'turn.notice',
    );
    expect(notice.ev).toMatchObject({
      kind: 'turn.notice',
      entry: {
        notices: [expect.objectContaining({ kind: 'environment.restarted', text: expect.stringContaining('were resumed (the orchestrator)') })],
      },
    });
    expect(prompts.some((p) => p.includes('later'))).toBe(true);
    const sessionId = notice.ev.kind === 'turn.notice' ? notice.ev.sessionId : '';
    const transcript = fs.readFileSync(path.join(root.paths.transcripts, `${sessionId}.json`), 'utf8');
    expect(transcript).toContain('The environment restarted during this turn.');
  });

  it('a graceful shutdown mid-turn leaves the conversation to resume through its harness session on the next boot', async () => {
    deliver(exampleInbox());
    const honouring: HarnessAdapter = {
      id: 'claude-code',
      run: (req, ctx) =>
        new Promise<void>((resolve) => {
          ctx.reportSession(req.resumeId ?? 'sess-graceful');
          ctx.emit({ kind: 'text-delta', text: 'working…' });
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    };
    await boot({ shutdownGraceMs: 1_000, adapters: { 'claude-code': honouring, codex: { id: 'codex', run: () => Promise.resolve() } } });
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    expect(await c.cmd('chat.send', { text: 'long job' })).toMatchObject({ ok: true, result: { queued: false } });
    await c.until((f): f is Extract<DaemonFrame, { t: 'event' }> => f.t === 'event' && f.ev.kind === 'turn.event');
    await daemon.shutdown();
    await waitForExit();
    expect(exit).toHaveBeenCalledWith(0);
    const sessions = JSON.parse(fs.readFileSync(path.join(root.paths.state, 'sessions.json'), 'utf8')) as Record<string, { status: string; resumeId?: string }>;
    expect(Object.values(sessions)).toEqual([expect.objectContaining({ status: 'interrupted', resumeId: 'sess-graceful' })]);

    const seen: { prompt: string; resumeId: string | null }[] = [];
    const completing: HarnessAdapter = {
      id: 'claude-code',
      run: async (req, ctx) => {
        seen.push({ prompt: req.prompt, resumeId: req.resumeId });
        ctx.emit({ kind: 'turn-end', stats: { inputTokens: 1, outputTokens: 1, durationMs: 1 } });
      },
    };
    await boot({ adapters: { 'claude-code': completing, codex: { id: 'codex', run: () => Promise.resolve() } } });
    for (let i = 0; i < 50 && !seen.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(seen[0].resumeId).toBe('sess-graceful');
    expect(seen[0].prompt).toContain('Continue.');
  });

  it('refuses an upgrade while boot provisioning is still running', async () => {
    deliver(exampleInbox());
    let releaseProvision: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    let held = false;
    const started = launch({
      hold: () => {
        if (held) return Promise.resolve();
        held = true;
        return gate;
      },
    });
    for (let i = 0; i < 50 && !fs.existsSync(root.paths.socket); i++) await new Promise((r) => setTimeout(r, 20));
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    fs.mkdirSync(root.paths.opt, { recursive: true });
    fs.writeFileSync(root.paths.nextBundle, '// new daemon');
    expect(await c.cmd('daemon.upgrade', { mode: 'now' })).toMatchObject({ ok: false, error: { code: 'not-ready' } });
    const mid = (await c.cmd('snapshot.get')) as { ok: true; result: Snapshot };
    expect(mid.result.instance.status).toBe('provisioning');
    releaseProvision();
    await started;
    const ready = (await c.cmd('snapshot.get')) as { ok: true; result: Snapshot };
    expect(ready.result.instance.status).toBe('ready');
    expect(await c.cmd('chat.send', { text: 'after boot' })).toMatchObject({ ok: true });
    expect(exit).not.toHaveBeenCalled();
    expect(fs.readFileSync(root.paths.nextBundle, 'utf8')).toBe('// new daemon');
  });

  it('shuts down once when signaled during a failing upgrade', async () => {
    deliver({
      'instance.json': {
        envId: ENV_ID,
        name: 'Example',
        pin: { kind: 'tag', name: 'v1', sha: 'abc1234' },
        definition: exampleDefinition(),
      },
    });
    const prompts: string[] = [];
    const hang: HarnessAdapter = {
      id: 'claude-code',
      run: async (req) => {
        prompts.push(req.prompt);
        return new Promise<void>(() => undefined);
      },
    };
    await boot({
      shutdownGraceMs: 40,
      adapters: { 'claude-code': hang, codex: { id: 'codex', run: () => Promise.resolve() } },
    });
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    expect(await c.cmd('chat.send', { text: 'hang' })).toMatchObject({ ok: true, result: { queued: false } });
    expect(await c.cmd('chat.send', { text: 'later' })).toMatchObject({ ok: true, result: { queued: true } });
    fs.mkdirSync(root.paths.opt, { recursive: true });
    fs.writeFileSync(root.paths.nextBundle, '// new daemon');
    fs.mkdirSync(path.join(root.paths.bundle, 'blocker'), { recursive: true });
    expect(await c.cmd('daemon.upgrade', { mode: 'now' })).toMatchObject({ ok: true });
    await daemon.shutdown();
    await waitForExit();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    await daemon.shutdown();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(prompts).toEqual(['hang']);
    expect(fs.readFileSync(root.paths.nextBundle, 'utf8')).toBe('// new daemon');
    expect(fs.statSync(root.paths.bundle).isDirectory()).toBe(true);
  });

  it('exits 75 once when signaled during a successful upgrade', async () => {
    deliver({
      'instance.json': {
        envId: ENV_ID,
        name: 'Example',
        pin: { kind: 'tag', name: 'v1', sha: 'abc1234' },
        definition: exampleDefinition(),
      },
    });
    await boot({ shutdownGraceMs: 40 });
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    fs.mkdirSync(root.paths.opt, { recursive: true });
    fs.writeFileSync(root.paths.nextBundle, '// new daemon');
    expect(await c.cmd('daemon.upgrade', { mode: 'now' })).toMatchObject({ ok: true });
    await daemon.shutdown();
    await waitForExit();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(75);
    await daemon.shutdown();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(root.paths.bundle, 'utf8')).toBe('// new daemon');
    expect(fs.existsSync(root.paths.nextBundle)).toBe(false);
  });
});

describe('restored follow-up through Daemon.start', () => {
  function scripted(): { prompts: string[]; adapters: Record<string, HarnessAdapter> } {
    const prompts: string[] = [];
    const claude: HarnessAdapter = {
      id: 'claude-code',
      run: async (req, ctx) => {
        prompts.push(req.prompt);
        if (prompts.length === 1) return new Promise<void>(() => undefined);
        ctx.emit({ kind: 'turn-end', stats: { inputTokens: 1, outputTokens: 1, durationMs: 1 } });
      },
    };
    return { prompts, adapters: { 'claude-code': claude, codex: { id: 'codex', run: async () => undefined } } };
  }

  async function queueFollowUp(text: string, adapters: Record<string, HarnessAdapter>): Promise<void> {
    await boot({ shutdownGraceMs: 30, adapters });
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    expect(await c.cmd('chat.send', { text: 'first' })).toMatchObject({ ok: true, result: { queued: false } });
    expect(await c.cmd('chat.send', { text })).toMatchObject({ ok: true, result: { queued: true } });
    await daemon.shutdown();
  }

  it('gives the restored follow-up the environment.restarted notice', async () => {
    deliver({
      'instance.json': {
        envId: ENV_ID,
        name: 'Example',
        pin: { kind: 'tag', name: 'v1', sha: 'abc1234' },
        definition: exampleDefinition(),
      },
    });
    const { prompts, adapters } = scripted();
    await queueFollowUp('second', adapters);
    await boot({ shutdownGraceMs: 30, adapters });
    const c = client();
    c.hello(0);
    const notice = await c.until(
      (f): f is Extract<DaemonFrame, { t: 'event' }> => f.t === 'event' && f.ev.kind === 'turn.notice',
    );
    expect(notice.ev).toMatchObject({
      kind: 'turn.notice',
      entry: {
        notices: [expect.objectContaining({ kind: 'environment.restarted', text: expect.stringContaining('were resumed (the orchestrator)') })],
      },
    });
    const restored = prompts.find((p) => p.includes('second'));
    expect(restored).toContain('The environment restarted');
    expect(restored).toContain('second');
    const user = c.events().find((e) => e.ev.kind === 'turn.user' && e.ev.entry.text === 'second');
    expect(user?.ev).toMatchObject({ sessionId: notice.ev.kind === 'turn.notice' ? notice.ev.sessionId : '' });
  });

  it('does not move a replaced orchestrator queue onto the new session', async () => {
    deliver({
      'instance.json': {
        envId: ENV_ID,
        name: 'Example',
        pin: { kind: 'tag', name: 'v1', sha: 'abc1234' },
        definition: exampleDefinition(),
      },
    });
    const { prompts, adapters } = scripted();
    await queueFollowUp('kept', adapters);
    const file = path.join(root.paths.state, 'instance.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8')) as { definition: { orchestrator: { agent: string } } };
    record.definition.orchestrator.agent = 'implementer';
    fs.writeFileSync(file, JSON.stringify(record));
    await boot({ shutdownGraceMs: 30, adapters });
    const c = client();
    c.hello(null);
    await c.until(isWelcome);
    const snap = (await c.cmd('snapshot.get')) as { ok: true; result: Snapshot };
    expect(snap.result.instance.status).toBe('ready');
    expect(snap.result.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent: 'lead', status: 'closed' }),
        expect.objectContaining({ agent: 'implementer', kind: 'orchestrator', status: 'idle', queued: 0 }),
      ]),
    );
    expect(prompts.some((p) => p.includes('kept'))).toBe(false);
  });
});

describe('daemon wire frame limit', () => {
  async function serve(): Promise<DaemonServer> {
    fs.mkdirSync(root.paths.run, { recursive: true });
    const server = new DaemonServer({
      socketPath: root.paths.socket,
      log: nullLogger,
      events: new EventLog(root.paths.events),
      identity: () => ({ envId: ENV_ID, version: '0', build: 'b' }),
      dispatch: async () => {
        throw new Error('an oversized frame must not be dispatched');
      },
    });
    await server.listen();
    return server;
  }

  it('rejects a complete line larger than maxFrameBytes before parsing it', async () => {
    const server = await serve();
    try {
      const c = client();
      const line = JSON.stringify({
        t: 'hello',
        protocol: 1,
        client: { app: 't', build: 'x' },
        since: null,
        pad: 'y'.repeat(WIRE_LIMITS.maxFrameBytes),
      });
      expect(Buffer.byteLength(line)).toBeGreaterThan(WIRE_LIMITS.maxFrameBytes);
      c.socket.write(line + '\n');
      const err = await c.until((f): f is Extract<DaemonFrame, { t: 'error' }> => f.t === 'error');
      expect(err).toMatchObject({ code: 'bad-frame', message: 'A frame is larger than 1 MiB.' });
      expect(c.frames.some((f) => f.t === 'welcome')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('rejects an unterminated tail larger than maxFrameBytes', async () => {
    const server = await serve();
    try {
      const c = client();
      c.socket.write('x'.repeat(WIRE_LIMITS.maxFrameBytes + 1));
      const err = await c.until((f): f is Extract<DaemonFrame, { t: 'error' }> => f.t === 'error');
      expect(err).toMatchObject({ code: 'bad-frame', message: 'A frame is larger than 1 MiB.' });
    } finally {
      await server.close();
    }
  });

  it('refuses every command, including upgrade, once it stops accepting', async () => {
    const seen: string[] = [];
    fs.mkdirSync(root.paths.run, { recursive: true });
    const server = new DaemonServer({
      socketPath: root.paths.socket,
      log: nullLogger,
      events: new EventLog(root.paths.events),
      identity: () => ({ envId: ENV_ID, version: '0', build: 'b' }),
      dispatch: async (op) => {
        seen.push(op);
        return {};
      },
    });
    await server.listen();
    try {
      const c = client();
      c.hello(null);
      await c.until(isWelcome);
      server.stopAccepting();
      expect(await c.cmd('daemon.upgrade', { mode: 'now' })).toMatchObject({
        ok: false,
        error: { code: 'not-ready', message: 'The daemon is shutting down.' },
      });
      expect(await c.cmd('snapshot.get')).toMatchObject({ ok: false, error: { code: 'not-ready' } });
      expect(seen).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
