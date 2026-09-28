import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONTROL_OPS, instanceNames, type ControlEvent } from '../../src/harness/runner-protocol';
import { BundleCache } from '../../src/puck-runner/bundles';
import { Control, controlTableTotal, VALIDATORS } from '../../src/puck-runner/control';
import type { DockerOptions, DockerResult } from '../../src/puck-runner/docker/client';
import { DockerOps } from '../../src/puck-runner/docker/ops';
import { createLogger, nullLogger } from '../../src/puck-runner/log';
import { exampleDefinition } from './daemon-fakes';

// The control channel's command table: every op validated before it reaches
// Docker, the bundle cache upload, and create fetching the first GitHub
// grants from the server itself.

const ENV = 'env_01J9ZZZZZZZZZZZZZZZZZZZZZZ';
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-control-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const instance = { envId: ENV, name: 'Example', definition: exampleDefinition() };

function harness(opts: { exists?: boolean; containers?: number; max?: number | null; mintFails?: boolean; volumes?: boolean; hold?: Promise<void> } = {}) {
  const calls: string[][] = [];
  const inputs: DockerOptions['input'][] = [];
  const run = async (args: string[], o: DockerOptions = {}): Promise<DockerResult> => {
    if (opts.hold) await opts.hold;
    calls.push(args);
    inputs.push(o.input);
    if (args[0] === 'container' && args[1] === 'inspect') return opts.exists ? { code: 0, stdout: 'running\n', stderr: '' } : { code: 1, stdout: '', stderr: 'No such container' };
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return opts.volumes ? { code: 0, stdout: `${args[args.length - 1]}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'No such volume' };
    }
    if (args[0] === 'ps') {
      const row = (i: number) => JSON.stringify({ Names: `puck-e${i}`, State: 'running', Image: 'x', Labels: `puck=instance,puck.env=env_${i}` });
      return { code: 0, stdout: Array.from({ length: opts.containers ?? 0 }, (_, i) => row(i)).join('\n'), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const bundles = new BundleCache(path.join(dir, 'cache'));
  const started: string[] = [];
  const minted: string[] = [];
  const control = new Control({
    ops: new DockerOps(run),
    bundles,
    log: createLogger({ dir: path.join(dir, 'diag') }),
    info: async () => {
      throw new Error('unused');
    },
    mint: async (envId) => {
      minted.push(envId);
      if (opts.mintFails) throw new Error('github-not-configured');
      return [{ owner: 'octo', installationId: 1, repos: ['octo/app'], token: 'ghs_firsttoken0001', expiresAt: 4102444800000 }];
    },
    started: (id) => started.push(id),
    removed: () => undefined,
    maxEnvironments: () => opts.max ?? null,
  });
  const events: ControlEvent[] = [];
  const cmd = (op: string, args: unknown) => control.handle({ t: 'cmd', id: 'c1', op, args }, (ev) => events.push(ev));
  return { control, bundles, calls, inputs, started, minted, events, cmd };
}

describe('runner control protocol', () => {
  it('has a validator and handler for every op', () => {
    expect(controlTableTotal()).toBe(true);
    expect(Object.keys(VALIDATORS).sort()).toEqual(Object.keys(CONTROL_OPS).sort());
  });

  it('names Docker objects from the environment id, lowercasing only the image tag', () => {
    expect(instanceNames(ENV)).toEqual({
      container: `puck-${ENV}`,
      data: `puck-${ENV}-data`,
      workspace: `puck-${ENV}-ws`,
      image: `puck-img-${ENV.toLowerCase()}`,
    });
  });

  it('refuses arguments that could reach Docker as flags or break the container config', async () => {
    const h = harness();
    const base = { envId: ENV, bundleSha: 'a'.repeat(64), inbox: { instance } };
    const bad = async (args: unknown) => (await h.cmd('instance.create', args)) as { ok: boolean; error?: { code: string } };
    expect((await bad({ ...base, image: '--privileged' })).error?.code).toBe('invalid-args');
    expect((await bad({ ...base, image: 'x', dockerfile: 'FROM x' })).error?.code).toBe('invalid-args');
    expect((await bad({ ...base, image: 'x', containerEnv: { 'A=B': 'x' } })).error?.code).toBe('invalid-args');
    expect((await bad({ ...base, image: 'x', resources: { memory: '4g; rm' } })).error?.code).toBe('invalid-args');
    expect((await bad({ ...base, envId: 'env_bad', image: 'x' })).error?.code).toBe('invalid-args');
    expect((await bad({ ...base, image: 'x', inbox: { instance: { ...instance, envId: 'env_01J9YYYYYYYYYYYYYYYYYYYYYY' } } })).error?.code).toBe('invalid-args');
    expect(await h.cmd('nope.op', {})).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(await h.control.handle({ t: 'x' }, () => undefined)).toMatchObject({ t: 'error', code: 'bad-frame' });
    expect(h.calls).toEqual([]);
  });

  it('refuses an inbox the daemon would drop, before any Docker work', async () => {
    const h = harness();
    const bundle = Buffer.from('// puckd');
    h.bundles.put(sha(bundle), 0, bundle, true);
    const base = { envId: ENV, image: 'node:22', bundleSha: sha(bundle) };
    const bad = async (args: unknown) => (await h.cmd('instance.create', args)) as { ok: boolean; error?: { code: string; message?: string } };
    const withInbox = (over: Record<string, unknown>) => ({ ...base, inbox: { instance, ...over } });

    expect((await bad(withInbox({ secrets: { PUCK_TOKEN: 'x' } }))).error?.code).toBe('invalid-args');
    expect((await bad(withInbox({ secrets: { OK: 'x', PUCK_TOKEN: 'x' } }))).error?.code).toBe('invalid-args');
    expect((await bad(withInbox({ secrets: { NPM_TOKEN: 'x'.repeat(64 * 1024 + 1) } }))).error?.code).toBe('invalid-args');
    expect((await bad(withInbox({ secrets: { 'not a name': 'x' } }))).error?.code).toBe('invalid-args');
    expect((await bad(withInbox({ harness: [{ id: 'nope', content: '{}' }] }))).error?.code).toBe('invalid-args');
    expect((await bad(withInbox({ harness: [{ id: 'claude-code', content: '' }] }))).error?.code).toBe('invalid-args');
    expect((await bad(withInbox({ harness: [{ id: 'claude-code', content: 'not-json' }] }))).error?.code).toBe('invalid-args');
    expect((await bad(withInbox({ harness: [{ id: 'codex', content: JSON.stringify({ v: 'x'.repeat(64 * 1024) }) }] }))).error?.code).toBe('invalid-args');
    const broken = await bad({ ...base, inbox: { instance: { ...instance, definition: { name: 'example' } } } });
    expect(broken.error?.code).toBe('invalid-args');
    expect(broken.error?.message).toMatch(/repos/);
    expect((await bad({ ...base, inbox: { instance: { ...instance, pin: { kind: 'tag', name: 'v1', sha: 'zz' } } } })).error?.code).toBe('invalid-args');
    expect(await h.cmd('instance.rebuild', { ...base, instance: { ...instance, pin: { kind: 'tag', name: 'v1', sha: 'zz' } } })).toMatchObject({
      ok: false,
      error: { code: 'invalid-args' },
    });
    expect(await h.cmd('instance.rebuild', { ...base, instance: { ...instance, definition: { name: 'example' } } })).toMatchObject({
      ok: false,
      error: { code: 'invalid-args' },
    });
    expect(h.calls).toEqual([]);

    const res = await h.cmd('instance.create', withInbox({
      secrets: { NPM_TOKEN: 's3cret' },
      harness: [{ id: 'claude-code', content: '{"token":"abc"}' }],
      instance: { ...instance, pin: { kind: 'tag', name: 'v1', sha: 'abc1234' } },
    }));
    expect(res).toMatchObject({ ok: true, result: {} });
    const cp = h.inputs.find((input) => Buffer.isBuffer(input));
    const archive = cp?.toString('utf8') ?? '';
    expect(archive).toContain('NPM_TOKEN');
    expect(archive).toContain('{"token":"abc"}');
    expect(archive).toContain('abc1234');
  });

  it('caches a bundle uploaded in ordered chunks and checks its sha256', async () => {
    const h = harness();
    const bundle = Buffer.from('// puckd '.repeat(1000));
    const s = sha(bundle);
    expect(await h.cmd('bundle.has', { sha: s })).toMatchObject({ ok: true, result: { has: false } });
    const half = bundle.length >> 1;
    expect(await h.cmd('bundle.put', { sha: s, offset: 0, data: bundle.subarray(0, half).toString('base64'), last: false })).toMatchObject({
      ok: true,
      result: { received: half, complete: false },
    });
    expect(await h.cmd('bundle.put', { sha: s, offset: 5, data: 'AA==', last: false })).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(await h.cmd('bundle.put', { sha: s, offset: half, data: bundle.subarray(half).toString('base64'), last: true })).toMatchObject({
      ok: true,
      result: { complete: true },
    });
    expect(await h.cmd('bundle.has', { sha: s })).toMatchObject({ result: { has: true } });
    expect(h.bundles.get(s).equals(bundle)).toBe(true);
    // A corrupted upload never lands in the cache.
    const wrong = 'b'.repeat(64);
    expect(await h.cmd('bundle.put', { sha: wrong, offset: 0, data: bundle.toString('base64'), last: true })).toMatchObject({ ok: false });
    expect(await h.cmd('bundle.has', { sha: wrong })).toMatchObject({ result: { has: false } });
  });

  it('creates with the first GitHub grants fetched by the runner, streaming stages', async () => {
    const h = harness();
    const bundle = Buffer.from('// puckd');
    h.bundles.put(sha(bundle), 0, bundle, true);
    const res = await h.cmd('instance.create', { envId: ENV, image: 'node:22', bundleSha: sha(bundle), inbox: { instance } });
    expect(res).toMatchObject({ ok: true, result: {} });
    expect(h.minted).toEqual([ENV]);
    expect(h.started).toEqual([ENV]);
    expect(h.events.map((e) => e.stage)).toEqual(['checking-image', 'creating-volumes', 'creating-container', 'copying-files', 'starting-container']);
    const cp = h.calls.findIndex((c) => c[0] === 'cp');
    expect((h.inputs[cp] as Buffer).toString('latin1')).toContain('ghs_firsttoken0001');
  });

  it('refuses a create when the container exists, the runner is full, the bundle is missing, or the server will not mint', async () => {
    const bundle = Buffer.from('// puckd');
    const args = { envId: ENV, image: 'node:22', bundleSha: sha(bundle), inbox: { instance } };
    const exists = harness({ exists: true });
    expect(await exists.cmd('instance.create', args)).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
    const full = harness({ containers: 2, max: 2 });
    expect(await full.cmd('instance.create', args)).toMatchObject({ ok: false, error: { code: 'limit' } });
    const missing = harness();
    expect(await missing.cmd('instance.create', args)).toMatchObject({ ok: false, error: { code: 'not-found' } });
    const noGithub = harness({ mintFails: true });
    noGithub.bundles.put(sha(bundle), 0, bundle, true);
    expect(await noGithub.cmd('instance.create', args)).toMatchObject({ ok: false, error: { code: 'server' } });
    expect(noGithub.calls.some((c) => c[0] === 'create')).toBe(false);
  });

  it('refuses new commands while draining and still finishes the one already running', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({ hold });
    const bundle = Buffer.from('// puckd');
    h.bundles.put(sha(bundle), 0, bundle, true);
    const args = { envId: ENV, image: 'node:22', bundleSha: sha(bundle), inbox: { instance } };
    const pending = h.cmd('instance.create', args);
    expect(h.control.busy).toBe(true);
    h.control.drain();
    expect(await h.cmd('instance.list', {})).toMatchObject({
      ok: false,
      error: { code: 'invalid-state', message: expect.stringMatching(/update/) },
    });
    expect(h.control.busy).toBe(true);
    release();
    expect(await pending).toMatchObject({ ok: true });
    expect(h.control.busy).toBe(false);
    expect(await h.cmd('runner.info', {})).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
    h.control.releaseDrain();
    expect(await h.cmd('instance.list', {})).toMatchObject({ ok: true });
  });

  it('rebuilds when the container is gone but both volumes remain, and not otherwise', async () => {
    const bundle = Buffer.from('// puckd');
    const args = { envId: ENV, image: 'node:22', bundleSha: sha(bundle), instance };
    const gone = harness();
    gone.bundles.put(sha(bundle), 0, bundle, true);
    expect(await gone.cmd('instance.rebuild', args)).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(gone.calls.some((c) => c[0] === 'create')).toBe(false);

    const volumes = harness({ volumes: true });
    volumes.bundles.put(sha(bundle), 0, bundle, true);
    expect(await volumes.cmd('instance.rebuild', args)).toMatchObject({ ok: true, result: {} });
    expect(volumes.calls.some((c) => c[0] === 'volume' && c[1] === 'inspect')).toBe(true);
    const create = volumes.calls.find((c) => c[0] === 'create');
    expect(create?.join(' ')).toContain(`-v puck-${ENV}-data:/puck`);
    expect(create?.join(' ')).toContain(`-v puck-${ENV}-ws:/workspace`);
    expect(volumes.calls.some((c) => c[0] === 'volume' && c[1] === 'create')).toBe(false);
    expect(volumes.started).toEqual([ENV]);
  });

  it('refuses start, stop and upgrades for an environment it does not host', async () => {
    const h = harness();
    expect(await h.cmd('instance.start', { envId: ENV })).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(await h.cmd('instance.stageDaemon', { envId: ENV, bundleSha: 'c'.repeat(64) })).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('tails its own log, capped', async () => {
    const h = harness();
    expect(VALIDATORS['logs.tail']({ lines: 1e9 })).toEqual({ lines: 2000 });
    expect(await h.cmd('logs.tail', { lines: 10 })).toMatchObject({ ok: true });
    expect(nullLogger.files()).toEqual([]);
  });
});
