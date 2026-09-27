import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvLifecycleEvent, EnvStage } from '../../src/harness/bridge';
import { useDockerRunner, type DockerOptions, type DockerResult } from '../../src/main/docker-client';
import { expectedPackages, pinnedSpec } from '../../src/main/provisioning';
import { app } from '../mocks/electron';

// Characterization of an environment start against a scripted Docker: the
// pull-then-run sequencing, the streamed stages, the readiness handshake
// gate, failure classification, cancellation, boot adoption, and external
// stops. The runner bridge is faked; no real container is ever touched.

const runnerFake = vi.hoisted(() => ({
  exitHooks: [] as Array<(envId: string, code: number | null) => void>,
  probe: vi.fn(async (): Promise<{ rv: number }> => ({ rv: 2 })),
  detach: vi.fn(),
}));
vi.mock('../../src/main/runner', () => ({
  detach: runnerFake.detach,
  probe: runnerFake.probe,
  onRunnerExit: (cb: (envId: string, code: number | null) => void) => runnerFake.exitHooks.push(cb),
}));

import * as environments from '../../src/main/environments';
import { byKind } from '../../src/main/providers';

const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' });
const err = (stderr: string, code = 1): DockerResult => ({ code, stdout: '', stderr });

class FakeDocker {
  calls: Array<{ args: string[]; opts?: DockerOptions }> = [];
  containers = new Map<string, 'running' | 'stopped'>();
  images = new Set<string>();
  /** What the container has installed, by package name (absent = missing). */
  installed = new Map<string, string | null>();
  /** Pins a scripted `npm install` leaves untouched (simulates an install that did not take). */
  stubborn = new Set<string>();
  daemonUp = true;
  pullLines = ['a1b2: Pulling fs layer', 'a1b2: Downloading [==>   ]  2MB/9MB\ra1b2: Download complete', 'Status: Downloaded newer image'];
  fail: Partial<Record<string, DockerResult>> = {};
  /** Hold this command until release() (or the caller's abort signal). */
  hold: string | null = null;
  private release: (() => void) | null = null;

  releaseHeld(): void {
    this.release?.();
    this.release = null;
  }

  /** Every pin present at its expected version (an already-provisioned container). */
  provisioned(): void {
    this.installed = new Map(expectedPackages(byKind('harness')).map((p) => [p.name, p.version]));
  }

  argv(): string[][] {
    return this.calls.map((c) => c.args);
  }

  keyOf(args: string[]): string {
    return args[0] === 'image' ? 'image inspect' : args[0];
  }

  run = async (args: string[], opts?: DockerOptions): Promise<DockerResult> => {
    const key = this.keyOf(args);
    this.calls.push({ args, opts });
    // A pull streams its layer lines before (possibly) being held, like the real CLI.
    if (key === 'pull' && !this.fail.pull) for (const line of this.pullLines) opts?.onOutput?.(line);
    if (this.hold === key) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
        opts?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      if (opts?.signal?.aborted) return { code: null, stdout: '', stderr: 'cancelled', aborted: true };
    }
    if (this.fail[key]) return this.fail[key] as DockerResult;
    switch (key) {
      case 'info':
        return this.daemonUp ? ok('27.1.0') : err('Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
      case 'inspect': {
        const state = this.containers.get(args[3]);
        return state ? ok(state === 'running' ? 'true' : 'false') : err('Error: No such object');
      }
      case 'image inspect':
        return this.images.has(args[4]) ? ok('sha256:deadbeef') : err('Error: No such image');
      case 'pull':
        this.images.add(args[1]);
        return ok('');
      case 'build':
        this.images.add(args[2]);
        return ok('');
      case 'run':
        this.containers.set(args[args.indexOf('--name') + 1], 'running');
        return ok('');
      case 'start':
        this.containers.set(args[1], 'running');
        return ok('');
      case 'stop':
        if (this.containers.has(args[1])) this.containers.set(args[1], 'stopped');
        return ok('');
      case 'rm':
        this.containers.delete(args[2]);
        return ok('');
      case 'exec': {
        if (args[2] === 'cat') return err('No such file');
        if (args[2] !== 'sh') return ok('');
        const script = args[4];
        const pins = expectedPackages(byKind('harness'));
        if (script.includes('echo "')) {
          // The verify script: one "<name> <version|missing>" line per pin.
          return ok(pins.map((p) => `${p.name} ${this.installed.get(p.name) ?? 'missing'}`).join('\n'));
        }
        if (script.startsWith('npm install')) {
          // An install brings every named pin to its version (unless stubborn) and streams a line.
          for (const p of pins) {
            if (script.includes(pinnedSpec(p)) && !this.stubborn.has(p.name)) this.installed.set(p.name, p.version);
          }
          opts?.onOutput?.('added 2 packages in 30s');
          return ok('');
        }
        if (script.includes('/package.json')) {
          // A check chain: exit 0 only when every pin of its kind is at its version.
          const kind = script.includes('npm root -g') ? 'cli' : 'sdk';
          const upToDate = pins.filter((p) => p.kind === kind).every((p) => this.installed.get(p.name) === p.version);
          return upToDate ? ok('') : err('', 1);
        }
        return ok('');
      }
      default:
        return ok('');
    }
  };
}

