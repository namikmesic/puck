/**
 * `./config.sh`: register this machine as a runner, and `./config.sh
 * remove`: take it away again. Both mirror GitHub's self-hosted runner
 * scripts.
 *
 * Configure checks Docker first and refuses with a problem the user can act
 * on, asks for a name (default: the host name), extra labels and a maximum
 * number of environments (flags answer them for scripted installs),
 * generates the Ed25519 key pair and writes `.runner_key` (0600) before
 * anything leaves the machine, registers with the registration token, and
 * writes `.runner` (0644) and `.credentials` (0600). The token itself is
 * never stored. Only `.runner` counts as configured (`isConfigured`).
 * After the Docker check and the prompts, a `.runner` that is present is
 * already configured and is left in place. A key or `.credentials` left
 * when registration did not finish, with no `.runner`, is removed before
 * a new key is written, and again if registration or those writes fail;
 * the message then says to pass `--replace` if the server already kept
 * the name.
 *
 * Remove asks whether to keep or delete the environments on this machine
 * when any exist, uninstalls the service, deletes environments when asked
 * (before deregistering, so a Docker failure leaves the runner registered
 * and the removal retryable), deregisters with the removal token (or, without
 * one, the runner's own signed request), and deletes the registration files.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import { ApiError, RunnerRemovedError, ServerApi, type Fetch, type RegisterResponse } from './api';
import type { DockerRunner } from './docker/client';
import { dockerHealth } from './docker/health';
import { DockerOps } from './docker/ops';
import {
  forgetRegistration,
  isConfigured,
  readConfig,
  writeConfig,
  writeCredentials,
  type RunnerPaths,
} from './files';
import { createRunnerKey, loadRunnerKey, signAssertion } from './identity';
import { checkSocketPath } from './local';
import { readServiceRecord, Service, ServiceError, type ServiceDeps } from './service';

export class ConfigureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigureError';
  }
}

export interface Io {
  print(line: string): void;
  /** Asks one question; resolves to the default when not interactive. */
  ask(question: string, fallback: string): Promise<string>;
  interactive: boolean;
}

export interface Platform {
  os: 'linux' | 'macos';
  arch: 'x64' | 'arm64';
}

