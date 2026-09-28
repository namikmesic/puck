/**
 * Locating the docker CLI without trusting the inherited PATH.
 *
 * A runner started by systemd or launchd gets the service manager's minimal
 * PATH, not the shell's, so a bare `docker` can fail with ENOENT even though
 * Docker is installed. Discovery is a checked sequence: an explicit
 * configured path, the well-known install locations for this platform, the
 * inherited PATH, and finally a login-shell probe. Every step is recorded
 * so a failure says exactly what was tried.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Environment variable naming an explicit docker binary (wins over discovery). */
export const DOCKER_BIN_ENV = 'PUCK_DOCKER_BIN';

export type DockerSource = 'configured' | 'well-known' | 'inherited-path' | 'login-shell';

export interface DockerLocation {
  path: string;
  source: DockerSource;
}

export interface DiscoveryDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  isExecutable(candidate: string): boolean;
  /** `command -v docker` inside a login shell; the path or null. */
  loginShellProbe(shell: string): Promise<string | null>;
}

/** Where Docker installs put (or link) the CLI, in probe order. */
export function wellKnownDockerPaths(platform: NodeJS.Platform, homedir: string): string[] {
  if (platform === 'darwin') {
    return [
      '/usr/local/bin/docker', // Docker Desktop's symlink; Homebrew on Intel
      '/opt/homebrew/bin/docker', // Homebrew on Apple silicon (the CLI colima users install)
      '/Applications/Docker.app/Contents/Resources/bin/docker', // Docker Desktop bundle
      path.join(homedir, '.docker', 'bin', 'docker'), // Docker Desktop per-user install
      path.join(homedir, '.rd', 'bin', 'docker'), // Rancher Desktop
      '/opt/local/bin/docker', // MacPorts
    ];
  }
  return [
    '/usr/bin/docker', // distribution and docker-ce packages
    '/usr/local/bin/docker', // static binaries
    '/snap/bin/docker', // the snap
    path.join(homedir, 'bin', 'docker'), // rootless install
  ];
}

export class DockerNotFoundError extends Error {
  constructor(readonly searched: string[]) {
    super(
      `Docker CLI not found. Searched: ${searched.join(', ')}. ` +
        `Install Docker Engine (Linux) or Docker Desktop or colima (macOS), or set ${DOCKER_BIN_ENV} to the binary.`,
    );
    this.name = 'DockerNotFoundError';
  }
}

function fromPathList(pathList: string | undefined, deps: DiscoveryDeps): string | null {
  if (!pathList) return null;
  for (const dir of pathList.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'docker');
    if (deps.isExecutable(candidate)) return candidate;
  }
  return null;
}

/** The checked sequence. A configured path that does not work is an error of its own, never silently replaced. */
export async function discoverDocker(deps: DiscoveryDeps): Promise<DockerLocation> {
  const searched: string[] = [];
  const configured = deps.env[DOCKER_BIN_ENV]?.trim();
  if (configured) {
    if (deps.isExecutable(configured)) return { path: configured, source: 'configured' };
    throw new Error(`${DOCKER_BIN_ENV} is set to "${configured}" but that is not an executable file.`);
  }
  searched.push(`${DOCKER_BIN_ENV} (unset)`);
  for (const candidate of wellKnownDockerPaths(deps.platform, deps.homedir)) {
    if (deps.isExecutable(candidate)) return { path: candidate, source: 'well-known' };
    searched.push(candidate);
  }
  const inherited = fromPathList(deps.env.PATH, deps);
  if (inherited) return { path: inherited, source: 'inherited-path' };
  searched.push(`PATH (${deps.env.PATH ?? 'empty'})`);
  const shell = deps.env.SHELL || (deps.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const probed = await deps.loginShellProbe(shell);
  if (probed && deps.isExecutable(probed)) return { path: probed, source: 'login-shell' };
  searched.push(`login shell (${shell} -lc 'command -v docker')`);
  throw new DockerNotFoundError(searched);
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Bounded, so a slow rc file cannot hang the runner's start. */
function loginShellProbe(shell: string, timeoutMs = 8000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shell, ['-lc', 'command -v docker'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += String(d)));
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const line = out.trim().split('\n').pop()?.trim() ?? '';
      finish(code === 0 && line.startsWith('/') ? line : null);
    });
  });
}

export const realDiscoveryDeps: DiscoveryDeps = {
  env: process.env,
  platform: process.platform,
  homedir: os.homedir(),
  isExecutable: isExecutableFile,
  loginShellProbe,
};