let fake: FakeDocker;
const events: EnvLifecycleEvent[] = [];
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-ws-'));
const ADOPTED = 'adopted-env';

const stagesOf = (envId: string): EnvStage[] =>
  events.filter((e) => e.envId === envId && e.status === 'starting' && e.stage).reduce<EnvStage[]>((acc, e) => {
    if (acc[acc.length - 1] !== e.stage) acc.push(e.stage as EnvStage);
    return acc;
  }, []);
const statusesOf = (envId: string): string[] =>
  events.filter((e) => e.envId === envId).reduce<string[]>((acc, e) => {
    if (acc[acc.length - 1] !== e.status) acc.push(e.status);
    return acc;
  }, []);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function settled(envId: string): Promise<void> {
  while (environments.isOperating(envId)) await tick();
}
async function createEnv(name: string, over: Partial<Parameters<typeof environments.create>[0]> = {}): Promise<string> {
  const list = await environments.create({
    name,
    image: 'node:22-bookworm',
    workspacePath: workspace,
    autoInstall: true,
    dockerfile: '',
    envVars: { MY_VAR: 'v' },
    ...over,
  });
  return list[list.length - 1].id;
}

beforeAll(() => {
  // A container left running by a previous app session, seeded BEFORE the
  // store is first read so boot reconciliation sees it.
  fs.writeFileSync(
    path.join(app.getPath('userData'), 'puck-environments.json'),
    JSON.stringify({
      environments: [
        { id: ADOPTED, name: 'adopted', image: 'node:22-bookworm', workspacePath: workspace, autoInstall: true, dockerfile: '', envVars: {} },
      ],
      activeEnvId: ADOPTED,
    }),
  );
  fake = new FakeDocker();
  fake.provisioned(); // the adopted container was fully provisioned by the previous session
  fake.containers.set(environments.containerName(ADOPTED), 'running');
  useDockerRunner((args, opts) => fake.run(args, opts));
  environments.onLifecycle((ev) => events.push(ev));
});

beforeEach(() => {
  runnerFake.probe.mockReset();
  runnerFake.probe.mockResolvedValue({ rv: 2 });
});

afterEach(() => {
  fake.fail = {};
  fake.hold = null;
  fake.provisioned();
  fake.stubborn.clear();
  fake.daemonUp = true;
  events.length = 0;
  fake.calls.length = 0;
});

