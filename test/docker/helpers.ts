/**
 * Docker suite plumbing: build the daemon's test bundle (scripted fake
 * harness), build a test image (node:22-bookworm plus a local bare repo
 * standing in for GitHub), start environments the way the app will (named
 * volumes, --init, restart policy, no-new-privileges, files copied in
 * rather than mounted), and speak the daemon protocol through
 * `docker exec -i … puckd.js attach`.
 */

import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  addSnapshotPart,
  PROTOCOL_VERSION,
  snapshotFromHead,
  type DaemonEvent,
  type DaemonFrame,
  type Snapshot,
  type SnapshotHead,
  type SnapshotPart,
  type WorkItem,
} from '../../src/harness/daemon-protocol';
import { newId } from '../../src/harness/ulid';

const ROOT = path.resolve(__dirname, '..', '..');
export const TEST_BUNDLE = path.join(ROOT, '.webpack', 'daemon-test', 'puckd.js');
export const IMAGE = 'puck-daemon-test:1';
export const BASE_IMAGE = 'node:22-bookworm';

export interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function docker(args: string[], opts: { timeoutMs?: number } = {}): Promise<Result> {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: opts.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code as number | null) ?? 1 : 0;
      resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function must(args: string[], opts?: { timeoutMs?: number }): Promise<string> {
  const r = await docker(args, opts);
  if (r.code !== 0) throw new Error(`docker ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Builds puck-runner (the Docker suite runs it as a real process). */
export function buildRunnerBundle(): void {
  execFileSync(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(ROOT, 'scripts', 'build-runner.mjs'), '--mode', 'development'],
    { cwd: ROOT, stdio: 'inherit' },
  );
}

/** Builds the daemon with the fake harness compiled in. */
export function buildTestBundle(): void {
  execFileSync(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(ROOT, 'scripts', 'build-daemon.mjs'), '--test'],
    { cwd: ROOT, stdio: 'inherit' },
  );
}

const DOCKERFILE = `FROM ${BASE_IMAGE}
RUN git init --bare --initial-branch=main /srv/git/octo/app.git \\
 && git clone /srv/git/octo/app.git /tmp/seed \\
 && cd /tmp/seed \\
 && git -c user.name=seed -c user.email=seed@example.com commit --allow-empty -m init \\
 && echo "# app" > README.md && git add README.md \\
 && git -c user.name=seed -c user.email=seed@example.com commit -m readme \\
 && git push origin main \\
 && rm -rf /tmp/seed
`;

/** The test image: the base image plus a bare repo at /srv/git/octo/app.git. */
export async function buildTestImage(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['build', '-q', '-t', IMAGE, '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker build failed: ${err}`))));
    child.stdin.end(DOCKERFILE);
  });
}

export function definition(): Record<string, unknown> {
  return {
    name: 'example',
    repos: [{ github: 'octo/app', dir: 'app', branch: 'main' }],
    orchestrator: { agent: 'lead' },
    agents: [{ agent: 'implementer', maxParallel: 1 }],
    agentDefinitions: {
      lead: { harness: 'claude-code', instructions: 'Lead.' },
      implementer: { harness: 'claude-code', instructions: 'Implement.' },
    },
    git: { userName: 'Puck Test', userEmail: 'puck-test@example.com' },
    env: { NODE_ENV: 'test' },
    secrets: ['NPM_TOKEN'],
  };
}

export interface Env {
  envId: string;
  container: string;
  volumes: string[];
  remove(): Promise<void>;
}

/**
 * Creates and starts an environment container. Before the first start the
 * bundle and the inbox files are copied in (root-owned), exactly as the app
 * will deliver them; nothing from the host is mounted.
 */