export function currentPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): Platform | null {
  const o = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'macos' : null;
  const a = arch === 'x64' || arch === 'arm64' ? arch : null;
  return o && a ? { os: o, arch: a } : null;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/;
const LABEL_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

/** The host name as a runner name the server accepts. */
export function defaultName(hostname: string = os.hostname()): string {
  const clean = hostname.replace(/\.local$/i, '').replace(/[^A-Za-z0-9 ._()-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
  return clean || 'runner';
}

export function parseLabels(text: string): string[] {
  const labels = text
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
  for (const l of labels) if (!LABEL_RE.test(l)) throw new ConfigureError(`Label "${l}" must be lowercase letters, digits and :._- (at most 64).`);
  return [...new Set(labels)];
}

export function parseMax(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t || t === 'no limit' || t === 'none') return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ConfigureError('The maximum number of environments is a whole number from 1 to 1000.');
  return n;
}

export interface ConfigureOptions {
  url: string;
  token: string;
  name?: string;
  labels?: string;
  maxEnvironments?: string;
  unattended: boolean;
  replace: boolean;
  disableUpdate: boolean;
  /** Also listen on this unix socket for the app on this machine (the This Mac runner). */
  localSocket?: string;
  /** LaunchAgent label, when this install must not share the name-derived one. */
  serviceLabel?: string;
}

export interface ConfigureDeps {
  paths: RunnerPaths;
  docker: DockerRunner;
  fetch?: Fetch;
  io: Io;
  version: string;
  platform: Platform;
  hostname?: string;
}

export async function configure(opts: ConfigureOptions, deps: ConfigureDeps): Promise<void> {
  const { paths, io } = deps;
  if (isConfigured(paths)) {
    throw new ConfigureError('This runner is already configured. To configure it again, run ./config.sh remove first.');
  }
  let url: URL;
  try {
    url = new URL(opts.url);
  } catch {
    throw new ConfigureError('--url must be the Puck server URL, like https://puck.example.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigureError('--url must be an http(s) URL.');
  if (!/^PRT_[A-Za-z0-9]{16,}$/.test(opts.token)) throw new ConfigureError('--token must be a registration token (PRT_…) from Settings → Providers → Runners → Add runner.');
  if (opts.localSocket !== undefined) {
    const problem = checkSocketPath(opts.localSocket);
    if (problem) throw new ConfigureError(problem);
  }

  io.print(`Puck runner ${deps.version} (${deps.platform.os}-${deps.platform.arch})`);
  io.print('Checking Docker…');
  const docker = await dockerHealth(deps.docker);
  if (!docker.ok) throw new ConfigureError(docker.detail ?? 'Docker is not available.');
  const gib = docker.memTotal ? `${(docker.memTotal / 1024 ** 3).toFixed(1)} GiB` : 'unknown memory';
  io.print(`Docker ${docker.version}, ${docker.ncpu ?? '?'} CPUs, ${gib}`);

  const ask = (q: string, flag: string | undefined, fallback: string): Promise<string> =>
    flag !== undefined || opts.unattended ? Promise.resolve(flag ?? fallback) : io.ask(q, fallback);
  const fallbackName = defaultName(deps.hostname);
  const name = (await ask(`Runner name [${fallbackName}]: `, opts.name, fallbackName)).trim() || fallbackName;
  if (!NAME_RE.test(name)) throw new ConfigureError('A runner name is 1-64 letters, digits, spaces and ._()-, starting with a letter or digit.');
  const labels = parseLabels(await ask('Additional labels, comma-separated [none]: ', opts.labels, ''));
  const maxEnvironments = parseMax(await ask('Most environments this machine may host [no limit]: ', opts.maxEnvironments, ''));

  if (isConfigured(paths)) {
    throw new ConfigureError('This runner is already configured. To configure it again, run ./config.sh remove first.');
  }
  if (fs.existsSync(paths.key) || fs.existsSync(paths.credentials)) {
    forgetRegistration(paths);
    io.print('A previous registration did not finish. If the server already kept the name, pass --replace.');
  }
  const key = createRunnerKey(paths);
  const api = new ServerApi(url.origin + url.pathname.replace(/\/+$/, ''), deps.fetch);
  io.print(`Registering with ${api.baseUrl}…`);
  let res: RegisterResponse;
  let accepted = false;
  try {
    res = await api.register({
      registrationToken: opts.token,
      name,
      labels,
      os: deps.platform.os,
      arch: deps.platform.arch,
      publicKey: key.publicKey,
      runnerVersion: deps.version,
      docker: { version: docker.version, ncpu: docker.ncpu, memTotal: docker.memTotal },
      maxEnvironments,
      replace: opts.replace,
    });
    accepted = true;
    writeConfig(paths, {
      runnerId: res.runnerId,
      name: res.name,
      serverUrl: res.serverUrl.replace(/\/+$/, ''),
      labels: res.labels,
      maxEnvironments,
      disableUpdate: opts.disableUpdate,
      owner: res.owner?.login ?? null,
      localSocket: opts.localSocket ?? null,
      serviceLabel: opts.serviceLabel || null,
    });
    writeCredentials(paths, { runnerId: res.runnerId, keyFile: '.runner_key', keyFingerprint: key.fingerprint });
  } catch (err) {
    forgetRegistration(paths);
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigureError(accepted ? `${message} If the server already kept the name, pass --replace.` : message);
  }
  io.print(`✓ Runner ${res.name} (${res.runnerId}) registered to @${res.owner?.login ?? 'you'}. Key ${key.fingerprint}`);
  io.print(
    deps.platform.os === 'macos'
      ? 'Start it with ./run.sh, or run it as a service with ./svc.sh install && ./svc.sh start.'
      : 'Start it with ./run.sh, or run it as a service with sudo ./svc.sh install && sudo ./svc.sh start.',
  );
}

export interface RemoveOptions {
  token?: string;
  environments?: 'keep' | 'delete';
  unattended: boolean;
}

export interface RemoveDeps {
  paths: RunnerPaths;
  docker: DockerRunner;
  fetch?: Fetch;
  io: Io;
  service: (config: ReturnType<typeof readConfig>) => ServiceDeps;
  now?: () => number;
}

export async function remove(opts: RemoveOptions, deps: RemoveDeps): Promise<void> {
  const { paths, io } = deps;
  if (!isConfigured(paths)) throw new ConfigureError('This runner is not configured; there is nothing to remove.');
  const config = readConfig(paths);
  if (opts.token !== undefined && !/^PRR_[A-Za-z0-9]{16,}$/.test(opts.token)) {
    throw new ConfigureError('--token must be a removal token (PRR_…) from Settings → Providers → Runners → Remove.');
  }
  const ops = new DockerOps(deps.docker);

  let environments: 'keep' | 'delete' = opts.environments ?? 'keep';
  let hosted: { envId: string; definition: string | null }[] = [];
  try {
    hosted = await ops.list();
  } catch (err) {
    if (opts.environments === 'delete') throw new ConfigureError(`Cannot list the environments on this machine: ${(err as Error).message}`);
    io.print(`Could not list the environments on this machine (${(err as Error).message}); they are kept.`);
  }
  if (hosted.length && opts.environments === undefined) {
    const names = hosted.map((h) => h.definition ?? h.envId).join(', ');
    const count = `${hosted.length} Puck environment${hosted.length === 1 ? '' : 's'}`;
    if (opts.unattended || !io.interactive) {
      io.print(`This machine hosts ${count} (${names}); keeping them. Pass --delete-environments to delete them.`);
    } else {
      for (;;) {
        const answer = (await io.ask(`This machine hosts ${count} (${names}). Keep them (you can delete them later with docker) or delete them now? [keep/delete] `, 'keep'))
          .trim()
          .toLowerCase();
        if (answer === 'keep' || answer === '') break;
        if (answer === 'delete') {
          environments = 'delete';
          break;
        }
      }
    }
  }

  if (readServiceRecord(paths)) {
    io.print('Uninstalling the service…');
    try {
      await new Service(deps.service(config)).uninstall();
    } catch (err) {
      if (err instanceof ServiceError) throw new ConfigureError(`${err.message}, then run ./config.sh remove again.`);
      throw err;
    }
  }

  if (environments === 'delete') {
    for (const h of hosted) {
      io.print(`Deleting ${h.definition ?? h.envId} (${h.envId})…`);
      await ops.delete(h.envId, () => undefined);
    }
  }

  const api = new ServerApi(config.serverUrl, deps.fetch);
  io.print(`Removing this runner from ${config.serverUrl}…`);
  try {
    if (opts.token) {
      await api.remove({ runnerId: config.runnerId, environments, removalToken: opts.token });
    } else {
      const key = loadRunnerKey(paths);
      const assertion = signAssertion(config.runnerId, key.privateKey, `${config.serverUrl}/v1/runners/remove`, (deps.now ?? Date.now)());
      await api.remove({ runnerId: config.runnerId, environments, assertion });
    }
  } catch (err) {
    // Already removed on the server (for example, force-removed from Settings): finish the local cleanup.
    const gone = err instanceof RunnerRemovedError || (err instanceof ApiError && err.status === 404);
    if (!gone) throw new ConfigureError(err instanceof Error ? err.message : String(err));
    io.print('The server had already removed this runner.');
  }
  forgetRegistration(paths);
  io.print(
    environments === 'delete'
      ? `✓ Runner ${config.name} removed, and its environments deleted.`
      : `✓ Runner ${config.name} removed.${hosted.length ? ' Its environments were kept; delete them with docker when you no longer need them.' : ''}`,
  );
}
