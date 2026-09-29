/**
 * The This Mac runner install and uninstall, against the real Puck server
 * (fake GitHub) serving a runner release, with the runner's own commands
 * recorded instead of run: download and sha256 check, unpack, register
 * with a token read from a 0600 file (then revoked), LaunchAgent install,
 * start and kickstart; uninstall keeps the environments and removes the
 * directory. An isolated launch refuses the install.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import forgeConfig from '../../forge.config';
import { launchdPlist, launcherPath } from '../../src/harness/launch-agent';
import * as thisMac from '../../src/main/runners/this-mac';
import { localRunner, setLocalRunner } from '../../src/main/runners/store';
import { useServerDeps } from '../../src/main/server/http';
import { account, current, signInPending, startSignIn } from '../../src/main/server/session';
import { call, startLiveServer } from './server-fakes';

type Live = Awaited<ReturnType<typeof startLiveServer>>;
let h: Live;
let data: string;
let downloads: string;
let login = 'octo';
const RUNNER_ID = 'rnr_01J8Z3X0000000000000000002';
const TARBALL = 'puck-runner-macos-arm64-0.1.0.tar.gz';

interface Call {
  file: string;
  args: string[];
}

function fakeExec(
  calls: Call[],
  opts: {
    failConfig?: string;
    pauseTar?: () => Promise<void>;
    svc?: (sub: string, nth: number) => { code: number; stderr: string } | null;
    onSvc?: (sub: string) => void;
    kickstart?: { code: number; stderr: string };
    bootstrap?: { code: number; stderr: string };
    print?: { stdout: string };
  } = {},
): thisMac.Exec {
  const svcCount = new Map<string, number>();
  return async (file, args) => {
    if (file === '/usr/bin/tar' && opts.pauseTar) await opts.pauseTar();
    calls.push({ file, args });
    if (file === '/bin/launchctl') {
      if (args[0] === 'kickstart' && opts.kickstart) return { code: opts.kickstart.code, stdout: '', stderr: opts.kickstart.stderr };
      if (args[0] === 'bootstrap' && opts.bootstrap) return { code: opts.bootstrap.code, stdout: '', stderr: opts.bootstrap.stderr };
      if (args[0] === 'print') return { code: 0, stdout: opts.print?.stdout ?? '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }
    const socketAt = args.indexOf('--local-socket');
    const dir = file === '/usr/bin/tar' ? args[args.indexOf('-C') + 1] : socketAt === -1 ? '' : path.dirname(args[socketAt + 1]);
    if (file === '/usr/bin/tar') {
      fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
    }
    const [, , command, ...rest] = args;
    if (command === 'svc') {
      const sub = rest[0] ?? '';
      if (opts.svc) {
        const n = (svcCount.get(sub) ?? 0) + 1;
        svcCount.set(sub, n);
        const failed = opts.svc(sub, n);
        if (failed) return { code: failed.code, stdout: '', stderr: failed.stderr };
      }
      opts.onSvc?.(sub);
    }
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

function deps(exec: thisMac.Exec, hostname: string, waitForSocket: () => Promise<void> = async () => undefined): void {
  thisMac.useThisMacDeps({ exec, platform: 'darwin', arch: 'arm64', uid: 501, isolated: false, hostname: () => hostname, dataDir: () => data, waitForSocket });
}

/** Each call as its runner command (`svc start`), or `launchctl …` in full. */
function steps(calls: Call[]): string[][] {
  return calls.map((c) => (c.file === '/bin/launchctl' ? ['launchctl', ...c.args] : c.args.slice(2)));
}

function kickstartOf(accountId: string): string[] {
  return ['launchctl', 'kickstart', `gui/501/${thisMac.serviceLabelFor(accountId)}`];
}

function bootoutOf(name: string): string[] {
  return ['launchctl', 'bootout', `gui/501/${name}`];
}

function configName(args: string[]): string {
  return args[args.indexOf('--name') + 1];
}

function macDir(): string {
  const id = current()?.user.id;
  if (!id) throw new Error('not signed in');
  return thisMac.pathsFor(data, id).dir;
}