export async function startEnv(
  inbox: Record<string, unknown>,
  opts: { env?: Record<string, string>; definition?: Record<string, unknown>; installPackages?: boolean } = {},
): Promise<Env> {
  const envId = newId('env');
  const tag = envId.slice(-10).toLowerCase();
  const container = `puck-test-${tag}`;
  const volumes = [`puck-test-${tag}-data`, `puck-test-${tag}-ws`];
  for (const v of volumes) await must(['volume', 'create', '--label', 'puck=test', v]);
  await must([
    'create',
    '--init',
    '--name',
    container,
    '--label',
    'puck=test',
    '--restart',
    'unless-stopped',
    '--security-opt',
    'no-new-privileges:true',
    ...(opts.installPackages ? [] : ['-e', 'PUCK_SKIP_PACKAGES=1']),
    '-e',
    'PUCK_TEST_GIT_BASE=file:///srv/git/',
    ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-v',
    `${volumes[0]}:/puck`,
    '-v',
    `${volumes[1]}:/workspace`,
    IMAGE,
    'node',
    '/opt/puck/puckd.js',
    'serve',
  ]);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-stage-'));
  try {
    fs.mkdirSync(path.join(stage, 'opt', 'puck'), { recursive: true });
    fs.copyFileSync(TEST_BUNDLE, path.join(stage, 'opt', 'puck', 'puckd.js'));
    fs.mkdirSync(path.join(stage, 'puck', 'inbox'), { recursive: true });
    const instance = { envId, name: 'Example', definition: opts.definition ?? definition() };
    for (const [name, body] of Object.entries({ 'instance.json': instance, ...inbox })) {
      fs.writeFileSync(path.join(stage, 'puck', 'inbox', name), typeof body === 'string' ? body : JSON.stringify(body));
    }
    await must(['cp', `${stage}/.`, `${container}:/`]);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  await must(['start', container]);
  return {
    envId,
    container,
    volumes,
    async remove() {
      await docker(['rm', '-f', container]);
      for (const v of volumes) await docker(['volume', 'rm', '-f', v]);
    },
  };
}

type EventFrame = Extract<DaemonFrame, { t: 'event' }>;

/** A ticket that finished and waits on the user to accept or merge: protocol 1's `review`. */
export const finished = (item: WorkItem | undefined): boolean => item?.status === 'in-progress' && item.stage === 'merge';

/** A ticket whose implement step runs or waits on a question, holding its agent's slot: protocol 1's `running` and `needs-input`. */
export const implementing = (item: WorkItem | undefined): boolean =>
  item?.status === 'in-progress' && !!item.workflow?.steps.some((s) => s.kind === 'implement' && (s.state === 'running' || s.state === 'needs-input'));

/**
 * A protocol client over `docker exec -i <container> node /opt/puck/puckd.js attach`.
 * It speaks the app's protocol unless told otherwise; protocol 1 is an app that predates it.
 */
export function attachClient(container: string, opts: { protocol?: number } = {}) {
  const protocol = opts.protocol ?? PROTOCOL_VERSION;
  const child: ChildProcessWithoutNullStreams = spawn('docker', ['exec', '-i', container, 'node', '/opt/puck/puckd.js', 'attach'], {
    stdio: 'pipe',
  });
  const frames: DaemonFrame[] = [];
  let buf = '';
  let stderr = '';
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) frames.push(JSON.parse(line) as DaemonFrame);
    }
  });
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  child.on('close', () => (closed = true));
  const send = (frame: unknown): void => {
    child.stdin.write(JSON.stringify(frame) + '\n');
  };

  async function until<T extends DaemonFrame>(pred: (f: DaemonFrame) => f is T, timeoutMs = 60_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = frames.find(pred);
      if (hit) return hit;
      if (closed) throw new Error(`attach closed; stderr: ${stderr}; frames: ${JSON.stringify(frames).slice(0, 2000)}`);
      if (Date.now() > deadline) throw new Error(`timed out; frames: ${JSON.stringify(frames).slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  let n = 0;
  async function one<R>(op: string, args: unknown): Promise<R> {
    const id = `c${++n}`;
    send({ t: 'cmd', id, op, args });
    const res = await until((f): f is Extract<DaemonFrame, { t: 'res' }> => f.t === 'res' && f.id === id);
    if (!res.ok) throw new Error(`${op} failed: ${res.error.code}: ${res.error.message}`);
    return res.result as R;
  }
  /** Protocol 2's snapshot is the head and then its parts; either way the caller gets the whole one. */
  async function cmd<R = unknown>(op: string, args: unknown = {}): Promise<R> {
    if (op !== 'snapshot.get' || protocol < 2) return one<R>(op, args);
    const head = await one<SnapshotHead>('snapshot.get', args);
    const snap = snapshotFromHead(head);
    for (let cursor = head.partsCursor; cursor; ) {
      const part = await one<SnapshotPart>('snapshot.part', { cursor });
      addSnapshotPart(snap, part);
      cursor = part.partsCursor;
    }
    return snap as R;
  }
  const events = (): EventFrame[] => frames.filter((f): f is EventFrame => f.t === 'event');
  const hello = async (since: number | null) => {
    send({ t: 'hello', protocol, client: { app: 'docker-suite', build: 'test' }, since });
    return until((f): f is Extract<DaemonFrame, { t: 'welcome' }> => f.t === 'welcome');
  };
  const untilEvent = <K extends DaemonEvent['kind']>(kind: K, pred: (ev: Extract<DaemonEvent, { kind: K }>) => boolean = () => true) =>
    until((f): f is EventFrame => f.t === 'event' && f.ev.kind === kind && pred(f.ev as Extract<DaemonEvent, { kind: K }>));
  return {
    frames,
    events,
    send,
    until,
    untilEvent,
    cmd,
    hello,
    close: () => {
      child.stdin.end();
      child.kill();
    },
    isClosed: () => closed,
  };
}

/** Attach until the daemon's socket exists, then wait for ready (or fail with the reason). */
export async function waitReady(container: string, timeoutMs = 120_000): Promise<ReturnType<typeof attachClient>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = attachClient(container);
    try {
      await client.hello(null);
    } catch (err) {
      client.close();
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    for (;;) {
      const snap = await client.cmd<Snapshot>('snapshot.get');
      if (snap.instance.status === 'ready') return client;
      if (snap.instance.status === 'failed') {
        const logs = await client.cmd<{ text: string }>('logs.tail', { lines: 60 });
        throw new Error(`environment failed at ${snap.instance.stage}: ${snap.instance.error}\n${logs.text}`);
      }
      if (Date.now() > deadline) throw new Error(`not ready: ${JSON.stringify(snap.instance)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

export async function exec(container: string, args: string[], user?: string): Promise<Result> {
  return docker(['exec', ...(user ? ['-u', user] : []), container, ...args]);
}

/** Copy a file into a running container. */
export async function copyIn(container: string, content: string, dest: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-copy-'));
  try {
    const file = path.join(dir, path.basename(dest));
    fs.writeFileSync(file, content);
    await must(['cp', file, `${container}:${dest}`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Poll `snapshot.get` until `pred` holds for the snapshot. */
export async function untilSnapshot(
  client: ReturnType<typeof attachClient>,
  pred: (snap: Snapshot) => boolean,
  timeoutMs = 60_000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await client.cmd<Snapshot>('snapshot.get');
    if (pred(snap)) return snap;
    if (Date.now() > deadline) throw new Error(`snapshot never matched: ${JSON.stringify(snap.items).slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * A stand-in for GitHub's pull request API, run inside the container on
 * 127.0.0.1:8787. It keeps pull requests in memory and appends every
 * request (method, path, authorization, body) to /srv/github.log.
 */
export const FAKE_GITHUB = `
const http = require('http');
const fs = require('fs');
const pulls = [];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    fs.appendFileSync('/srv/github.log', JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization || null, body: json }) + '\\n');
    const url = new URL(req.url, 'http://x');
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const m = /^\\/repos\\/([^/]+)\\/([^/]+)\\/pulls(?:\\/(\\d+))?$/.exec(url.pathname);
    if (!m) return send(404, { message: 'Not Found' });
    if (req.method === 'GET') {
      const head = url.searchParams.get('head');
      return send(200, pulls.filter((p) => p.state === 'open' && (!head || head === m[1] + ':' + p.head.ref)));
    }
    if (req.method === 'POST') {
      const pr = { number: pulls.length + 1, html_url: 'https://github.com/' + m[1] + '/' + m[2] + '/pull/' + (pulls.length + 1), state: 'open', draft: !!json.draft, title: json.title, body: json.body, head: { ref: json.head, sha: '' }, base: { ref: json.base } };
      pulls.push(pr);
      return send(201, pr);
    }
    if (req.method === 'PATCH') {
      const pr = pulls.find((p) => p.number === Number(m[3]));
      if (!pr) return send(404, { message: 'Not Found' });
      Object.assign(pr, json);
      return send(200, pr);
    }
    send(405, { message: 'Method not allowed' });
  });
}).listen(8787, '127.0.0.1');
`;

/** Every harness event of one turn, in order. */
export function turnEvents(frames: EventFrame[], turnId: string) {
  return frames
    .map((f) => f.ev)
    .filter((ev): ev is Extract<DaemonEvent, { kind: 'turn.event' }> => ev.kind === 'turn.event' && ev.turnId === turnId)
    .map((ev) => ev.event);
}
