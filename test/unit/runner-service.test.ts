import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runnerPaths, type RunnerConfig } from '../../src/puck-runner/files';
import { launchdPlist, readServiceRecord, Service, serviceSlug, systemdUnit, type ServiceDeps } from '../../src/puck-runner/service';

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
};

function deps(platform: NodeJS.Platform, uid: number, env: NodeJS.ProcessEnv = {}, groups = 'puck docker') {
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
      calls.push([file, ...args].join(' '));
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
    expect(plist).toContain('<string>/Users/u/puck-runner/run.sh</string>');
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
    expect(plist).toContain('<string>launchd</string>');
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

  it('bootstraps a LaunchAgent in the user domain on macOS, without sudo', async () => {
    const { d, calls } = deps('darwin', 501);
    const svc = new Service(d);
    await svc.install();
    const plist = path.join(dir, 'home', 'Library', 'LaunchAgents', 'com.puck.runner.build-box-2.plist');
    expect(fs.existsSync(plist)).toBe(true);
    await svc.start();
    await svc.status();
    await svc.uninstall();
    expect(calls).toEqual([
      `launchctl bootstrap gui/501 ${plist}`,
      'launchctl print gui/501/com.puck.runner.build-box-2',
      'launchctl bootout gui/501/com.puck.runner.build-box-2',
    ]);
    expect(fs.existsSync(plist)).toBe(false);
    await expect(new Service(deps('darwin', 0).d).install()).rejects.toThrow('without sudo');
  });

  it('uninstall is a no-op without a service', async () => {
    const { d, calls, lines } = deps('linux', 1000);
    await new Service(d).uninstall();
    expect(calls).toEqual([]);
    expect(lines).toEqual(['No service is installed.']);
  });
});
