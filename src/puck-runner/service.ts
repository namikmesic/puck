/**
 * `svc.sh`: running the runner as a service.
 *
 * Linux (systemd, as root: `sudo ./svc.sh install [user]`): a unit at
 * /etc/systemd/system/puck-runner.<name>.service that runs ./run.sh as the
 * given user (default: the user who ran sudo), restarts it on failure, and
 * does not restart it after exit 78, the runner's "removed from Puck" exit.
 *
 * macOS (launchd, as the user, no sudo: `./svc.sh install`): a LaunchAgent
 * at ~/Library/LaunchAgents/com.puck.runner.<name>.plist, kept alive while
 * it exits unsuccessfully. launchd has no "do not restart on this code",
 * so run.sh turns exit 78 into a clean exit under launchd. Its program is
 * the `puck-runner` launcher install writes next to run.sh, because macOS
 * names the background item after the executable; the plist names the
 * app's bundle id in AssociatedBundleIdentifiers when the runner was
 * configured with one (This Mac). Installing again rewrites that agent
 * in place. `start` bootstraps the agent and then
 * kickstarts it: launchd may hold a freshly loaded RunAtLoad job back
 * ("pended nondemand spawn"), so loading alone does not start the runner.
 *
 * The installed unit is recorded in `.service`, so `start`, `stop`,
 * `status`, `uninstall` and `config.sh remove` find it. Nothing else on the
 * host is changed. Every command is argv through the Exec seam (tests
 * record it).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LAUNCHER, launcherPath, launcherScript, launchdPlist, loginItemName } from '../harness/launch-agent';
import { writeFileAtomic, type RunnerConfig, type RunnerPaths } from './files';
import type { Exec } from './update';

export { LAUNCHER, launcherScript, launchdPlist };

/** The runner's "removed from Puck, do not restart me" exit status. */
export const REMOVED_EXIT = 78;

export interface ServiceRecord {
  kind: 'systemd' | 'launchd';
  /** systemd unit name, or launchd label. */
  name: string;
  file: string;
  user?: string;
  /** The launcher install wrote (launchd); absent in records from older runners. */
  launcher?: string;
}

export interface ServiceDeps {
  paths: RunnerPaths;
  config: RunnerConfig;
  platform: NodeJS.Platform;
  uid: number;
  env: NodeJS.ProcessEnv;
  homedir: string;
  exec: Exec;
  print(line: string): void;
  /** Where systemd units go (tests point it elsewhere). */
  systemdDir?: string;
}

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** `build-box (2)` → `build-box-2`: safe in a unit name and a launchd label. */
export function serviceSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'runner';
}

const SERVICE_LABEL_RE = /^com\.puck\.runner\.[a-z0-9-]{1,48}$/;

/** The LaunchAgent label: a configured one, or one derived from the runner name. */
export function launchdLabel(name: string, serviceLabel: string | null | undefined): string {
  return serviceLabel && SERVICE_LABEL_RE.test(serviceLabel) ? serviceLabel : `com.puck.runner.${serviceSlug(name)}`;
}

export function systemdUnit(opts: { name: string; root: string; user: string }): string {
  const q = (s: string): string => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, '\\$1')}"` : s);
  return [
    '[Unit]',
    `Description=Puck runner (${opts.name})`,
    'After=network-online.target docker.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    `ExecStart=${q(path.join(opts.root, 'run.sh'))}`,
    `WorkingDirectory=${q(opts.root)}`,
    `User=${opts.user}`,
    'Environment=PUCK_RUNNER_SERVICE=systemd',
    'Restart=on-failure',
    'RestartSec=5',
    `RestartPreventExitStatus=${REMOVED_EXIT}`,
    'KillSignal=SIGTERM',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

const why = (r: { stdout: string; stderr: string; code: number | null }): string => (r.stderr || r.stdout).trim().slice(-400) || `exit ${r.code}`;

/** The file name Login Items shows for this agent's plist. */
function backgroundItemName(plistFile: string): string {
  try {
    return loginItemName(fs.readFileSync(plistFile, 'utf8')) ?? LAUNCHER;
  } catch {
    return LAUNCHER;
  }
}

export function readServiceRecord(paths: RunnerPaths): ServiceRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(paths.service, 'utf8')) as ServiceRecord;
    return (r.kind === 'systemd' || r.kind === 'launchd') && typeof r.name === 'string' ? r : null;
  } catch {
    return null;
  }
}