describe('boot reconciliation', () => {
  it('a container running before boot is re-provisioned and becomes ready only after the handshake', async () => {
    const first = await environments.list();
    const adopted = first.find((e) => e.id === ADOPTED);
    expect(adopted?.status).toBe('starting'); // never "ready" on Docker liveness alone
    await settled(ADOPTED);
    expect((await environments.lifecycle(ADOPTED)).status).toBe('ready');
    expect(runnerFake.probe).toHaveBeenCalledWith(ADOPTED);
    // No image pull or run for an existing container — straight to provisioning,
    // and no install either: the version checks passed.
    expect(fake.argv().some((a) => a[0] === 'pull' || a[0] === 'run')).toBe(false);
    expect(fake.argv().some((a) => a[0] === 'exec' && a[4]?.startsWith('npm install'))).toBe(false);
    expect(stagesOf(ADOPTED)).toEqual([
      'checking-image',
      'starting-container',
      'installing-clis',
      'installing-sdks',
      'verifying-packages',
      'deploying-runner',
      'injecting-credentials',
      'probing-runner',
    ]);
  });
});

describe('cold start: pull, then run, then provision, then handshake', () => {
  it('inspects the image, pulls it with streamed progress, and only then runs the container', async () => {
    const id = await createEnv('cold');
    const name = environments.containerName(id);
    fake.installed = new Map(); // a bare image: nothing installed yet
    events.length = 0;
    fake.calls.length = 0;
    const list = await environments.start(id);
    expect(list.find((e) => e.id === id)?.status).toBe('ready');

    // Machine-dependent credential copies (host ~/.claude, ~/.codex) are
    // filtered, as are the liveness probes the returned list() performs.
    const all = fake.calls.filter((c) => !c.args.some((s) => s.includes('/root/.')));
    const stable = all.slice(0, 14);
    expect(all.slice(14).every((c) => c.args[0] === 'inspect')).toBe(true);
    expect(stable.map((c) => fake.keyOf(c.args))).toEqual([
      'inspect', // container state
      'image inspect', // is the image local?
      'pull', // explicit pull, outside the run timeout
      'run',
      'exec', // mkdir /opt/puck
      'exec', // check CLI pins (fails: bare image)
      'exec', // install CLIs
      'exec', // check SDK pins
      'exec', // install SDKs
      'exec', // verify pins
      'cp', // runner.js
      'exec', // mkdir for secrets
      'cp', // secrets.json
      'exec', // chmod secrets
    ]);
    const pull = stable[2];
    const run = stable[3];
    expect(pull.args).toEqual(['pull', 'node:22-bookworm']);
    expect(pull.opts?.timeoutMs).toBe(environments.TIMEOUTS.provision);
    expect(run.opts?.timeoutMs).toBe(environments.TIMEOUTS.run);
    expect(run.opts?.onOutput).toBeUndefined();

    // The security-load-bearing argv: detached, labeled, workspace mounted at
    // /workspace, sandbox marker env, user env, `--` guarding the image name.
    expect(run.args.slice(0, 2)).toEqual(['run', '-d']);
    expect(run.args).toContain(name);
    expect(run.args.join(' ')).toContain(`-v ${workspace}:/workspace`);
    expect(run.args.join(' ')).toContain('-w /workspace');
    expect(run.args.join(' ')).toContain('-e IS_SANDBOX=1');
    expect(run.args.join(' ')).toContain('-e MY_VAR=v');
    const dashDash = run.args.indexOf('--');
    expect(run.args.slice(dashDash + 1)).toEqual(['node:22-bookworm', 'sleep', 'infinity']);

    // Bootstrap runs under a login shell: a read-only check, then the exact
    // pins when it fails; the install streams its output, the check does not.
    expect(stable[5].args.slice(0, 4)).toEqual(['exec', name, 'sh', '-lc']);
    expect(stable[5].args[4]).toContain('npm root -g');
    expect(stable[5].args[4]).not.toContain('npm install');
    expect(stable[5].opts?.onOutput).toBeUndefined();
    expect(stable[6].args[4]).toMatch(/^npm install -g @/);
    expect(stable[6].opts?.timeoutMs).toBe(environments.TIMEOUTS.provision);
    expect(stable[6].opts?.onOutput).toBeDefined();
    expect(stable[8].args[4]).toMatch(/^npm install --prefix \/opt\/puck @/);
    expect(stable[9].args[4]).toContain('echo "'); // verification is read-only
    expect(stable[9].args[4]).not.toContain('npm install');
    expect(stable[10].args[2]).toBe(`${name}:/opt/puck/runner.js`);
    expect(stable[12].args[2]).toBe(`${name}:/opt/puck/secrets.json`);

    // Streamed lifecycle: every stage in order, pull output sanitized into detail.
    expect(stagesOf(id)).toEqual([
      'checking-image',
      'pulling-image',
      'starting-container',
      'installing-clis',
      'installing-sdks',
      'verifying-packages',
      'deploying-runner',
      'injecting-credentials',
      'probing-runner',
    ]);
    expect(statusesOf(id)).toEqual(['starting', 'ready']);
    const final = events[events.length - 1];
    expect(final).toMatchObject({ envId: id, status: 'ready', stage: null, error: null });
    expect(final.startedAt).not.toBeNull();
    expect(final.endedAt).not.toBeNull();
    expect(runnerFake.probe).toHaveBeenCalledWith(id);
  });

  it('skips the pull when the image is local and the installs when the pins already match', async () => {
    const id = await createEnv('warm');
    fake.images.add('node:22-bookworm');
    fake.calls.length = 0;
    await environments.start(id);
    expect(fake.argv().some((a) => a[0] === 'pull')).toBe(false);
    expect(fake.argv().filter((a) => a[0] === 'run')).toHaveLength(1);
    expect(fake.argv().some((a) => a[0] === 'exec' && a[4]?.startsWith('npm install'))).toBe(false);
  });

  it('pull output reaches subscribers as one coalesced, sanitized detail line', async () => {
    const id = await createEnv('detail');
    fake.images.delete('node:22-bookworm');
    fake.hold = 'pull'; // a real pull takes seconds; the lines arrive while it runs
    const starting = environments.start(id);
    while (!fake.argv().some((a) => a[0] === 'pull')) await tick();
    await new Promise((r) => setTimeout(r, 150)); // past the 120ms coalesce window
    const details = events.filter((e) => e.envId === id && e.stage === 'pulling-image').map((e) => e.detail);
    expect(details[0]).toBe('docker pull node:22-bookworm'); // the stage announcement
    expect(details[details.length - 1]).toBe('Status: Downloaded newer image'); // ONE emit for three lines
    expect(details).toHaveLength(2);
    expect(details.every((d) => !d.includes('\r'))).toBe(true);
    fake.releaseHeld();
    await starting;
  });
});

