import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runnerPaths, type RunnerConfig } from '../../src/puck-runner/files';
import { LAUNCHER, launchdLabel, launcherScript, launchdPlist, readServiceRecord, Service, serviceSlug, systemdUnit, type ServiceDeps } from '../../src/puck-runner/service';

// svc.sh: the systemd unit and the LaunchAgent the runner installs, and
// the systemctl / launchctl argv of each command.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-svc-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const config: RunnerConfig = {
  runnerId: 'rnr_1',
  name: 'Build Box (2)',
  serverUrl: 'https://puck.test',
  labels: [],
  maxEnvironments: null,
  disableUpdate: false,
  owner: 'octo',
  localSocket: null,
  serviceLabel: null,
  appBundleId: null,
};

type Reply = { code: number; stderr: string; stdout?: string } | null;

function deps(platform: NodeJS.Platform, uid: number, env: NodeJS.ProcessEnv = {}, groups = 'puck docker', reply: (call: string) => Reply = () => null) {
  const calls: string[] = [];
  const lines: string[] = [];
  const d: ServiceDeps = {
    paths: runnerPaths(path.join(dir, 'runner')),
    config,
    platform,
    uid,
    env,
    homedir: path.join(dir, 'home'),
    exec: async (file, args) => {
      const call = [file, ...args].join(' ');
      calls.push(call);
      const r = reply(call);
      if (r) return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr };
      return { code: 0, stdout: file === 'id' ? groups : '', stderr: '' };
    },
    print: (l) => lines.push(l),
    systemdDir: path.join(dir, 'systemd'),
  };
  fs.mkdirSync(d.paths.root, { recursive: true });
  return { d, calls, lines };
}