async function signIn(name = 'octo'): Promise<void> {
  login = name;
  if (name !== 'octo') h.github.addUser(name);
  useServerDeps({
    openExternal: async (authorizeUrl) => {
      const u = new URL(h.github.approve(authorizeUrl, login));
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
  h = await startLiveServer({ PUCK_DEVELOPMENT: 'true', PUCK_RUNNER_DOWNLOADS: downloads });
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
    thisMac.useThisMacDeps({ exec: fakeExec(calls), platform: 'darwin', arch: 'arm64', uid: 501, isolated: false, hostname: () => 'feynman-mbp.local', dataDir: () => data, waitForSocket: async () => undefined });
    const record = await thisMac.install([]);
    const dir = macDir();
    const node = path.join(dir, 'bin', 'node');
    const bundle = path.join(dir, 'bin', 'puck-runner.cjs');
    expect(record).toEqual({ runnerId: RUNNER_ID, dir, socket: path.join(dir, 'local.sock'), accountId: current()?.user.id });
    expect(localRunner()).toEqual(record);
    expect(calls[0]).toEqual({ file: '/usr/bin/tar', args: ['-xzf', path.join(dir, TARBALL), '-C', dir] });
    const config = calls[1];
    expect(config.file).toBe(node);
    expect(config.args.slice(0, 4)).toEqual(['--disable-warning=ExperimentalWarning', bundle, 'config', '--unattended']);
    expect(config.args).toEqual(expect.arrayContaining(['--url', h.base, '--name', 'This Mac (feynman-mbp)', '--labels', 'local', '--local-socket', path.join(dir, 'local.sock'), '--service-label', thisMac.serviceLabelFor(current()?.user.id ?? '')]));
    expect(config.args).toEqual(expect.arrayContaining(['--app-bundle-id', 'com.namikmesic.puck']));
    expect(config.args).not.toContain('--replace');
    expect(config.args.join(' ')).not.toMatch(/PRT_/); // the token travels in a file, never argv
    expect(steps(calls.slice(2))).toEqual([['svc', 'install'], ['svc', 'start'], kickstartOf(current()?.user.id ?? '')]);
    // Nothing secret or temporary is left behind, and the token is revoked.
    expect(fs.existsSync(path.join(dir, '.registration-token'))).toBe(false);
    expect(fs.existsSync(path.join(dir, TARBALL))).toBe(false);
    const audit = await call(h, 'GET', '/v1/audit', { token: current()?.accessToken });
    expect(JSON.stringify(audit.body)).toContain('runner.registration-token');
    expect(thisMac.localState()).toMatchObject({ installed: true, runnerId: RUNNER_ID, busy: null, error: null });
  });

  it('registers a second Mac with the same hostname under a stable suffixed name', async () => {
    const calls: Call[] = [];
    deps(fakeExec(calls), 'MacBook-Pro.local');
    const other = { id: 'rnr_01J8Z3X0000000000000000099', name: 'This Mac (MacBook-Pro)' };
    await thisMac.install([other as never]);
    const name = configName(calls[1].args);
    expect(calls[1].args).not.toContain('--replace');
    expect(name).toMatch(/^This Mac \(MacBook-Pro [0-9a-f]{4}\)$/);
    expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/);

    fs.rmSync(path.join(macDir(), '.runner'));
    setLocalRunner(null);
    calls.length = 0;
    await thisMac.install([other as never]);
    expect(configName(calls[1].args)).toBe(name);
    expect(calls[1].args).not.toContain('--replace');
  });

  it('re-registers only the runner id this Mac recorded', async () => {
    const calls: Call[] = [];
    const own = 'rnr_01J8Z3X0000000000000000002';
    const dir = macDir();
    setLocalRunner({ runnerId: own, dir, socket: path.join(dir, 'local.sock') });
    deps(fakeExec(calls), 'mbp.local');
    await thisMac.install([
      { id: 'rnr_01J8Z3X0000000000000000099', name: 'This Mac (mbp)' } as never,
      { id: own, name: 'Office Mac' } as never,
    ]);
    expect(calls[1].args).toContain('--replace');
    expect(configName(calls[1].args)).toBe('Office Mac');
  });

  it('does not replace another Mac when the recorded id is not that runner', async () => {
    const calls: Call[] = [];
    const dir = macDir();
    setLocalRunner({ runnerId: 'rnr_01J8Z3X0000000000000000008', dir, socket: path.join(dir, 'local.sock') });
    deps(fakeExec(calls), 'mbp');
    await thisMac.install([{ id: 'rnr_01J8Z3X0000000000000000099', name: 'This Mac (mbp)' } as never]);
    expect(calls[1].args).not.toContain('--replace');
    expect(configName(calls[1].args)).toMatch(/^This Mac \(mbp [0-9a-f]{4}\)$/);
  });

  it('installs the LaunchAgent when a recorded runner has no service, then waits for the socket', async () => {
    const dir = macDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.runner'), JSON.stringify({ runnerId: RUNNER_ID }));
    const calls: Call[] = [];
    let waited = 0;
    deps(
      fakeExec(calls, {
        svc: (sub, n) => (sub === 'start' && n === 1 ? { code: 1, stderr: 'No service is installed. Install it first: ./svc.sh install' } : null),
      }),
      'mbp',
      async () => {
        waited += 1;
      },
    );
    const record = await thisMac.install([]);
    expect(record.runnerId).toBe(RUNNER_ID);
    expect(localRunner()?.runnerId).toBe(RUNNER_ID);
    expect(steps(calls)).toEqual([['svc', 'start'], ['svc', 'install'], ['svc', 'start'], kickstartOf(current()?.user.id ?? '')]);
    expect(waited).toBe(1);
    expect(thisMac.localState()).toMatchObject({ installed: true, error: null });
  });

  it('rewrites a LaunchAgent an older install left on run.sh when none was recorded', async () => {
    const dir = macDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.runner'), JSON.stringify({ runnerId: RUNNER_ID }));
    const label = thisMac.serviceLabelFor(current()?.user.id ?? '');
    const file = path.join(dir, 'LaunchAgents', `${label}.plist`);
    const calls: Call[] = [];
    let waited = 0;
    deps(
      fakeExec(calls, {
        svc: (sub, n) => (sub === 'start' && n === 1 ? { code: 1, stderr: 'No service is installed. Install it first: ./svc.sh install' } : null),
        onSvc: (sub) => {
          if (sub !== 'install') return;
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(
            file,
            `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${path.join(dir, 'run.sh')}</string>\n  </array>\n</dict></plist>\n`,
          );
          fs.writeFileSync(path.join(dir, '.service'), JSON.stringify({ kind: 'launchd', name: label, file }));
        },
      }),
      'mbp',
      async () => {
        waited += 1;
      },
    );
    await thisMac.install([]);
    expect(steps(calls)).toEqual([
      ['svc', 'start'],
      ['svc', 'install'],
      bootoutOf(label),
      ['launchctl', 'bootstrap', 'gui/501', file],
      ['launchctl', 'kickstart', `gui/501/${label}`],
    ]);
    expectRewritten(dir, file);
    expect(waited).toBe(1);
    expect(localRunner()?.runnerId).toBe(RUNNER_ID);
  });

  const OLD_LABEL = 'com.puck.runner.0ld0ld0l';

  function writeAgent(dir: string, program: string): string {
    const file = path.join(dir, 'LaunchAgents', `${OLD_LABEL}.plist`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${program}</string>\n  </array>\n</dict></plist>\n`,
    );
    fs.writeFileSync(path.join(dir, '.service'), JSON.stringify({ kind: 'launchd', name: OLD_LABEL, file }));
    fs.writeFileSync(path.join(dir, '.runner'), JSON.stringify({ runnerId: RUNNER_ID }));
    return file;
  }

  function expectRewritten(dir: string, file: string): void {
    const plist = fs.readFileSync(file, 'utf8');
    expect(plist).toContain(`<string>${launcherPath(dir)}</string>`);
    expect(plist).toContain('<key>AssociatedBundleIdentifiers</key>');
    expect(plist).toContain('<string>com.namikmesic.puck</string>');
    expect(plist).not.toContain('run.sh');
    expect(fs.readFileSync(launcherPath(dir), 'utf8')).toContain('run.sh');
    expect(fs.statSync(launcherPath(dir)).mode & 0o777).toBe(0o755);
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.service'), 'utf8'))).toMatchObject({ launcher: launcherPath(dir) });
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.runner'), 'utf8')).appBundleId).toBe('com.namikmesic.puck');
  }

  it('rewrites an older LaunchAgent that still runs run.sh, then bootstraps and kickstarts it', async () => {
    const dir = macDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = writeAgent(dir, path.join(dir, 'run.sh'));
    const calls: Call[] = [];
    let waited = 0;
    deps(fakeExec(calls), 'mbp', async () => {
      waited += 1;
    });
    await thisMac.install([]);
    const accountLabel = thisMac.serviceLabelFor(current()?.user.id ?? '');
    expect(steps(calls)).toEqual([
      ['svc', 'install'],
      bootoutOf(OLD_LABEL),
      bootoutOf(accountLabel),
      ['launchctl', 'bootstrap', `gui/501`, file],
      ['launchctl', 'kickstart', `gui/501/${OLD_LABEL}`],
    ]);
    expectRewritten(dir, file);
    expect(waited).toBe(1);
    expect(localRunner()?.runnerId).toBe(RUNNER_ID);
  });

  it('rewrites a LaunchAgent whose plist names no app', async () => {
    const dir = macDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = writeAgent(dir, launcherPath(dir));
    const calls: Call[] = [];
    deps(fakeExec(calls), 'mbp');
    await thisMac.install([]);
    expect(steps(calls)[0]).toEqual(['svc', 'install']);
    expect(steps(calls).map((s) => s[1] ?? s[0])).toEqual(['install', 'bootout', 'bootout', 'bootstrap', 'kickstart']);
    expectRewritten(dir, file);
  });

  it('reloads an already-current LaunchAgent without reinstalling it', async () => {
    const dir = macDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'agent.plist');
    fs.writeFileSync(file, launchdPlist({ label: OLD_LABEL, root: dir, appBundleId: 'com.namikmesic.puck' }));
    fs.writeFileSync(path.join(dir, '.service'), JSON.stringify({ kind: 'launchd', name: OLD_LABEL, file, launcher: launcherPath(dir) }));
    fs.writeFileSync(path.join(dir, '.runner'), JSON.stringify({ runnerId: RUNNER_ID, appBundleId: 'com.namikmesic.puck' }));
    const before = fs.readFileSync(file, 'utf8');
    const calls: Call[] = [];
    let waited = 0;
    deps(
      fakeExec(calls, {
        svc: (sub) => (sub === 'start' ? { code: 1, stderr: 'launchctl bootstrap failed: Bootstrap failed: 5: Input/output error' } : null),
      }),
      'mbp',
      async () => {
        waited += 1;
      },
    );
    await thisMac.install([]);
    const accountLabel = thisMac.serviceLabelFor(current()?.user.id ?? '');
    expect(steps(calls)).toEqual([
      ['svc', 'start'],
      bootoutOf(OLD_LABEL),
      bootoutOf(accountLabel),
      ['launchctl', 'bootstrap', `gui/501`, file],
      ['launchctl', 'kickstart', `gui/501/${OLD_LABEL}`],
    ]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(waited).toBe(1);
    expect(localRunner()?.runnerId).toBe(RUNNER_ID);
  });

  it('reinstalls when the runner refuses to rewrite an existing LaunchAgent', async () => {
    const dir = macDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = writeAgent(dir, path.join(dir, 'run.sh'));
    const calls: Call[] = [];
    deps(
      fakeExec(calls, {
        svc: (sub, n) => (sub === 'install' && n === 1 ? { code: 1, stderr: 'A service is already installed. Uninstall it first: ./svc.sh uninstall' } : null),
      }),
      'mbp',
    );
    await thisMac.install([]);
    const accountLabel = thisMac.serviceLabelFor(current()?.user.id ?? '');
    expect(steps(calls)).toEqual([
      ['svc', 'install'],
      ['svc', 'uninstall'],
      ['svc', 'install'],
      bootoutOf(OLD_LABEL),
      bootoutOf(accountLabel),
      ['launchctl', 'bootstrap', `gui/501`, file],
      ['launchctl', 'kickstart', `gui/501/${OLD_LABEL}`],
    ]);
    expectRewritten(dir, file);
  });

  it('names the rewritten login item when kickstart fails', async () => {
    const dir = macDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = writeAgent(dir, path.join(dir, 'run.sh'));
    const calls: Call[] = [];
    deps(fakeExec(calls, { kickstart: { code: 1, stderr: 'Operation not permitted' } }), 'mbp');
    await expect(thisMac.install([])).rejects.toThrow(/Check that puck-runner is allowed in System Settings → General → Login Items & Extensions/);
    expect(steps(calls).map((s) => (s[0] === 'launchctl' ? s[1] : s[0]))).toEqual(['svc', 'bootout', 'bootout', 'bootstrap', 'kickstart', 'print']);
    expectRewritten(dir, file);
    expect(localRunner()?.runnerId ?? null).toBeNull();
  });

  it('names the login item launchd loaded when kickstart fails', async () => {
    const dir = macDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = writeAgent(dir, path.join(dir, 'run.sh'));
    deps(
      fakeExec([], {
        kickstart: { code: 1, stderr: 'Operation not permitted' },
        print: { stdout: 'gui/501/x = {\n\tprogram = /var/folders/ab/T/puck-isolated-1/run.sh\n}\n' },
      }),
      'mbp',
    );
    await expect(thisMac.install([])).rejects.toThrow(/Check that run\.sh is allowed in System Settings → General → Login Items & Extensions/);
    const plist = fs.readFileSync(file, 'utf8');
    expect(plist).toContain(`<string>${launcherPath(dir)}</string>`);
    expect(plist).not.toContain('run.sh');
  });

  it('does not mark This Mac installed when the rewritten LaunchAgent does not load', async () => {
    const dir = macDir();
    fs.mkdirSync(dir, { recursive: true });
    writeAgent(dir, path.join(dir, 'run.sh'));
    const calls: Call[] = [];
    deps(fakeExec(calls, { bootstrap: { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } }), 'mbp');
    await expect(thisMac.install([])).rejects.toThrow(/launchctl bootstrap failed: Bootstrap failed: 5/);
    expect(steps(calls).flat()).not.toContain('kickstart');
    expect(localRunner()?.runnerId ?? null).toBeNull();
    expect(thisMac.localState().installed).toBe(false);
  });

  it('surfaces a LaunchAgent start failure and does not mark This Mac installed', async () => {
    const dir = macDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.runner'), JSON.stringify({ runnerId: RUNNER_ID }));
    const calls: Call[] = [];
    let waited = 0;
    deps(
      fakeExec(calls, {
        svc: (sub, n) => {
          if (sub === 'start' && n === 1) return { code: 1, stderr: 'No service is installed. Install it first: ./svc.sh install' };
          if (sub === 'start') return { code: 1, stderr: 'launchctl bootstrap failed: Bootstrap failed: 1: Operation not permitted' };
          return null;
        },
      }),
      'mbp',
      async () => {
        waited += 1;
      },
    );
    await expect(thisMac.install([])).rejects.toThrow(/Operation not permitted/);
    expect(steps(calls)).toEqual([
      ['svc', 'start'],
      ['svc', 'install'],
      ['svc', 'start'],
    ]);
    expect(waited).toBe(0);
    expect(localRunner()?.runnerId ?? null).toBeNull();
    expect(thisMac.localState().installed).toBe(false);
  });

  it('does not mark This Mac installed when the new LaunchAgent fails to start', async () => {
    const calls: Call[] = [];
    let waited = 0;
    deps(
      fakeExec(calls, {
        svc: (sub) => (sub === 'start' ? { code: 1, stderr: 'launchctl bootstrap failed: Bootstrap failed: 1: Operation not permitted' } : null),
      }),
      'mbp',
      async () => {
        waited += 1;
      },
    );
    await expect(thisMac.install([])).rejects.toThrow(/Operation not permitted/);
    expect(waited).toBe(0);
    expect(fs.existsSync(path.join(macDir(), '.runner'))).toBe(true);
    expect(localRunner()?.runnerId ?? null).toBeNull();
    expect(thisMac.localState().installed).toBe(false);
  });

  it('does not mark This Mac installed when launchd does not start the runner', async () => {
    const calls: Call[] = [];
    let waited = 0;
    deps(fakeExec(calls, { kickstart: { code: 1, stderr: 'Operation not permitted' } }), 'mbp', async () => {
      waited += 1;
    });
    await expect(thisMac.install([])).rejects.toThrow(/launchd did not start the runner \(Operation not permitted\)\. .*Login Items/);
    expect(waited).toBe(0);
    expect(localRunner()?.runnerId ?? null).toBeNull();
    expect(thisMac.localState()).toMatchObject({ installed: false, error: expect.stringMatching(/launchd did not start/) });
  });

  it('refuses to set up This Mac in an isolated launch', async () => {
    const calls: Call[] = [];
    thisMac.useThisMacDeps({ exec: fakeExec(calls), platform: 'darwin', arch: 'arm64', uid: 501, isolated: true, hostname: () => 'mbp', dataDir: () => data });
    expect(thisMac.localState()).toMatchObject({ supported: false, unsupported: expect.stringMatching(/isolated launch/) });
    await expect(thisMac.install([])).rejects.toThrow(/cannot be set up in an isolated launch.*LaunchAgents/);
    expect(calls).toEqual([]);
    expect(fs.existsSync(macDir())).toBe(false);
    expect(localRunner()).toBeNull();
  });

  it('refuses a download that does not match its sha256 and leaves nothing behind', async () => {
    const calls: Call[] = [];
    thisMac.useThisMacDeps({ exec: fakeExec(calls), platform: 'darwin', arch: 'arm64', uid: 501, isolated: false, hostname: () => 'mbp', dataDir: () => data, waitForSocket: async () => undefined });
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
    expect(fs.existsSync(macDir())).toBe(false);
    expect(localRunner()).toBeNull();
    expect(thisMac.localState().error).toMatch(/sha256/);
    expect(createHash('sha256').update('tarball bytes').digest('hex')).toHaveLength(64);
  });

  it('cleans up when registration fails', async () => {
    const calls: Call[] = [];
    thisMac.useThisMacDeps({ exec: fakeExec(calls, { failConfig: 'Docker is not running on this machine.' }), platform: 'darwin', arch: 'arm64', uid: 501, isolated: false, hostname: () => 'mbp', dataDir: () => data, waitForSocket: async () => undefined });
    await expect(thisMac.install([])).rejects.toThrow(/Registering the runner failed: Docker is not running/);
    expect(fs.existsSync(macDir())).toBe(false);
    expect(localRunner()).toBeNull();
  });

  it('needs macOS on Apple silicon', async () => {
    thisMac.useThisMacDeps({ exec: fakeExec([]), platform: 'linux', arch: 'x64', dataDir: () => data });
    expect(thisMac.supported()).toBe(false);
    expect(thisMac.localState()).toMatchObject({ supported: false, unsupported: expect.stringMatching(/Apple silicon/) });
    await expect(thisMac.install([])).rejects.toThrow(/macOS on Apple silicon/);
  });

  it('says downloads exist only in development mode when the server publishes no runner packages', async () => {
    fs.rmSync(path.join(downloads, '0.1.0', TARBALL));
    deps(fakeExec([]), 'mbp');
    await expect(thisMac.install([])).rejects.toThrow(/^This Puck server has no runner package for macOS on Apple silicon\. Runner downloads come only from a Puck server in development mode\.$/);
    expect(thisMac.localState().error).toBe('This Puck server has no runner package for macOS on Apple silicon. Runner downloads come only from a Puck server in development mode.');
  });

  it('names the missing macOS package when the server publishes other platforms', async () => {
    fs.rmSync(path.join(downloads, '0.1.0', TARBALL));
    fs.writeFileSync(path.join(downloads, '0.1.0', 'puck-runner-linux-x64-0.1.0.tar.gz'), 'linux bytes');
    deps(fakeExec([]), 'mbp');
    await expect(thisMac.install([])).rejects.toThrow(/^This Puck server has no runner package for macOS on Apple silicon\.$/);
    expect(thisMac.localState().error).toBe('This Puck server has no runner package for macOS on Apple silicon.');
  });

  it('uninstall deregisters keeping the environments, then removes the directory', async () => {
    const calls: Call[] = [];
    thisMac.useThisMacDeps({ exec: fakeExec(calls), platform: 'darwin', arch: 'arm64', uid: 501, isolated: false, hostname: () => 'mbp', dataDir: () => data, waitForSocket: async () => undefined });
    await thisMac.install([]);
    calls.length = 0;
    await thisMac.uninstall();
    expect(steps(calls)).toEqual([['config', 'remove', '--unattended', '--keep-environments']]);
    expect(fs.existsSync(macDir())).toBe(false);
    expect(localRunner()).toBeNull();
    expect(thisMac.localState()).toMatchObject({ installed: false, runnerId: null });
  });

  it('names the app bundle id the Electron build uses', () => {
    expect(thisMac.APP_BUNDLE_ID).toBe(forgeConfig.packagerConfig?.appBundleId);
  });

  it('names This Mac after the host, safely', () => {
    expect(thisMac.localName('Feynman’s MacBook.local')).toBe('This Mac (Feynman-s MacBook)');
    expect(thisMac.localName('...')).toBe('This Mac');
  });

  it('keeps each account socket under 103 bytes', () => {
    const dataDir = `/Users/${'n'.repeat(63)}`;
    const a = thisMac.pathsFor(dataDir, `usr_${'A'.repeat(26)}`);
    const b = thisMac.pathsFor(dataDir, `usr_${'B'.repeat(26)}`);
    expect(Buffer.byteLength(a.socket)).toBeLessThanOrEqual(103);
    expect(Buffer.byteLength(b.socket)).toBeLessThanOrEqual(103);
    expect(a.dir).not.toBe(b.dir);
    expect(thisMac.serviceLabelFor(`usr_${'A'.repeat(26)}`)).not.toBe(thisMac.serviceLabelFor(`usr_${'B'.repeat(26)}`));
  });

  it('aborts install when the session changes and leaves the new account record', async () => {
    const calls: Call[] = [];
    let release = (): void => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    deps(
      fakeExec(calls, {
        pauseTar: async () => {
          paused = true;
          await hold;
        },
      }),
      'mbp.local',
    );
    const aId = current()?.user.id ?? '';
    const installing = thisMac.install([]);
    try {
      for (let i = 0; i < 400 && !paused; i++) await new Promise((r) => setTimeout(r, 5));
      expect(paused).toBe(true);
      await account.logout();
      await signIn('bee');
      const beeId = current()?.user.id ?? '';
      expect(beeId).not.toBe(aId);
      setLocalRunner({ runnerId: 'rnr_bee', dir: path.join(data, 'bee'), socket: path.join(data, 'bee', 'sock'), accountId: beeId });
      release();
      await expect(installing).rejects.toThrow(/session changed/);
      expect(calls.some((c) => c.args.includes('config') || c.args.includes('svc'))).toBe(false);
      expect(localRunner()).toMatchObject({ runnerId: 'rnr_bee', accountId: beeId });
      expect(fs.existsSync(thisMac.pathsFor(data, aId).dir)).toBe(true);
      expect(fs.existsSync(path.join(thisMac.pathsFor(data, aId).dir, '.runner'))).toBe(false);
      setLocalRunner(null);
    } finally {
      release();
      await installing.catch(() => undefined);
    }
    await account.logout();
    await signIn('octo');
    expect(current()?.user.id).toBe(aId);
    expect(localRunner()).toBeNull();
  });

  it('lets a second account install beside the first and leaves the first runner in place', async () => {
    const calls: Call[] = [];
    deps(fakeExec(calls), 'mbp.local');
    const aId = current()?.user.id ?? '';
    await thisMac.install([]);
    const aDir = thisMac.pathsFor(data, aId).dir;
    const aLabel = thisMac.serviceLabelFor(aId);
    expect(fs.existsSync(path.join(aDir, '.runner'))).toBe(true);
    expect(calls[1].args).toContain(aLabel);
    expect(thisMac.localState()).toMatchObject({ installed: true, runnerId: RUNNER_ID });

    await account.logout();
    expect(thisMac.localState().installed).toBe(false);
    await signIn('bee');
    expect(current()?.user.id).not.toBe(aId);
    expect(thisMac.localState().installed).toBe(false);
    expect(fs.existsSync(aDir)).toBe(true);

    calls.length = 0;
    await thisMac.install([]);
    const bId = current()?.user.id ?? '';
    const bDir = thisMac.pathsFor(data, bId).dir;
    expect(bDir).not.toBe(aDir);
    expect(fs.existsSync(path.join(aDir, '.runner'))).toBe(true);
    expect(fs.existsSync(path.join(bDir, '.runner'))).toBe(true);
    expect(calls[1].args).toContain(thisMac.serviceLabelFor(bId));
    expect(calls[1].args).not.toContain(aLabel);
    expect(calls[1].args).not.toContain('--replace');
    expect(thisMac.localState()).toMatchObject({ installed: true });

    await thisMac.uninstall();
    expect(fs.existsSync(aDir)).toBe(true);
    expect(fs.existsSync(bDir)).toBe(false);

    await account.logout();
    await signIn('octo');
    expect(current()?.user.id).toBe(aId);
    expect(thisMac.localState()).toMatchObject({ installed: true, runnerId: RUNNER_ID });
    expect(localRunner()?.dir).toBe(aDir);
  });
});
