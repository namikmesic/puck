/**
 * The This Mac runner install and uninstall, against the real Puck server
 * (fake GitHub) serving a runner release, with the runner's own commands
 * recorded instead of run: download and sha256 check, unpack, register
 * with a token read from a 0600 file (then revoked), LaunchAgent install
 * and start; uninstall keeps the environments and removes the directory.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as thisMac from '../../src/main/runners/this-mac';
import { localRunner, setLocalRunner } from '../../src/main/runners/store';
import { useServerDeps } from '../../src/main/server/http';
import { account, current, signInPending, startSignIn } from '../../src/main/server/session';
import { call, startLiveServer } from './server-fakes';

type Live = Awaited<ReturnType<typeof startLiveServer>>;
let h: Live;
let data: string;
let downloads: string;
const RUNNER_ID = 'rnr_01J8Z3X0000000000000000002';
const TARBALL = 'puck-runner-macos-arm64-0.1.0.tar.gz';

interface Call {
  file: string;
  args: string[];
}

function fakeExec(calls: Call[], opts: { failConfig?: string } = {}): thisMac.Exec {
  return async (file, args) => {
    calls.push({ file, args });
    const dir = path.join(data, 'runner');
    if (file === '/usr/bin/tar') {
      fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
    }
    const [, command, ...rest] = args;
    if (command === 'config' && rest[0] !== 'remove') {
      if (opts.failConfig) return { code: 1, stdout: '', stderr: opts.failConfig };
      const tokenFile = rest[rest.indexOf('--token-file') + 1];
      expect(fs.readFileSync(tokenFile, 'utf8')).toMatch(/^PRT_/);
      expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
      fs.writeFileSync(path.join(dir, '.runner'), JSON.stringify({ runnerId: RUNNER_ID }));
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

async function signIn(): Promise<void> {
  useServerDeps({
    openExternal: async (authorizeUrl) => {
      const u = new URL(h.github.approve(authorizeUrl, 'octo'));
      const cb = await fetch(h.base + u.pathname + u.search, { redirect: 'manual' });
      await fetch(cb.headers.get('location') as string);
    },
  }, h.base);
  await startSignIn();
  for (let i = 0; i < 400 && (!current() || signInPending()); i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-mac-'));
  downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-dl-'));
  fs.mkdirSync(path.join(downloads, '0.1.0'));
  fs.writeFileSync(path.join(downloads, '0.1.0', TARBALL), 'tarball bytes');
  h = await startLiveServer({ PUCK_RUNNER_DOWNLOADS: downloads });
  h.github.addUser('octo');
  await signIn();
});

afterEach(async () => {
  await account.logout();
  setLocalRunner(null);
  thisMac.useThisMacDeps(null);
  useServerDeps(null);
  await h.close();
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(downloads, { recursive: true, force: true });
});

describe('This Mac runner', () => {
  it('downloads, checks, unpacks, registers, and starts the LaunchAgent', async () => {
    const calls: Call[] = [];
    thisMac.useThisMacDeps({ exec: fakeExec(calls), platform: 'darwin', arch: 'arm64', hostname: () => 'feynman-mbp.local', dataDir: () => data, waitForSocket: async () => undefined });
    const record = await thisMac.install([]);
    const dir = path.join(data, 'runner');
    const node = path.join(dir, 'bin', 'node');
    const bundle = path.join(dir, 'bin', 'puck-runner.js');
    expect(record).toEqual({ runnerId: RUNNER_ID, dir, socket: path.join(dir, 'local.sock') });
    expect(localRunner()).toEqual(record);
    expect(calls[0]).toEqual({ file: '/usr/bin/tar', args: ['-xzf', path.join(dir, TARBALL), '-C', dir] });
    const config = calls[1];
    expect(config.file).toBe(node);
    expect(config.args.slice(0, 3)).toEqual([bundle, 'config', '--unattended']);
    expect(config.args).toEqual(expect.arrayContaining(['--url', h.base, '--name', 'This Mac (feynman-mbp)', '--labels', 'local', '--local-socket', path.join(dir, 'local.sock')]));
    expect(config.args).not.toContain('--replace');
    expect(config.args.join(' ')).not.toMatch(/PRT_/); // the token travels in a file, never argv
    expect(calls.slice(2).map((c) => c.args.slice(1))).toEqual([
      ['svc', 'install'],
      ['svc', 'start'],
    ]);
    // Nothing secret or temporary is left behind, and the token is revoked.
    expect(fs.existsSync(path.join(dir, '.registration-token'))).toBe(false);
    expect(fs.existsSync(path.join(dir, TARBALL))).toBe(false);
    const audit = await call(h, 'GET', '/v1/audit', { token: current()?.accessToken });
    expect(JSON.stringify(audit.body)).toContain('runner.registration-token');
    expect(thisMac.localState()).toMatchObject({ installed: true, runnerId: RUNNER_ID, busy: null, error: null });
  });

  it('replaces a stale registration of the same name', async () => {
    const calls: Call[] = [];
    thisMac.useThisMacDeps({ exec: fakeExec(calls), platform: 'darwin', arch: 'arm64', hostname: () => 'mbp', dataDir: () => data, waitForSocket: async () => undefined });
    await thisMac.install([{ name: 'This Mac (mbp)' } as never]);
    expect(calls[1].args).toContain('--replace');
  });

  it('refuses a download that does not match its sha256 and leaves nothing behind', async () => {
    const calls: Call[] = [];
    thisMac.useThisMacDeps({ exec: fakeExec(calls), platform: 'darwin', arch: 'arm64', hostname: () => 'mbp', dataDir: () => data, waitForSocket: async () => undefined });
    const real = globalThis.fetch;
    useServerDeps(
      {
        fetch: async (url, init) => {
          const res = await real(url, init);
          return String(url).endsWith(TARBALL) ? new Response('tampered') : res;
        },
      },
      h.base,
    );
    await expect(thisMac.install([])).rejects.toThrow(/does not match its published sha256/);
    expect(calls).toEqual([]);
    expect(fs.existsSync(path.join(data, 'runner'))).toBe(false);
    expect(localRunner()).toBeNull();
    expect(thisMac.localState().error).toMatch(/sha256/);
    expect(createHash('sha256').update('tarball bytes').digest('hex')).toHaveLength(64);
  });

  it('cleans up when registration fails', async () => {
    const calls: Call[] = [];
    thisMac.useThisMacDeps({ exec: fakeExec(calls, { failConfig: 'Docker is not running on this machine.' }), platform: 'darwin', arch: 'arm64', hostname: () => 'mbp', dataDir: () => data, waitForSocket: async () => undefined });
    await expect(thisMac.install([])).rejects.toThrow(/Registering the runner failed: Docker is not running/);
    expect(fs.existsSync(path.join(data, 'runner'))).toBe(false);
    expect(localRunner()).toBeNull();
  });

  it('needs macOS on Apple silicon', async () => {
    thisMac.useThisMacDeps({ exec: fakeExec([]), platform: 'linux', arch: 'x64', dataDir: () => data });
    expect(thisMac.supported()).toBe(false);
    await expect(thisMac.install([])).rejects.toThrow(/macOS on Apple silicon/);
  });

  it('uninstall deregisters keeping the environments, then removes the directory', async () => {
    const calls: Call[] = [];
    thisMac.useThisMacDeps({ exec: fakeExec(calls), platform: 'darwin', arch: 'arm64', hostname: () => 'mbp', dataDir: () => data, waitForSocket: async () => undefined });
    await thisMac.install([]);
    calls.length = 0;
    await thisMac.uninstall();
    expect(calls.map((c) => c.args.slice(1))).toEqual([['config', 'remove', '--unattended', '--keep-environments']]);
    expect(fs.existsSync(path.join(data, 'runner'))).toBe(false);
    expect(localRunner()).toBeNull();
    expect(thisMac.localState()).toMatchObject({ installed: false, runnerId: null });
  });

  it('names This Mac after the host, safely', () => {
    expect(thisMac.localName('Feynman’s MacBook.local')).toBe('This Mac (Feynman-s MacBook)');
    expect(thisMac.localName('...')).toBe('This Mac');
  });
});