describe('runner service', () => {
  it('names the unit from the runner name', () => {
    expect(serviceSlug('Build Box (2)')).toBe('build-box-2');
    expect(serviceSlug('---')).toBe('runner');
  });

  it('writes a systemd unit that runs run.sh as the user and stays down after exit 78', () => {
    const unit = systemdUnit({ name: 'build-box', root: '/opt/puck runner', user: 'puck' });
    expect(unit).toContain('ExecStart="/opt/puck runner/run.sh"');
    expect(unit).toContain('User=puck');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartPreventExitStatus=78');
    expect(unit).toContain('Environment=PUCK_RUNNER_SERVICE=systemd');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('writes a LaunchAgent kept alive only while it exits unsuccessfully', () => {
    const plist = launchdPlist({ label: 'com.puck.runner.x', root: '/Users/u/puck-runner' });
    expect(plist).toContain('<string>/Users/u/puck-runner/puck-runner</string>');
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain('<string>launchd</string>');
    expect(plist).not.toContain('AssociatedBundleIdentifiers');
  });

  it('names the app a LaunchAgent belongs to when the runner was configured with one', () => {
    const plist = launchdPlist({ label: 'com.puck.runner.x', root: '/Users/u/r', appBundleId: 'com.namikmesic.puck' });
    expect(plist).toMatch(/<key>AssociatedBundleIdentifiers<\/key>\s*<array>\s*<string>com\.namikmesic\.puck<\/string>\s*<\/array>/);
  });

  it('launches run.sh through a launcher named puck-runner, passing its arguments', () => {
    const root = path.join(dir, 'with space');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'run.sh'), '#!/bin/sh\necho "run.sh $*"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, LAUNCHER), launcherScript(), { mode: 0o755 });
    expect(execFileSync(path.join(root, LAUNCHER), ['--help'], { encoding: 'utf8' })).toBe('run.sh --help\n');
  });

  it('installs, starts, stops and uninstalls with systemctl as root, for the sudo user', async () => {
    const { d, calls, lines } = deps('linux', 0, { SUDO_USER: 'puck' });
    const svc = new Service(d);
    await svc.install();
    const record = readServiceRecord(d.paths);
    expect(record).toMatchObject({ kind: 'systemd', name: 'puck-runner.build-box-2.service', user: 'puck' });
    expect(fs.readFileSync(record?.file as string, 'utf8')).toContain('User=puck');
    await svc.start();
    await svc.stop();
    await svc.uninstall();
    expect(calls).toEqual([
      'id -nG puck',
      'systemctl daemon-reload',
      'systemctl enable puck-runner.build-box-2.service',
      'systemctl start puck-runner.build-box-2.service',
      'systemctl stop puck-runner.build-box-2.service',
      'systemctl stop puck-runner.build-box-2.service',
      'systemctl disable puck-runner.build-box-2.service',
      'systemctl daemon-reload',
    ]);
    expect(fs.existsSync(record?.file as string)).toBe(false);
    expect(readServiceRecord(d.paths)).toBeNull();
    expect(lines.join('\n')).toContain('Environments keep running');
  });

  it('warns when the service user cannot use Docker, and needs root on Linux', async () => {
    const warn = deps('linux', 0, { SUDO_USER: 'alice' }, 'alice staff');
    await new Service(warn.d).install();
    expect(warn.lines.join('\n')).toContain('sudo usermod -aG docker alice');
    const notRoot = deps('linux', 1000);
    await expect(new Service(notRoot.d).install()).rejects.toThrow('sudo ./svc.sh install');
  });

  it('gives each account its own LaunchAgent and leaves the other in place', async () => {
    expect(launchdLabel('This Mac (mbp)', 'com.puck.runner.aaaaaaaa')).toBe('com.puck.runner.aaaaaaaa');
    expect(launchdLabel('This Mac (mbp)', null)).toBe('com.puck.runner.this-mac-mbp');
    const home = path.join(dir, 'home');
    const install = async (label: string, root: string): Promise<void> => {
      const { d } = deps('darwin', 501);
      await new Service({
        ...d,
        homedir: home,
        paths: runnerPaths(root),
        config: { ...config, serviceLabel: label, localSocket: null },
      }).install();
      fs.mkdirSync(root, { recursive: true });
    };
    const aRoot = path.join(dir, 'a');
    const bRoot = path.join(dir, 'b');
    fs.mkdirSync(aRoot, { recursive: true });
    fs.mkdirSync(bRoot, { recursive: true });
    await install('com.puck.runner.aaaaaaaa', aRoot);
    await install('com.puck.runner.bbbbbbbb', bRoot);
    const agents = path.join(home, 'Library', 'LaunchAgents');
    expect(fs.existsSync(path.join(agents, 'com.puck.runner.aaaaaaaa.plist'))).toBe(true);
    expect(fs.existsSync(path.join(agents, 'com.puck.runner.bbbbbbbb.plist'))).toBe(true);
    expect(fs.readFileSync(path.join(agents, 'com.puck.runner.aaaaaaaa.plist'), 'utf8')).toContain(aRoot);
    expect(fs.readFileSync(path.join(agents, 'com.puck.runner.bbbbbbbb.plist'), 'utf8')).toContain(bRoot);
  });

  it('bootstraps a LaunchAgent in the user domain on macOS and starts it, without sudo', async () => {
    const { d, calls } = deps('darwin', 501);
    const svc = new Service({ ...d, config: { ...config, appBundleId: 'com.namikmesic.puck' } });
    await svc.install();
    const plist = path.join(dir, 'home', 'Library', 'LaunchAgents', 'com.puck.runner.build-box-2.plist');
    const launcher = path.join(d.paths.root, 'puck-runner');
    expect(fs.readFileSync(plist, 'utf8')).toContain(`<string>${launcher}</string>`);
    expect(fs.readFileSync(plist, 'utf8')).toContain('<string>com.namikmesic.puck</string>');
    expect(fs.statSync(launcher).mode & 0o777).toBe(0o755);
    expect(readServiceRecord(d.paths)).toMatchObject({ kind: 'launchd', launcher });
    await svc.start();
    await svc.stop();
    await svc.start();
    await svc.status();
    await svc.uninstall();
    expect(calls).toEqual([
      'launchctl bootout gui/501/com.puck.runner.build-box-2',
      `launchctl bootstrap gui/501 ${plist}`,
      'launchctl kickstart gui/501/com.puck.runner.build-box-2',
      'launchctl bootout gui/501/com.puck.runner.build-box-2',
      'launchctl bootout gui/501/com.puck.runner.build-box-2',
      `launchctl bootstrap gui/501 ${plist}`,
      'launchctl kickstart gui/501/com.puck.runner.build-box-2',
      'launchctl print gui/501/com.puck.runner.build-box-2',
      'launchctl bootout gui/501/com.puck.runner.build-box-2',
    ]);
    expect(fs.existsSync(plist)).toBe(false);
    expect(fs.existsSync(launcher)).toBe(false);
    await expect(new Service(deps('darwin', 0).d).install()).rejects.toThrow('without sudo');
  });

  it('unloads a LaunchAgent that is already loaded, then starts the plist on disk', async () => {
    const { d, calls } = deps('darwin', 501);
    const svc = new Service(d);
    await svc.install();
    const file = readServiceRecord(d.paths)?.file as string;
    calls.length = 0;
    await svc.start();
    expect(calls).toEqual([
      'launchctl bootout gui/501/com.puck.runner.build-box-2',
      `launchctl bootstrap gui/501 ${file}`,
      'launchctl kickstart gui/501/com.puck.runner.build-box-2',
    ]);
    expect(fs.readFileSync(file, 'utf8')).toContain(`<string>${path.join(d.paths.root, 'puck-runner')}</string>`);
  });

  it('bootstraps when the LaunchAgent is not already loaded', async () => {
    const { d, calls } = deps('darwin', 501, {}, '', (call) =>
      call.startsWith('launchctl bootout') ? { code: 3, stderr: 'Boot-out failed: 3: No such process' } : null,
    );
    const svc = new Service(d);
    await svc.install();
    const file = readServiceRecord(d.paths)?.file as string;
    calls.length = 0;
    await svc.start();
    expect(calls).toEqual([
      'launchctl bootout gui/501/com.puck.runner.build-box-2',
      `launchctl bootstrap gui/501 ${file}`,
      'launchctl kickstart gui/501/com.puck.runner.build-box-2',
    ]);
  });

  it('bootstraps when bootout reports the LaunchAgent is missing', async () => {
    const { d, calls } = deps('darwin', 501, {}, '', (call) =>
      call.startsWith('launchctl bootout') ? { code: 113, stderr: 'Could not find service' } : null,
    );
    const svc = new Service(d);
    await svc.install();
    calls.length = 0;
    await svc.start();
    expect(calls[0]).toBe('launchctl bootout gui/501/com.puck.runner.build-box-2');
    expect(calls[1]).toContain('launchctl bootstrap');
    expect(calls[2]).toContain('launchctl kickstart');
  });

  it('does not bootstrap a LaunchAgent it failed to unload', async () => {
    const { d, calls } = deps('darwin', 501, {}, '', (call) =>
      call.startsWith('launchctl bootout') ? { code: 1, stderr: 'Operation not permitted' } : null,
    );
    const svc = new Service(d);
    await svc.install();
    calls.length = 0;
    await expect(svc.start()).rejects.toThrow('launchctl bootout failed: Operation not permitted');
    expect(calls).toEqual(['launchctl bootout gui/501/com.puck.runner.build-box-2']);
  });

  it('reports a LaunchAgent that does not load, and does not try to start it', async () => {
    const { d, calls } = deps('darwin', 501, {}, '', (call) =>
      call.startsWith('launchctl bootstrap') ? { code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } : null,
    );
    const svc = new Service(d);
    await svc.install();
    await expect(svc.start()).rejects.toThrow('launchctl bootstrap failed: Bootstrap failed: 5: Input/output error');
    expect(calls.some((c) => c.includes('kickstart'))).toBe(false);
    expect(calls.some((c) => c.includes('bootout'))).toBe(true);
  });

  it('rewrites an installed LaunchAgent that still runs run.sh', async () => {
    const { d, calls } = deps('darwin', 501);
    const svc = new Service({ ...d, config: { ...config, appBundleId: 'com.namikmesic.puck' } });
    await svc.install();
    const file = readServiceRecord(d.paths)?.file as string;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\/puck-runner</, '/run.sh<'));
    calls.length = 0;
    await svc.install();
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain(`<string>${path.join(d.paths.root, 'puck-runner')}</string>`);
    expect(text).toContain('<key>AssociatedBundleIdentifiers</key>');
    expect(text).toContain('<string>com.namikmesic.puck</string>');
    expect(text).not.toContain('run.sh');
    expect(calls).toEqual([]);
    await svc.start();
    expect(calls).toEqual([
      'launchctl bootout gui/501/com.puck.runner.build-box-2',
      `launchctl bootstrap gui/501 ${file}`,
      'launchctl kickstart gui/501/com.puck.runner.build-box-2',
    ]);
  });

  it('unloads the previous LaunchAgent when install changes its label', async () => {
    const { d, calls } = deps('darwin', 501, {}, '', (call) =>
      call.startsWith('launchctl bootout') ? { code: 3, stderr: 'Boot-out failed: 3: No such process' } : null,
    );
    await new Service(d).install();
    const oldFile = readServiceRecord(d.paths)?.file as string;
    calls.length = 0;
    const next = new Service({ ...d, config: { ...config, serviceLabel: 'com.puck.runner.aaaaaaaa' } });
    await next.install();
    expect(calls).toEqual(['launchctl bootout gui/501/com.puck.runner.build-box-2']);
    expect(fs.existsSync(oldFile)).toBe(false);
    const record = readServiceRecord(d.paths);
    expect(record?.name).toBe('com.puck.runner.aaaaaaaa');
    const file = record?.file as string;
    calls.length = 0;
    await next.start();
    expect(calls).toEqual([
      'launchctl bootout gui/501/com.puck.runner.aaaaaaaa',
      `launchctl bootstrap gui/501 ${file}`,
      'launchctl kickstart gui/501/com.puck.runner.aaaaaaaa',
    ]);
  });

  it('still refuses a second systemd install', async () => {
    const { d } = deps('linux', 0, { SUDO_USER: 'puck' });
    const svc = new Service(d);
    await svc.install();
    await expect(svc.install()).rejects.toThrow(/already installed/);
  });

  it('names the login item from the plist when kickstart fails', async () => {
    const { d } = deps('darwin', 501, {}, '', (call) => (call.startsWith('launchctl kickstart') ? { code: 1, stderr: 'Operation not permitted' } : null));
    const svc = new Service(d);
    await svc.install();
    const file = readServiceRecord(d.paths)?.file as string;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\/puck-runner</, '/run.sh<'));
    await expect(svc.start()).rejects.toThrow(/Check that run\.sh is allowed in System Settings → General → Login Items & Extensions/);
  });

  it('names the login item launchd loaded when kickstart fails', async () => {
    const { d } = deps('darwin', 501, {}, '', (call) => {
      if (call.startsWith('launchctl kickstart')) return { code: 1, stderr: 'Operation not permitted' };
      if (call.startsWith('launchctl print')) return { code: 0, stderr: '', stdout: 'gui/501/com.puck.runner.build-box-2 = {\n\tprogram = /var/folders/xx/T/puck-isolated-1/run.sh\n}\n' };
      return null;
    });
    const svc = new Service(d);
    await svc.install();
    const file = readServiceRecord(d.paths)?.file as string;
    expect(fs.readFileSync(file, 'utf8')).toContain('/puck-runner<');
    await expect(svc.start()).rejects.toThrow(/Check that run\.sh is allowed in System Settings → General → Login Items & Extensions/);
  });

  it('fails the start when launchd does not start the LaunchAgent', async () => {
    const { d, lines } = deps('darwin', 501, {}, '', (call) => (call.startsWith('launchctl kickstart') ? { code: 1, stderr: 'Operation not permitted' } : null));
    const svc = new Service(d);
    await svc.install();
    await expect(svc.start()).rejects.toThrow(/launchd did not start com\.puck\.runner\.build-box-2 \(launchctl kickstart: Operation not permitted\)\. .*Login Items/);
    expect(lines.join('\n')).not.toContain('Started');
  });

  it('uninstalls a LaunchAgent recorded by an older runner, which wrote no launcher', async () => {
    const { d } = deps('darwin', 501);
    await new Service(d).install();
    const record = readServiceRecord(d.paths);
    fs.writeFileSync(d.paths.service, JSON.stringify({ kind: 'launchd', name: record?.name, file: record?.file }));
    await new Service(d).uninstall();
    expect(fs.existsSync(record?.file as string)).toBe(false);
    expect(readServiceRecord(d.paths)).toBeNull();
  });

  it('uninstall is a no-op without a service', async () => {
    const { d, calls, lines } = deps('linux', 1000);
    await new Service(d).uninstall();
    expect(calls).toEqual([]);
    expect(lines).toEqual(['No service is installed.']);
  });
});