describe('failures keep their stage and classify the cause', () => {
  it('a pull failure fails at pulling-image, names docker pull, and does not blame the daemon', async () => {
    const id = await createEnv('pullfail');
    fake.images.delete('node:22-bookworm');
    fake.fail.pull = err('Error response from daemon: manifest for node:22-bookworm not found', 1);
    await expect(environments.start(id)).rejects.toThrow(/docker pull failed while pulling image: .*manifest/);
    const lc = await environments.lifecycle(id);
    expect(lc.status).toBe('failed');
    expect(lc.stage).toBe('pulling-image');
    expect(lc.error).not.toMatch(/is Docker running/);
    expect(fake.argv().some((a) => a[0] === 'run')).toBe(false); // run never attempted
    expect(fake.argv().some((a) => a[0] === 'info')).toBe(true); // the daemon WAS checked
  });

  it('"is Docker running?" appears only when the daemon health check fails', async () => {
    const id = await createEnv('daemon-down');
    fake.images.add('node:22-bookworm');
    fake.daemonUp = false;
    fake.fail.run = err('Cannot connect to the Docker daemon', 125);
    await expect(environments.start(id)).rejects.toThrow(/docker run failed while starting container: Docker is not responding .* is Docker running\?/);
    expect((await environments.lifecycle(id)).stage).toBe('starting-container');
  });

  it('a run timeout reports the operation, stage, and what the probes found', async () => {
    const id = await createEnv('run-timeout');
    fake.images.add('node:22-bookworm');
    fake.fail.run = { code: null, stdout: '', stderr: 'docker run timed out after 60s', timedOut: true };
    await expect(environments.start(id)).rejects.toThrow(
      'docker run timed out after 60s while starting container. Docker 27.1.0 is responding; the image is local; no container was created.',
    );
  });

  it('a version mismatch after install fails at verifying-packages with names and versions', async () => {
    const id = await createEnv('drift');
    fake.images.add('node:22-bookworm');
    const [firstCli] = expectedPackages(byKind('harness')).filter((p) => p.kind === 'cli');
    fake.installed.set(firstCli.name, '0.0.1'); // drifted…
    fake.stubborn.add(firstCli.name); // …and the install does not correct it
    await expect(environments.start(id)).rejects.toThrow(
      new RegExp(`verification failed: ${firstCli.name.replace('/', '\\/')} is 0\\.0\\.1 globally, expected ${firstCli.version.replace(/\\./g, '\\.')}`),
    );
    const lc = await environments.lifecycle(id);
    expect(lc).toMatchObject({ status: 'failed', stage: 'verifying-packages' });
    expect(fake.argv().some((a) => a[0] === 'exec' && a[4]?.startsWith('npm install -g'))).toBe(true); // it did try
    expect(runnerFake.probe).not.toHaveBeenCalled();
  });

  it('with auto-install off, a missing SDK fails setup but a missing CLI is only a note', async () => {
    const id = await createEnv('user-managed', { autoInstall: false });
    fake.images.add('node:22-bookworm');
    const expected = expectedPackages(byKind('harness'));
    fake.installed = new Map(expected.map((p) => [p.name, p.kind === 'cli' ? null : p.version]));
    await environments.start(id); // CLIs missing → notes only
    expect(fake.argv().some((a) => a[0] === 'exec' && a[4]?.includes('npm install'))).toBe(false);
    expect((await environments.lifecycle(id)).status).toBe('ready');

    const [sdk] = expected.filter((p) => p.kind === 'sdk');
    fake.installed.set(sdk.name, null);
    await expect(environments.restart(id)).rejects.toThrow(new RegExp(`${sdk.name.replace('/', '\\/')} is not installed under /opt/puck`));
    expect((await environments.lifecycle(id)).error).toMatch(/Auto-install is off/);
  });

  it('a failed runner handshake fails at probing-runner with the runner diagnostics', async () => {
    const id = await createEnv('no-handshake');
    fake.images.add('node:22-bookworm');
    runnerFake.probe.mockRejectedValue(new Error("Runner handshake failed: runner process exited (code 1)\nContainer stderr:\nCannot find module '@openai/codex-sdk'"));
    await expect(environments.start(id)).rejects.toThrow(/Cannot find module/);
    expect((await environments.lifecycle(id))).toMatchObject({ status: 'failed', stage: 'probing-runner' });
  });
});

