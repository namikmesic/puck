import { describe, expect, it } from 'vitest';
import type { DockerOptions, DockerResult } from '../../src/puck-runner/docker/client';
import { createArchive, DockerOps, parseLabels, rebuildArchive } from '../../src/puck-runner/docker/ops';
import type { InstanceStage } from '../../src/harness/runner-protocol';

// Every Docker command the runner runs for an environment, as argv, against
// a recording runner: the create flags (init, restart policy,
// no-new-privileges, labels, both volumes, resources, only non-secret -e),
// the copy-in tar, start, stop, rebuild and delete, and rediscovery by label.

const ENV = 'env_01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const BUNDLE_SHA = 'a'.repeat(64);

interface Call {
  args: string[];
  input?: DockerOptions['input'];
  timeoutMs?: number;
}

function recorder(answer: (args: string[]) => Partial<DockerResult> = () => ({})) {
  const calls: Call[] = [];
  const run = async (args: string[], opts: DockerOptions = {}): Promise<DockerResult> => {
    calls.push({ args, input: opts.input, timeoutMs: opts.timeoutMs });
    return { code: 0, stdout: '', stderr: '', ...answer(args) };
  };
  return { calls, run, argv: () => calls.map((c) => c.args.join(' ')) };
}

/** The entries of a tar (name, mode, uid, gid, body) in order. */
function entries(archive: Buffer): { name: string; mode: number; uid: number; gid: number; body: string }[] {
  const out = [];
  for (let at = 0; at + 512 <= archive.length; ) {
    const h = archive.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const str = (o: number, l: number) => h.subarray(o, o + l).toString().replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12), 8);
    const prefix = str(345, 155);
    const name = (prefix ? `${prefix}/` : '') + str(0, 100);
    out.push({ name, mode: parseInt(str(100, 8), 8), uid: parseInt(str(108, 8), 8), gid: parseInt(str(116, 8), 8), body: archive.subarray(at + 512, at + 512 + size).toString() });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const instance = { envId: ENV, name: 'Example', pin: { kind: 'tag', name: 'v1', sha: 'abc1234' }, definition: { name: 'example', repos: [] } };
const grant = { owner: 'octo', installationId: 42, repos: ['octo/app'], token: 'ghs_tokenvalue1234', expiresAt: 4102444800000 };