export class Service {
  constructor(private readonly deps: ServiceDeps) {}

  private get kind(): 'systemd' | 'launchd' {
    if (this.deps.platform === 'linux') return 'systemd';
    if (this.deps.platform === 'darwin') return 'launchd';
    throw new ServiceError('Services are supported on Linux (systemd) and macOS (launchd).');
  }

  private requireRoot(action: string): void {
    if (this.kind === 'systemd' && this.deps.uid !== 0) throw new ServiceError(`Run it with sudo: sudo ./svc.sh ${action}`);
    if (this.kind === 'launchd' && this.deps.uid === 0) {
      throw new ServiceError(`On macOS the runner is a LaunchAgent of your own user: run ./svc.sh ${action} without sudo.`);
    }
  }

  private async must(file: string, args: string[], what: string): Promise<string> {
    const r = await this.deps.exec(file, args, { timeoutMs: 60_000 });
    if (r.code !== 0) throw new ServiceError(`${what} failed: ${why(r)}`);
    return r.stdout;
  }

  /** Loads the LaunchAgent (an already loaded one is fine) and starts it. */
  private async startLaunchd(r: ServiceRecord): Promise<void> {
    const target = `${this.domain}/${r.name}`;
    const boot = await this.deps.exec('launchctl', ['bootstrap', this.domain, r.file], { timeoutMs: 60_000 });
    if (boot.code !== 0) {
      const loaded = await this.deps.exec('launchctl', ['print', target], { timeoutMs: 60_000 });
      if (loaded.code !== 0) throw new ServiceError(`launchctl bootstrap failed: ${why(boot)}`);
    }
    const kick = await this.deps.exec('launchctl', ['kickstart', target], { timeoutMs: 60_000 });
    if (kick.code !== 0) {
      throw new ServiceError(
        `launchd did not start ${r.name} (launchctl kickstart: ${why(kick)}). ` +
          `Check that ${backgroundItemName(r.file)} is allowed in System Settings → General → Login Items & Extensions, and see ${path.join(this.deps.paths.root, '_diag', 'service.log')}.`,
      );
    }
  }

  private record(): ServiceRecord {
    const r = readServiceRecord(this.deps.paths);
    if (!r) throw new ServiceError('No service is installed. Install it first: ./svc.sh install');
    return r;
  }

  private get domain(): string {
    return `gui/${this.deps.uid}`;
  }