describe('stop during start, stops, and external changes', () => {
  it('Stop while pulling cancels the start: stopping → stopped, never failed', async () => {
    const id = await createEnv('cancel');
    fake.images.delete('node:22-bookworm');
    fake.hold = 'pull';
    const starting = environments.start(id);
    starting.catch(() => undefined);
    while (!fake.argv().some((a) => a[0] === 'pull')) await tick();
    const stopping = environments.stop(id);
    expect((await environments.list()).find((e) => e.id === id)?.status).toBe('stopping'); // instant feedback
    await expect(starting).rejects.toThrow(/Start of "cancel" was cancelled/);
    const list = await stopping;
    expect(list.find((e) => e.id === id)?.status).toBe('stopped');
    expect(statusesOf(id)).toEqual(['starting', 'stopping', 'stopped']);
    expect(fake.argv().some((a) => a[0] === 'run')).toBe(false);
  });

  it('stop: stopping (adopting credentials, docker stop) → stopped; the runner is detached first', async () => {
    const id = await createEnv('stop');
    fake.images.add('node:22-bookworm');
    await environments.start(id);
    events.length = 0;
    runnerFake.detach.mockClear();
    await environments.stop(id);
    expect(runnerFake.detach).toHaveBeenCalledWith(id);
    expect(statusesOf(id)).toEqual(['stopping', 'stopped']);
    const keys = fake.argv().map((a) => (a[0] === 'exec' && a[2] === 'cat' ? 'cat' : a[0]));
    // Rotated credentials are adopted (cat) before the container goes away (stop).
    expect(keys.indexOf('cat')).toBeGreaterThan(-1);
    expect(keys.indexOf('cat')).toBeLessThan(keys.indexOf('stop'));
    expect(fake.argv().some((a) => a[0] === 'stop' && a[1] === environments.containerName(id))).toBe(true);
  });

  it('rebuild: stopping → removing-container → starting (with build) → ready, resetting resume ids', async () => {
    const id = await createEnv('rebuild', { dockerfile: 'FROM node:22-bookworm\nRUN true' });
    const resets: string[] = [];
    environments.onEnvReset((envId) => resets.push(envId));
    await environments.start(id);
    events.length = 0;
    fake.calls.length = 0;
    await environments.rebuild(id);
    expect(resets).toContain(id);
    expect(statusesOf(id)).toEqual(['stopping', 'starting', 'ready']);
    expect(events.some((e) => e.stage === 'removing-container')).toBe(true);
    const keys = fake.argv().map((a) => fake.keyOf(a));
    expect(keys.indexOf('rm')).toBeLessThan(keys.indexOf('build'));
    expect(keys.indexOf('build')).toBeLessThan(keys.indexOf('run'));
    expect(keys).not.toContain('pull'); // the build pulls its own base image
    expect(stagesOf(id)).toContain('building-image');
  });

  it('a ready environment whose container vanished is demoted to stopped on the next list()', async () => {
    const id = await createEnv('vanish');
    fake.images.add('node:22-bookworm');
    await environments.start(id);
    fake.containers.delete(environments.containerName(id));
    const info = (await environments.list()).find((e) => e.id === id);
    expect(info?.status).toBe('stopped');
    expect(info?.detail).toBe('container stopped outside Puck');
  });

  it('a runner that dies under a ready environment fails it (container alive) or demotes it (container gone)', async () => {
    const id = await createEnv('runner-death');
    fake.images.add('node:22-bookworm');
    await environments.start(id);
    expect(environments.isOperating(id)).toBe(false); // bookkeeping settled with the op
    for (const hook of runnerFake.exitHooks) hook(id, 1);
    await tick();
    await tick();
    const failed = await environments.lifecycle(id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/Runner exited unexpectedly \(code 1\)/);

    await environments.start(id);
    fake.containers.set(environments.containerName(id), 'stopped');
    for (const hook of runnerFake.exitHooks) hook(id, 137);
    await tick();
    await tick();
    expect((await environments.lifecycle(id)).status).toBe('stopped');
  });

  it('explainDisconnect names the lifecycle operation that detached the runner', async () => {
    const id = await createEnv('explain');
    fake.images.add('node:22-bookworm');
    await environments.start(id);
    expect(environments.explainDisconnect(id)).toBeNull();
    fake.hold = 'stop';
    const stopping = environments.stop(id);
    while (!fake.argv().some((a) => a[0] === 'stop')) await tick();
    expect(environments.explainDisconnect(id)).toBe('Environment "explain" is stopping.');
    fake.releaseHeld();
    await stopping;
    expect(environments.explainDisconnect(id)).toBeNull();
  });

  it('the chat gate state (lifecycle) is what status consumers read, not Docker liveness', async () => {
    const id = await createEnv('gate');
    fake.containers.set(environments.containerName(id), 'running'); // Docker says running…
    expect((await environments.lifecycle(id)).status).toBe('stopped'); // …Puck says not ready
  });
});