describe('runner docker ops: argv', () => {
  it('creates an environment: pull when missing, two labelled volumes, a hardened container, copy-in, start', async () => {
    const r = recorder((args) => (args[0] === 'image' && args[1] === 'inspect' ? { code: 1, stderr: 'No such image' } : {}));
    const stages: InstanceStage[] = [];
    await new DockerOps(r.run).create(
      {
        envId: ENV,
        image: 'node:22-bookworm',
        bundleSha: BUNDLE_SHA,
        resources: { cpus: 2, memory: '4g' },
        containerEnv: { PUCK_SKIP_PACKAGES: '1', NODE_ENV: 'test' },
      },
      { bundle: Buffer.from('// puckd'), inbox: { instance, secrets: { NPM_TOKEN: 'npm_secret' }, harness: [{ id: 'claude-code', content: '{"x":1}' }] }, github: [grant] },
      (s) => stages.push(s),
    );
    expect(r.argv()).toEqual([
      'image inspect --format {{.Id}} node:22-bookworm',
      'pull node:22-bookworm',
      `volume create --label puck=instance --label puck.env=${ENV} puck-${ENV}-data`,
      `volume create --label puck=instance --label puck.env=${ENV} puck-${ENV}-ws`,
      [
        'create',
        `--name puck-${ENV}`,
        '--init',
        '--restart unless-stopped',
        '--security-opt no-new-privileges:true',
        '--label puck=instance',
        `--label puck.env=${ENV}`,
        '--label puck.definition=example',
        `-v puck-${ENV}-data:/puck`,
        `-v puck-${ENV}-ws:/workspace`,
        '-w /workspace',
        '--cpus 2',
        '--memory 4g',
        '-e PUCK_SKIP_PACKAGES=1',
        '-e NODE_ENV=test',
        'node:22-bookworm node /opt/puck/puckd.js serve',
      ].join(' '),
      `cp - puck-${ENV}:/`,
      `start puck-${ENV}`,
    ]);
    expect(stages).toEqual(['checking-image', 'pulling-image', 'creating-volumes', 'creating-container', 'copying-files', 'starting-container']);
    // Secrets and tokens reach the container only through the tar stream, never argv.
    const all = r.argv().join('\n');
    expect(all).not.toContain('npm_secret');
    expect(all).not.toContain('ghs_tokenvalue1234');
    expect(all).not.toMatch(/-v \//);
    expect(all).not.toContain('docker.sock');
    const copy = r.calls.find((c) => c.args[0] === 'cp');
    expect(Buffer.isBuffer(copy?.input)).toBe(true);
    const files = entries(copy?.input as Buffer);
    expect(files.map((f) => [f.name, f.mode.toString(8), f.uid, f.gid])).toEqual([
      ['opt/puck/', '755', 0, 0],
      ['opt/puck/puckd.js', '644', 0, 0],
      ['puck/inbox/', '700', 0, 0],
      ['puck/inbox/instance.json', '600', 0, 0],
      ['puck/inbox/github.json', '600', 0, 0],
      ['puck/inbox/secrets.json', '600', 0, 0],
      ['puck/inbox/harness-claude-code.json', '600', 0, 0],
    ]);
    expect(JSON.parse(files[4].body)).toEqual({ grants: [grant] });
    expect(JSON.parse(files[5].body)).toEqual({ values: { NPM_TOKEN: 'npm_secret' } });
    expect(files[6].body).toBe('{"x":1}');
  });

  it('builds a Dockerfile from stdin into a lowercase image tag, with no host temp directory', async () => {
    const r = recorder();
    await new DockerOps(r.run).image({ envId: ENV, dockerfile: 'FROM node:22\n', bundleSha: BUNDLE_SHA }, () => undefined);
    expect(r.argv()).toEqual([`build -t puck-img-${ENV.toLowerCase()} -`]);
    expect(r.calls[0].input).toBe('FROM node:22\n');
  });

  it('removes the container again when copy-in fails, keeping the volumes', async () => {
    const r = recorder((args) => (args[0] === 'cp' ? { code: 1, stderr: 'no space left on device' } : {}));
    await expect(
      new DockerOps(r.run).create({ envId: ENV, image: 'img', bundleSha: BUNDLE_SHA }, { bundle: Buffer.from('x'), inbox: { instance }, github: [] }, () => undefined),
    ).rejects.toThrow(/Copying files into the container: no space left on device/);
    expect(r.argv().slice(-2)).toEqual([`cp - puck-${ENV}:/`, `rm -f puck-${ENV}`]);
  });

  it('starts, stops with a 30 s grace, and stages a daemon upgrade', async () => {
    const r = recorder();
    const ops = new DockerOps(r.run);
    await ops.start(ENV);
    await ops.stop(ENV);
    await ops.stageDaemon(ENV, Buffer.from('// next'));
    expect(r.argv()).toEqual([`start puck-${ENV}`, `stop -t 30 puck-${ENV}`, `cp - puck-${ENV}:/`]);
    expect(entries(r.calls[2].input as Buffer).map((e) => [e.name, e.mode.toString(8)])).toEqual([['opt/puck/puckd.next.js', '644']]);
  });

  it('rebuilds on the same volumes with the bundle and the new definition', async () => {
    const r = recorder((args) => (args[1] === 'inspect' && args[0] === 'container' ? { stdout: 'running\n' } : {}));
    await new DockerOps(r.run).rebuild({ envId: ENV, image: 'img:2', bundleSha: BUNDLE_SHA }, { bundle: Buffer.from('// b'), instance }, () => undefined);
    const argv = r.argv();
    expect(argv[0]).toBe('image inspect --format {{.Id}} img:2');
    expect(argv.slice(1, 4)).toEqual([`container inspect --format {{.State.Status}} puck-${ENV}`, `stop -t 30 puck-${ENV}`, `rm -f puck-${ENV}`]);
    expect(argv[4]).toContain(`-v puck-${ENV}-data:/puck -v puck-${ENV}-ws:/workspace`);
    expect(argv.slice(5)).toEqual([`cp - puck-${ENV}:/`, `start puck-${ENV}`]);
    expect(argv.join('\n')).not.toContain('volume create');
    expect(entries(r.calls[5].input as Buffer).map((e) => e.name)).toEqual(['opt/puck/', 'opt/puck/puckd.js', 'puck/inbox/', 'puck/inbox/instance.json']);
  });

  it('deletes the container, both volumes and a built image, tolerating ones already gone', async () => {
    const r = recorder((args) => (args[0] === 'image' ? { code: 1, stderr: 'Error: No such image: puck-img-x' } : {}));
    await new DockerOps(r.run).delete(ENV, () => undefined);
    expect(r.argv()).toEqual([
      `rm -f puck-${ENV}`,
      `volume rm -f puck-${ENV}-data`,
      `volume rm -f puck-${ENV}-ws`,
      `image rm puck-img-${ENV.toLowerCase()}`,
    ]);
  });

  it('rediscovers environments by the puck=instance label only', async () => {
    const rows = [
      { Names: `puck-${ENV}`, State: 'running', Image: 'node:22', Labels: `puck=instance,puck.env=${ENV},puck.definition=example` },
      { Names: 'stray', State: 'exited', Image: 'x', Labels: 'puck=instance' },
    ];
    const r = recorder(() => ({ stdout: rows.map((x) => JSON.stringify(x)).join('\n') + '\n' }));
    const list = await new DockerOps(r.run).list();
    expect(r.argv()).toEqual(['ps -a --filter label=puck=instance --format {{json .}}']);
    expect(list).toEqual([{ envId: ENV, container: `puck-${ENV}`, state: 'running', definition: 'example', image: 'node:22' }]);
  });

  it('reads a missing container as null and other inspect failures as errors', async () => {
    const gone = recorder(() => ({ code: 1, stderr: 'Error: No such container: puck-x' }));
    expect(await new DockerOps(gone.run).state(ENV)).toBeNull();
    const down = recorder(() => ({ code: 1, stderr: 'Cannot connect to the Docker daemon' }));
    await expect(new DockerOps(down.run).state(ENV)).rejects.toThrow(/Cannot connect/);
  });

  it('parses docker ps label lists', () => {
    expect(parseLabels('a=b,puck.env=env_1,empty=')).toEqual({ a: 'b', 'puck.env': 'env_1', empty: '' });
  });

  it('leaves optional inbox files out when there is nothing to deliver', () => {
    expect(entries(createArchive(Buffer.from('b'), { instance }, [])).map((e) => e.name)).toEqual([
      'opt/puck/',
      'opt/puck/puckd.js',
      'puck/inbox/',
      'puck/inbox/instance.json',
    ]);
    expect(entries(rebuildArchive(Buffer.from('b'), instance)).length).toBe(4);
  });
});
