/**
 * `./run.sh`: the runner itself. It holds the directory lock (one runner
 * process per directory), keeps the server connection (relay.ts), pumps
 * GitHub tokens (pump.ts), answers the control channel (control.ts), and
 * checks for updates (update.ts).
 *
 * Exit codes, which run.sh and the service units act on:
 *   0   stopped (SIGTERM or SIGINT)
 *   3   updated: start the new version
 *   78  removed from Puck: do not restart
 *   1   anything else
 *
 * Exiting never stops an environment: containers belong to the Docker
 * engine and keep running, and the next runner process finds them again by
 * label.
 */

import * as fs from 'node:fs';
import { ServerApi, RunnerSession, type Fetch, type RunnerOutdatedError, type RunnerRemovedError } from './api';
import { BundleCache } from './bundles';
import type { Platform } from './configure';
import { Control } from './control';
import { openDaemonLink } from './daemon-link';
import { dockerLocation, type DockerRunner, type DockerSpawner } from './docker/client';
import { dockerHealth } from './docker/health';
import { DockerOps } from './docker/ops';
import { readConfig, readCredentials, type RunnerPaths } from './files';
import { loadRunnerKey } from './identity';
import type { Logger } from './log';
import { TokenPump } from './pump';
import { RelayConnection } from './relay';
import { REMOVED_EXIT } from './service';
import { applyUpdate, CHECK_EVERY_MS, findUpdate, UPDATE_EXIT } from './update';

export interface RunDeps {
  paths: RunnerPaths;
  version: string;
  platform: Platform;
  log: Logger;
  docker: DockerRunner;
  spawner: DockerSpawner;
  fetch?: Fetch;
  print(line: string): void;
}

export class LockError extends Error {}

/** One runner process per directory: two would fight over the server connection. */
export function acquireLock(file: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      let alive = false;
      try {
        if (pid > 0 && pid !== process.pid) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {
        alive = false;
      }
      if (alive) throw new LockError(`Another runner process (pid ${pid}) is running from this directory.`);
      fs.rmSync(file, { force: true });
    }
  }
  throw new LockError('Could not take the runner lock.');
}

export async function run(deps: RunDeps): Promise<number> {
  const { paths, log } = deps;
  const config = readConfig(paths);
  const creds = readCredentials(paths);
  const key = loadRunnerKey(paths);
  if (creds.runnerId !== config.runnerId || (creds.keyFingerprint && creds.keyFingerprint !== key.fingerprint)) {
    throw new Error('.runner, .credentials and .runner_key do not belong together. Run ./config.sh remove, then configure again.');
  }
  const release = acquireLock(paths.lock);
  log.info('runner.start', { runnerId: config.runnerId, version: deps.version, pid: process.pid });
  try {
    await dockerLocation();
  } catch (err) {
    log.warn('runner.docker-missing', { error: (err as Error).message.slice(0, 300) });
  }

  const api = new ServerApi(config.serverUrl, deps.fetch);
  const session = new RunnerSession(api, config.runnerId, key, config.serverUrl);
  const ops = new DockerOps(deps.docker);
  const bundles = new BundleCache(paths.cache);
  const mint = (envId: string) => session.withToken((token) => api.githubToken(envId, token));

  let finish: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => (finish = resolve));
  let stopping = false;

  const pump = new TokenPump({
    mint,
    link: (envId) => openDaemonLink(deps.spawner, envId, { app: 'puck-runner', build: deps.version }),
    log,
    onRemoved: (err) => onRemoved(err),
  });

  const info = async () => {
    const docker = await dockerHealth(deps.docker);
    const instances = docker.ok ? await ops.list().catch(() => []) : [];
    return { docker, instances };
  };

  const control = new Control({
    ops,
    bundles,
    log,
    mint,
    maxEnvironments: () => config.maxEnvironments,
    started: (envId) => {
      pump.check(envId);
      relay.announce();
    },
    removed: (envId) => {
      pump.untrack(envId);
      relay.announce();
    },
    info: async () => {
      const { docker, instances } = await info();
      return {
        runnerId: config.runnerId,
        name: config.name,
        version: deps.version,
        os: deps.platform.os,
        arch: deps.platform.arch,
        labels: config.labels,
        maxEnvironments: config.maxEnvironments,
        docker,
        running: instances.filter((i) => i.state === 'running').length,
      };
    },
  });

  let announced = false;
  let lastUpdateCheck = 0;
  let updating = false;
  const checkUpdate = async (force: boolean): Promise<void> => {
    if (config.disableUpdate || updating || stopping) return;
    if (!force && Date.now() - lastUpdateCheck < CHECK_EVERY_MS) return;
    lastUpdateCheck = Date.now();
    updating = true;
    try {
      const deps2 = { api, paths, version: deps.version, os: deps.platform.os, arch: deps.platform.arch, log };
      const asset = await findUpdate(deps2);
      if (!asset) return;
      // Never in the middle of a create or rebuild.
      while (control.busy && !stopping) await new Promise((r) => setTimeout(r, 2_000));
      if (stopping) return;
      await applyUpdate(deps2, asset);
      deps.print(`Updated to ${asset.version}; restarting.`);
      void shutdown(UPDATE_EXIT);
    } catch (err) {
      log.warn('update.failed', { error: (err as Error).message.slice(0, 300) });
    } finally {
      updating = false;
    }
  };

  const relay = new RelayConnection({
    runnerId: config.runnerId,
    version: deps.version,
    serverUrl: config.serverUrl,
    session,
    key: key.privateKey,
    log,
    control,
    spawner: deps.spawner,
    instanceState: (envId) => ops.state(envId),
    status: async () => {
      const { docker, instances } = await info();
      pump.sync(instances.filter((i) => i.state === 'running').map((i) => i.envId));
      return {
        version: deps.version,
        docker: { ok: docker.ok, version: docker.version, problem: docker.problem, ncpu: docker.ncpu, memTotal: docker.memTotal },
        maxEnvironments: config.maxEnvironments,
        instances: instances.map((i) => ({ envId: i.envId, state: i.state })),
      };
    },
    onRemoved: (err) => onRemoved(err),
    onOutdated: (err) => onOutdated(err),
    onConnected: () => {
      if (!announced) deps.print(`✓ Connected. Hosting environments for ${config.owner ? `@${config.owner}` : 'Puck'}; press Ctrl+C to stop.`);
      announced = true;
      void checkUpdate(false);
    },
  });

  function onRemoved(err: RunnerRemovedError): void {
    if (stopping) return;
    deps.print(err.message);
    log.error('runner.removed', undefined, { runnerId: config.runnerId });
    void shutdown(REMOVED_EXIT);
  }

  function onOutdated(err: RunnerOutdatedError): void {
    log.warn('runner.outdated', { minVersion: err.minVersion });
    if (config.disableUpdate) {
      deps.print(`${err.message} Automatic updates are off: install the new runner by hand.`);
      void shutdown(1);
      return;
    }
    void checkUpdate(true).then(() => {
      // No update was applied: try the server again later.
      if (!stopping) setTimeout(() => relay.start(), 10 * 60_000).unref();
    });
  }

  async function shutdown(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info('runner.stop', { code });
    pump.stop();
    await relay.stop();
    release();
    finish(code);
  }

  const onSignal = (): void => void shutdown(0);
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const updateTimer = setInterval(() => void checkUpdate(false), CHECK_EVERY_MS);
  updateTimer.unref();

  deps.print(`Puck runner ${config.name} (${config.runnerId}) connecting to ${config.serverUrl}…`);
  relay.start();
  const code = await exited;
  clearInterval(updateTimer);
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  return code;
}