  async install(user?: string): Promise<void> {
    this.requireRoot('install');
    const existing = readServiceRecord(this.deps.paths);
    if (existing && !(existing.kind === 'launchd' && this.kind === 'launchd')) {
      throw new ServiceError('A service is already installed. Uninstall it first: ./svc.sh uninstall');
    }
    const slug = serviceSlug(this.deps.config.name);
    let record: ServiceRecord;
    if (this.kind === 'systemd') {
      const runAs = user || this.deps.env.SUDO_USER || 'root';
      if (!/^[a-z_][a-z0-9_.-]{0,31}$/i.test(runAs)) throw new ServiceError(`"${runAs}" is not a user name.`);
      if (runAs === 'root') this.deps.print('Warning: the service will run as root. A dedicated user in the docker group is safer.');
      const groups = await this.deps.exec('id', ['-nG', runAs]);
      if (groups.code !== 0) throw new ServiceError(`There is no user "${runAs}" on this machine.`);
      if (runAs !== 'root' && !groups.stdout.split(/\s+/).includes('docker')) {
        this.deps.print(`Warning: ${runAs} is not in the docker group. Add it: sudo usermod -aG docker ${runAs}`);
      }
      const name = `puck-runner.${slug}.service`;
      const file = path.join(this.deps.systemdDir ?? '/etc/systemd/system', name);
      writeFileAtomic(file, systemdUnit({ name: this.deps.config.name, root: this.deps.paths.root, user: runAs }), 0o644);
      record = { kind: 'systemd', name, file, user: runAs };
      await this.must('systemctl', ['daemon-reload'], 'systemctl daemon-reload');
      await this.must('systemctl', ['enable', name], `systemctl enable ${name}`);
    } else {
      const label = launchdLabel(this.deps.config.name, this.deps.config.serviceLabel);
      const file = path.join(this.deps.homedir, 'Library', 'LaunchAgents', `${label}.plist`);
      const launcher = launcherPath(this.deps.paths.root);
      if (existing?.kind === 'launchd' && existing.file !== file) fs.rmSync(existing.file, { force: true });
      fs.mkdirSync(path.join(this.deps.paths.root, '_diag'), { recursive: true, mode: 0o700 });
      writeFileAtomic(launcher, launcherScript(), 0o755);
      writeFileAtomic(file, launchdPlist({ label, root: this.deps.paths.root, appBundleId: this.deps.config.appBundleId }), 0o644);
      record = { kind: 'launchd', name: label, file, launcher };
    }
    writeFileAtomic(this.deps.paths.service, JSON.stringify(record, null, 2) + '\n', 0o644);
    this.deps.print(`Installed ${record.name}. Start it with ${this.kind === 'systemd' ? 'sudo ' : ''}./svc.sh start`);
  }

  async start(): Promise<void> {
    const r = this.record();
    this.requireRoot('start');
    if (r.kind === 'systemd') await this.must('systemctl', ['start', r.name], `systemctl start ${r.name}`);
    else await this.startLaunchd(r);
    this.deps.print(`Started ${r.name}.`);
  }

  async stop(): Promise<void> {
    const r = this.record();
    this.requireRoot('stop');
    if (r.kind === 'systemd') await this.must('systemctl', ['stop', r.name], `systemctl stop ${r.name}`);
    else await this.must('launchctl', ['bootout', `${this.domain}/${r.name}`], 'launchctl bootout');
    this.deps.print(`Stopped ${r.name}. Environments keep running.`);
  }

  async status(): Promise<void> {
    const r = this.record();
    const out =
      r.kind === 'systemd'
        ? await this.deps.exec('systemctl', ['status', '--no-pager', r.name])
        : await this.deps.exec('launchctl', ['print', `${this.domain}/${r.name}`]);
    this.deps.print((out.stdout || out.stderr).trim() || `${r.name}: not running`);
  }

  /** Stops and removes the unit; a missing unit or a stopped service is fine. */
  async uninstall(): Promise<void> {
    const r = readServiceRecord(this.deps.paths);
    if (!r) {
      this.deps.print('No service is installed.');
      return;
    }
    this.requireRoot('uninstall');
    if (r.kind === 'systemd') {
      await this.deps.exec('systemctl', ['stop', r.name]);
      await this.deps.exec('systemctl', ['disable', r.name]);
      fs.rmSync(r.file, { force: true });
      await this.deps.exec('systemctl', ['daemon-reload']);
    } else {
      await this.deps.exec('launchctl', ['bootout', `${this.domain}/${r.name}`]);
      fs.rmSync(r.file, { force: true });
      if (r.launcher) fs.rmSync(r.launcher, { force: true });
    }
    fs.rmSync(this.deps.paths.service, { force: true });
    this.deps.print(`Uninstalled ${r.name}. Environments keep running.`);
  }
}

export function defaultServiceDeps(paths: RunnerPaths, config: RunnerConfig, exec: Exec, print: (line: string) => void): ServiceDeps {
  return {
    paths,
    config,
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    env: process.env,
    homedir: os.homedir(),
    exec,
    print,
  };
}
