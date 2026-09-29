import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure, defaultName, parseLabels, parseMax, remove, type Io } from '../../src/puck-runner/configure';
import type { DockerResult } from '../../src/puck-runner/docker/client';
import { isConfigured, readConfig, readCredentials, runnerPaths, type RunnerPaths } from '../../src/puck-runner/files';
import { call, signIn, startServer, type Harness, type SignedIn } from './server-fakes';

// ./config.sh and ./config.sh remove against the real Puck server, with
// Docker faked: the Docker check, the prompts, the key and registration
// files and their modes, and removal keeping or deleting environments.

const ENV = 'env_01J9ZZZZZZZZZZZZZZZZZZZZZZ';
let dir: string;
let h: Harness;
let paths: RunnerPaths;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-config-'));
  paths = runnerPaths(path.join(dir, 'runner'));
  fs.mkdirSync(paths.root, { recursive: true });
  h = await startServer();
  h.github.addUser('octo');
});
afterEach(async () => {
  await h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function docker(opts: { info?: Partial<DockerResult>; containers?: string[] } = {}) {
  const calls: string[] = [];
  const run = async (args: string[]): Promise<DockerResult> => {
    calls.push(args.join(' '));
    if (args[0] === 'info') return { code: 0, stdout: JSON.stringify({ ServerVersion: '27.3.1', NCPU: 16, MemTotal: 67_000_000_000 }), stderr: '', ...opts.info };
    if (args[0] === 'ps') {
      const rows = (opts.containers ?? []).map((id) => JSON.stringify({ Names: `puck-${id}`, State: 'running', Image: 'x', Labels: `puck=instance,puck.env=${id},puck.definition=web` }));
      return { code: 0, stdout: rows.join('\n'), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

function io(answers: string[] = []): Io & { out: string[]; asked: string[] } {
  const out: string[] = [];
  const asked: string[] = [];
  return {
    out,
    asked,
    interactive: true,
    print: (l) => out.push(l),
    ask: async (q, fallback) => {
      asked.push(q);
      const a = answers.shift();
      return a === undefined || a === '' ? fallback : a;
    },
  };
}

async function token(session: SignedIn, kind: 'registration' | 'removal'): Promise<string> {
  return String((await call(h, 'POST', `/v1/runners/${kind}-token`, { token: session.accessToken })).body.token);
}

/** Routes the server's public URL (http://puck.test) to the test server. */
const routed = ((url: string | URL, init?: RequestInit) => fetch(String(url).replace('http://puck.test', h.base), init)) as typeof fetch;

describe('config.sh', { timeout: 20_000 }, () => {
  it('checks Docker, asks, generates the key first, registers, and writes the files with their modes', async () => {
    const session = await signIn(h, 'octo');
    const t = io(['', 'gpu, fast', '3']);
    await configure(
      { url: h.base, token: await token(session, 'registration'), unattended: false, replace: false, disableUpdate: false },
      { paths, docker: docker().run, io: t, version: '0.1.0', platform: { os: 'linux', arch: 'arm64' }, hostname: 'build-box.local' },
    );
    expect(t.asked).toEqual(['Runner name [build-box]: ', 'Additional labels, comma-separated [none]: ', 'Most environments this machine may host [no limit]: ']);
    expect(t.out[0]).toBe('Puck runner 0.1.0 (linux-arm64)');
    expect(t.out[2]).toBe('Docker 27.3.1, 16 CPUs, 62.4 GiB');
    expect(t.out.join('\n')).toMatch(/✓ Runner build-box \(rnr_\w+\) registered to @octo\. Key SHA256:/);
    const config = readConfig(paths);
    expect(config).toMatchObject({ name: 'build-box', serverUrl: 'http://puck.test', labels: ['linux', 'arm64', 'gpu', 'fast'], maxEnvironments: 3, owner: 'octo' });
    const creds = readCredentials(paths);
    expect(creds).toMatchObject({ runnerId: config.runnerId, keyFile: '.runner_key' });
    for (const [file, mode] of [[paths.config, 0o644], [paths.credentials, 0o600], [paths.key, 0o600]] as const) {
      expect(fs.statSync(file).mode & 0o777).toBe(mode);
    }
    expect(fs.readFileSync(paths.key, 'utf8')).toContain('BEGIN PRIVATE KEY');
    // The registration token is never written anywhere.
    const written = fs.readdirSync(paths.root).map((f) => fs.readFileSync(path.join(paths.root, f), 'utf8')).join('\n');
    expect(written).not.toMatch(/PRT_/);
    const listed = (await call(h, 'GET', '/v1/runners', { token: session.accessToken })).body.runners as { fingerprint: string; maxEnvironments: number }[];
    expect(listed[0]).toMatchObject({ fingerprint: creds.keyFingerprint, maxEnvironments: 3 });
  });

  it('refuses when Docker is not usable, when already configured, and with a bad token', async () => {
    const session = await signIn(h, 'octo');
    const base = { url: h.base, token: await token(session, 'registration'), unattended: true, replace: false, disableUpdate: false };
    const deps = { paths, io: io(), version: '0.1.0', platform: { os: 'linux' as const, arch: 'x64' as const } };
    const denied = docker({ info: { code: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket' } });
    await expect(configure(base, { ...deps, docker: denied.run })).rejects.toThrow(/usermod -aG docker/);
    expect(isConfigured(paths)).toBe(false);
    await expect(configure({ ...base, token: 'PRT_nottherealtokenatall' }, { ...deps, docker: docker().run })).rejects.toThrow(/unknown, revoked or expired/);
    expect(isConfigured(paths)).toBe(false);
    await configure(base, { ...deps, docker: docker().run });
    await expect(configure(base, { ...deps, docker: docker().run })).rejects.toThrow(/already configured/);
    expect(fs.existsSync(paths.key)).toBe(true);
  });

  it('treats a key with no .runner as not configured, and deletes it when registration or saving fails', async () => {
    const session = await signIn(h, 'octo');
    fs.writeFileSync(paths.key, 'orphan-key\n', { mode: 0o600 });
    fs.writeFileSync(paths.credentials, '{}\n', { mode: 0o600 });
    expect(isConfigured(paths)).toBe(false);
    const t = io();
    await configure(
      { url: h.base, token: await token(session, 'registration'), name: 'fresh', unattended: true, replace: false, disableUpdate: false },
      { paths, docker: docker().run, io: t, version: '0.1.0', platform: { os: 'linux', arch: 'x64' } },
    );
    expect(t.out.join('\n')).toMatch(/--replace/);
    expect(isConfigured(paths)).toBe(true);
    expect(fs.readFileSync(paths.key, 'utf8')).toContain('BEGIN PRIVATE KEY');
    expect(fs.readFileSync(paths.key, 'utf8')).not.toContain('orphan-key');

    const again = runnerPaths(path.join(dir, 'again'));
    fs.mkdirSync(again.root, { recursive: true });
    const reg = { url: h.base, token: await token(session, 'registration'), name: 'kept-name', unattended: true, replace: false, disableUpdate: false };
    const deps = { paths: again, io: io(), version: '0.1.0', platform: { os: 'linux' as const, arch: 'x64' as const }, docker: docker().run };
    await expect(configure({ ...reg, token: 'PRT_nottherealtokenatall' }, deps)).rejects.toThrow(/unknown, revoked or expired/);
    expect(fs.existsSync(again.key)).toBe(false);
    expect(fs.existsSync(again.credentials)).toBe(false);
    expect(fs.existsSync(again.config)).toBe(false);

    const readonly = path.join(again.root, 'readonly');
    fs.mkdirSync(readonly, { mode: 0o555 });
    const blocked = runnerPaths(again.root);
    blocked.config = path.join(readonly, '.runner');
    await expect(configure(reg, { ...deps, paths: blocked })).rejects.toThrow(/--replace/);
    fs.chmodSync(readonly, 0o755);
    expect(fs.existsSync(again.key)).toBe(false);
    expect(fs.existsSync(again.credentials)).toBe(false);
    expect(isConfigured(again)).toBe(false);

    await expect(configure(reg, deps)).rejects.toThrow(/--replace/);
    expect(fs.existsSync(again.key)).toBe(false);
    await configure({ ...reg, replace: true }, deps);
    expect(isConfigured(again)).toBe(true);
    expect(readConfig(again).name).toBe('kept-name');
  });

  it('refuses when a registration finishes during the prompts and does not delete it', async () => {
    const session = await signIn(h, 'octo');
    const t = io(['box', 'gpu', '2']);
    const ask = t.ask.bind(t);
    t.ask = async (q, fallback) => {
      if (!fs.existsSync(paths.config)) {
        fs.writeFileSync(paths.config, `${JSON.stringify({ runnerId: 'rnr_finished', name: 'finished', serverUrl: 'http://puck.test' })}\n`);
        fs.writeFileSync(paths.key, 'finished-key\n', { mode: 0o600 });
        fs.writeFileSync(paths.credentials, `${JSON.stringify({ runnerId: 'rnr_finished', keyFile: '.runner_key', keyFingerprint: 'fp' })}\n`, { mode: 0o600 });
      }
      return ask(q, fallback);
    };
    await expect(
      configure(
        { url: h.base, token: await token(session, 'registration'), unattended: false, replace: false, disableUpdate: false },
        { paths, docker: docker().run, io: t, version: '0.1.0', platform: { os: 'linux', arch: 'x64' }, hostname: 'build-box' },
      ),
    ).rejects.toThrow(/already configured/);
    expect(t.asked).toEqual([
      'Runner name [build-box]: ',
      'Additional labels, comma-separated [none]: ',
      'Most environments this machine may host [no limit]: ',
    ]);
    expect(t.out.join('\n')).not.toMatch(/did not finish/);
    expect(fs.readFileSync(paths.config, 'utf8')).toContain('rnr_finished');
    expect(fs.readFileSync(paths.key, 'utf8')).toBe('finished-key\n');
    expect(fs.readFileSync(paths.credentials, 'utf8')).toContain('rnr_finished');
    expect((await call(h, 'GET', '/v1/runners', { token: session.accessToken })).body.runners).toEqual([]);
  });

  it('parses names, labels and limits the way the server accepts them', () => {
    expect(defaultName('Namiks-MacBook-Pro.local')).toBe('Namiks-MacBook-Pro');
    expect(defaultName('_weird host!')).toBe('weird host-');
    expect(parseLabels('GPU, fast,,gpu')).toEqual(['gpu', 'fast']);
    expect(() => parseLabels('no spaces')).toThrow();
    expect(parseMax('')).toBeNull();
    expect(parseMax('4')).toBe(4);
    expect(() => parseMax('0')).toThrow();
  });
});

describe('config.sh --local-socket', { timeout: 20_000 }, () => {
  it('records the socket for the app on this machine, and refuses a path unix sockets cannot hold', async () => {
    const session = await signIn(h, 'octo');
    const socket = path.join(dir, 'runner', 'local.sock');
    await configure(
      { url: h.base, token: await token(session, 'registration'), unattended: true, replace: false, disableUpdate: false, localSocket: socket, labels: 'local', serviceLabel: 'com.puck.runner.abcd1234', appBundleId: 'com.namikmesic.puck' },
      { paths, docker: docker().run, io: io(), version: '0.1.0', platform: { os: 'macos', arch: 'arm64' }, hostname: 'mbp' },
    );
    expect(readConfig(paths)).toMatchObject({ localSocket: socket, labels: ['macos', 'arm64', 'local'], serviceLabel: 'com.puck.runner.abcd1234', appBundleId: 'com.namikmesic.puck' });
    await expect(
      configure(
        { url: h.base, token: `PRT_${'a'.repeat(16)}`, unattended: true, replace: false, disableUpdate: false, appBundleId: 'not a bundle id' },
        { paths: runnerPaths(path.join(dir, 'bad-bundle')), docker: docker().run, io: io(), version: '0.1.0', platform: { os: 'macos', arch: 'arm64' }, hostname: 'mbp' },
      ),
    ).rejects.toThrow('--app-bundle-id must be a bundle identifier');

    const other = runnerPaths(path.join(dir, 'other'));
    await expect(
      configure(
        { url: h.base, token: await token(session, 'registration'), unattended: true, replace: false, disableUpdate: false, localSocket: `/${'x'.repeat(120)}.sock` },
        { paths: other, docker: docker().run, io: io(), version: '0.1.0', platform: { os: 'macos', arch: 'arm64' } },
      ),
    ).rejects.toThrow(/longer than 103 bytes/);
    expect(isConfigured(other)).toBe(false);

    const dotdot = runnerPaths(path.join(dir, 'dotdot'));
    await expect(
      configure(
        { url: h.base, token: await token(session, 'registration'), unattended: true, replace: false, disableUpdate: false, localSocket: `${dir}/unused/../local.sock` },
        { paths: dotdot, docker: docker().run, io: io(), version: '0.1.0', platform: { os: 'macos', arch: 'arm64' } },
      ),
    ).rejects.toThrow(/normalized/);
    expect(isConfigured(dotdot)).toBe(false);
    expect(fs.existsSync(`${dir}/unused`)).toBe(false);
  });

  it('reads older .runner files without the field as off', () => {
    fs.writeFileSync(paths.config, JSON.stringify({ runnerId: 'rnr_x', name: 'a', serverUrl: 'http://s' }));
    expect(readConfig(paths).localSocket).toBeNull();
  });
});

describe('config.sh remove', { timeout: 20_000 }, () => {
  async function registered(session: SignedIn) {
    await configure(
      { url: h.base, token: await token(session, 'registration'), unattended: true, replace: false, disableUpdate: false },
      { paths, docker: docker().run, io: io(), version: '0.1.0', platform: { os: 'linux', arch: 'x64' } },
    );
    return readConfig(paths);
  }

  it('keeps environments by default, deregisters with the removal token, and deletes the registration files', async () => {
    const session = await signIn(h, 'octo');
    const config = await registered(session);
    const d = docker({ containers: [ENV] });
    const t = io();
    t.interactive = false;
    await remove({ token: await token(session, 'removal'), unattended: false }, { paths, docker: d.run, io: t, fetch: routed, service: () => { throw new Error('no service'); } });
    expect(d.calls).toEqual(['ps -a --filter label=puck=instance --format {{json .}}']);
    expect(t.out.join('\n')).toContain('keeping them');
    expect(isConfigured(paths)).toBe(false);
    const runners = (await call(h, 'GET', '/v1/runners', { token: session.accessToken })).body.runners as unknown[];
    expect(runners).toEqual([]);
    expect(config.runnerId).toMatch(/^rnr_/);
  });

  it('asks, deletes the environments before deregistering, and can sign the removal with its own key', async () => {
    const session = await signIn(h, 'octo');
    await registered(session);
    const d = docker({ containers: [ENV] });
    const t = io(['maybe', 'delete']);
    await remove({ unattended: false }, { paths, docker: d.run, io: t, fetch: routed, now: () => h.clock.now(), service: () => { throw new Error('no service'); } });
    expect(t.asked).toHaveLength(2);
    expect(d.calls).toEqual([
      'ps -a --filter label=puck=instance --format {{json .}}',
      `rm -f puck-${ENV}`,
      `volume rm -f puck-${ENV}-data`,
      `volume rm -f puck-${ENV}-ws`,
      `image rm puck-img-${ENV.toLowerCase()}`,
    ]);
    expect(isConfigured(paths)).toBe(false);
    expect((await call(h, 'GET', '/v1/runners', { token: session.accessToken })).body.runners).toEqual([]);
  });

  it('finishes the local cleanup for a runner the server already removed', async () => {
    const session = await signIn(h, 'octo');
    const config = await registered(session);
    await call(h, 'DELETE', `/v1/runners/${config.runnerId}`, { token: session.accessToken });
    const t = io();
    await remove({ unattended: true }, { paths, docker: docker().run, io: t, fetch: routed, now: () => h.clock.now(), service: () => { throw new Error('no service'); } });
    expect(t.out.join('\n')).toContain('already removed');
    expect(isConfigured(paths)).toBe(false);
  });

  it('leaves the runner registered when deleting an environment fails', async () => {
    const session = await signIn(h, 'octo');
    await registered(session);
    const d = docker({ containers: [ENV] });
    const failing = async (args: string[]): Promise<DockerResult> =>
      args[0] === 'volume' ? { code: 1, stdout: '', stderr: 'volume is in use' } : d.run(args);
    await expect(
      remove({ token: await token(session, 'removal'), environments: 'delete', unattended: true }, { paths, docker: failing, io: io(), fetch: routed, service: () => { throw new Error('no service'); } }),
    ).rejects.toThrow(/volume is in use/);
    expect(isConfigured(paths)).toBe(true);
    expect(((await call(h, 'GET', '/v1/runners', { token: session.accessToken })).body.runners as unknown[]).length).toBe(1);
  });
});
