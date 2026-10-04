/**
 * Every Docker operation on an environment, argv only, through the
 * DockerRunner seam (unit tests record the argv).
 *
 *   volumes    docker volume create --label puck=instance --label puck.env=<id> puck-<id>-data | puck-<id>-ws
 *   image      docker image inspect <image>, else docker pull <image>;
 *              or docker build -t puck-img-<id> - with the Dockerfile on stdin (no host temp dir)
 *   create     docker create --name puck-<id> --init --restart unless-stopped
 *                --security-opt no-new-privileges:true
 *                --label puck=instance --label puck.env=<id> --label puck.definition=<name>
 *                -v puck-<id>-data:/puck -v puck-<id>-ws:/workspace -w /workspace
 *                [--cpus N] [--memory M] [-e K=V ...] <image> node /opt/puck/puckd.js serve
 *   copy-in    docker cp - puck-<id>:/ with a tar stream on stdin (tar.ts: explicit root
 *              owners and modes; /puck/inbox 0700, its files 0600)
 *   start      docker start puck-<id>
 *   stop       docker stop -t 30 puck-<id>
 *   rebuild    image, stop when running, rm, create with the same volumes, copy-in of the
 *              bundle and the new definition, start
 *   delete     docker rm -f, docker volume rm of both volumes, docker image rm of a built image
 *   list       docker ps -a --filter label=puck=instance (rediscovery; nothing else is touched)
 *
 * A failure is read from the client's classification (`failure.ts`), never
 * from stderr: the tolerated ones are `not-found` outcomes, and stderr only
 * goes into the message. Every timeout is a row of `TIMEOUTS`.
 *
 * The label `puck=instance` is the whole contract: containers labelled
 * otherwise (an earlier Puck build's `puck=environment` containers, test
 * containers) are never listed or changed. No host directory and no Docker
 * socket is ever mounted, and `-e` carries only non-secret configuration;
 * secrets and credentials travel in the copy-in tar.
 */

import {
  instanceNames,
  type InstanceBuild,
  type InstanceInbox,
  type InstanceStage,
  type InstanceSummary,
} from '../../harness/runner-protocol';
import type { GithubGrant } from '../../harness/daemon-protocol';
import { tar, type TarEntry } from '../tar';
import { DockerError, stderrTail, type DockerOptions, type DockerResult, type DockerRunner } from './client';
import { TIMEOUTS } from './timeouts';

export const LABEL = 'puck=instance';

export type StageFn = (stage: InstanceStage, detail?: string) => void;

export class DockerOps {
  constructor(private readonly docker: DockerRunner) {}

  private async must(args: string[], what: string, opts: DockerOptions = {}): Promise<DockerResult> {
    const r = await this.docker(args, opts);
    if (r.failure) throw new DockerError(`${what}: ${stderrTail(r) || `docker ${args[0]} failed`}`, r);
    return r;
  }

  /* ---------- Discovery ---------- */

  /** Every `puck=instance` container on this host, from its labels. */
  async list(): Promise<InstanceSummary[]> {
    const r = await this.must(['ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{json .}}'], 'Listing environments', {
      timeoutMs: TIMEOUTS.list,
    });
    const out: InstanceSummary[] = [];
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const labels = parseLabels(typeof row.Labels === 'string' ? row.Labels : '');
      const envId = labels['puck.env'];
      if (!envId || labels.puck !== 'instance') continue;
      out.push({
        envId,
        container: typeof row.Names === 'string' ? row.Names.split(',')[0] : instanceNames(envId).container,
        state: typeof row.State === 'string' ? row.State : 'unknown',
        definition: labels['puck.definition'] ?? null,
        image: typeof row.Image === 'string' ? row.Image : '',
      });
    }
    return out;
  }

  /** True when both of the environment's volumes exist. */
  async volumesPresent(envId: string): Promise<boolean> {
    const names = instanceNames(envId);
    for (const volume of [names.data, names.workspace]) {
      const r = await this.docker(['volume', 'inspect', '--format', '{{.Name}}', volume], { timeoutMs: TIMEOUTS.inspect });
      if (!r.failure) continue;
      if (r.failure === 'not-found') return false;
      throw new DockerError(`Inspecting volume ${volume}: ${stderrTail(r)}`, r);
    }
    return true;
  }

  /** The container's state (`running`, `exited`, ...), or null when it does not exist. */
  async state(envId: string): Promise<string | null> {
    const { container } = instanceNames(envId);
    const r = await this.docker(['container', 'inspect', '--format', '{{.State.Status}}', container], { timeoutMs: TIMEOUTS.inspect });
    if (!r.failure) return r.stdout.trim() || null;
    if (r.failure === 'not-found') return null;
    throw new DockerError(`Inspecting ${container}: ${stderrTail(r)}`, r);
  }

  /* ---------- Building blocks ---------- */

  /** The image to run: pulled when missing, or built from the Dockerfile. */
  async image(build: InstanceBuild, onStage: StageFn, signal?: AbortSignal): Promise<string> {
    const names = instanceNames(build.envId);
    if (build.dockerfile !== undefined) {
      onStage('building-image', `docker build -t ${names.image} -`);
      await this.must(['build', '-t', names.image, '-'], 'Building the image', {
        input: build.dockerfile,
        timeoutMs: TIMEOUTS.build,
        signal,
        onOutput: (line) => onStage('building-image', line.slice(0, 200)),
      });
      return names.image;
    }
    const image = build.image as string;
    onStage('checking-image', image);
    const found = await this.docker(['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: TIMEOUTS.inspect });
    if (!found.failure) return image;
    if (found.failure !== 'not-found') throw new DockerError(`Inspecting image ${image}: ${stderrTail(found)}`, found);
    onStage('pulling-image', `docker pull ${image}`);
    await this.must(['pull', image], `Pulling ${image}`, {
      timeoutMs: TIMEOUTS.pull,
      signal,
      onOutput: (line) => onStage('pulling-image', line.slice(0, 200)),
    });
    return image;
  }

  async createVolumes(envId: string): Promise<void> {
    const names = instanceNames(envId);
    for (const volume of [names.data, names.workspace]) {
      await this.must(['volume', 'create', '--label', LABEL, '--label', `puck.env=${envId}`, volume], `Creating volume ${volume}`, {
        timeoutMs: TIMEOUTS.volume,
      });
    }
  }

  async createContainer(build: InstanceBuild, image: string, definitionName: string): Promise<void> {
    const names = instanceNames(build.envId);
    const args = [
      'create',
      '--name',
      names.container,
      '--init',
      '--restart',
      'unless-stopped',
      '--security-opt',
      'no-new-privileges:true',
      '--label',
      LABEL,
      '--label',
      `puck.env=${build.envId}`,
      '--label',
      `puck.definition=${definitionName}`,
      '-v',
      `${names.data}:/puck`,
      '-v',
      `${names.workspace}:/workspace`,
      '-w',
      '/workspace',
    ];
    if (build.resources?.cpus !== undefined) args.push('--cpus', String(build.resources.cpus));
    if (build.resources?.memory !== undefined) args.push('--memory', build.resources.memory);
    for (const [key, value] of Object.entries(build.containerEnv ?? {})) args.push('-e', `${key}=${value}`);
    args.push(image, 'node', '/opt/puck/puckd.js', 'serve');
    await this.must(args, 'Creating the container', { timeoutMs: TIMEOUTS.create });
  }

  /** Copies a tar stream in at the container's root. Works on a created, never started container. */
  async copyIn(envId: string, archive: Buffer): Promise<void> {
    const { container } = instanceNames(envId);
    await this.must(['cp', '-', `${container}:/`], 'Copying files into the container', { input: archive, timeoutMs: TIMEOUTS.copy });
  }

  async start(envId: string): Promise<void> {
    const { container } = instanceNames(envId);
    await this.must(['start', container], 'Starting the container', { timeoutMs: TIMEOUTS.start });
  }

  async stop(envId: string): Promise<void> {
    const { container } = instanceNames(envId);
    await this.must(['stop', '-t', String(TIMEOUTS.stopGrace / 1000), container], 'Stopping the container', { timeoutMs: TIMEOUTS.stop });
  }

  /** Removes the container (not its volumes); a missing one is fine. */
  async removeContainer(envId: string): Promise<void> {
    const { container } = instanceNames(envId);
    const r = await this.docker(['rm', '-f', container], { timeoutMs: TIMEOUTS.remove });
    if (r.failure && r.failure !== 'not-found') throw new DockerError(`Removing the container: ${stderrTail(r)}`, r);
  }

  async removeVolumes(envId: string): Promise<void> {
    const names = instanceNames(envId);
    for (const volume of [names.data, names.workspace]) {
      const r = await this.docker(['volume', 'rm', '-f', volume], { timeoutMs: TIMEOUTS.remove });
      if (r.failure && r.failure !== 'not-found') throw new DockerError(`Removing volume ${volume}: ${stderrTail(r)}`, r);
    }
  }

  /** Removes an image built for this environment; a pulled image is shared and stays. */
  async removeBuiltImage(envId: string): Promise<void> {
    const { image } = instanceNames(envId);
    const r = await this.docker(['image', 'rm', image], { timeoutMs: TIMEOUTS.remove });
    if (r.failure && r.failure !== 'not-found') throw new DockerError(`Removing the image: ${stderrTail(r)}`, r);
  }

  /* ---------- Operations ---------- */

  /** Image, volumes, container, copy-in, start. The container is removed again when a later step fails. */
  async create(
    build: InstanceBuild,
    files: { bundle: Buffer; inbox: InstanceInbox; github: GithubGrant[] },
    onStage: StageFn,
    signal?: AbortSignal,
  ): Promise<void> {
    const image = await this.image(build, onStage, signal);
    onStage('creating-volumes');
    await this.createVolumes(build.envId);
    onStage('creating-container');
    await this.createContainer(build, image, definitionName(files.inbox.instance));
    try {
      onStage('copying-files');
      await this.copyIn(build.envId, createArchive(files.bundle, files.inbox, files.github));
      onStage('starting-container');
      await this.start(build.envId);
    } catch (err) {
      await this.removeContainer(build.envId).catch(() => undefined);
      throw err;
    }
  }

  /** A new container on the same volumes: stores, secrets and workspaces survive. */
  async rebuild(build: InstanceBuild, files: { bundle: Buffer; instance: InstanceInbox['instance'] }, onStage: StageFn, signal?: AbortSignal): Promise<void> {
    const image = await this.image(build, onStage, signal);
    onStage('stopping-container');
    if ((await this.state(build.envId)) === 'running') await this.stop(build.envId);
    onStage('removing-container');
    await this.removeContainer(build.envId);
    onStage('creating-container');
    await this.createContainer(build, image, definitionName(files.instance));
    onStage('copying-files');
    await this.copyIn(build.envId, rebuildArchive(files.bundle, files.instance));
    onStage('starting-container');
    await this.start(build.envId);
  }

  async delete(envId: string, onStage: StageFn): Promise<void> {
    onStage('removing-container');
    await this.removeContainer(envId);
    onStage('removing-volumes');
    await this.removeVolumes(envId);
    onStage('removing-image');
    await this.removeBuiltImage(envId);
  }

  /** Stages a daemon bundle at /opt/puck/puckd.next.js for `daemon.upgrade`. */
  async stageDaemon(envId: string, bundle: Buffer): Promise<void> {
    await this.copyIn(envId, tar([{ name: 'opt/puck/puckd.next.js', type: 'file', mode: 0o644, body: bundle }]));
  }
}

/** `a=b,c=d` as `docker ps` prints labels. */
export function parseLabels(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of text.split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export function definitionName(instance: InstanceInbox['instance']): string {
  const def = instance.definition as { name?: unknown } | null;
  return typeof def?.name === 'string' && def.name ? def.name : instance.name;
}

const json = (v: unknown): string => JSON.stringify(v);

/** The first copy-in: the daemon bundle and the inbox (instance, GitHub grants, secrets, harness credentials). */
export function createArchive(bundle: Buffer, inbox: InstanceInbox, github: GithubGrant[]): Buffer {
  const entries: TarEntry[] = [
    { name: 'opt/puck/', type: 'dir', mode: 0o755 },
    { name: 'opt/puck/puckd.js', type: 'file', mode: 0o644, body: bundle },
    { name: 'puck/inbox/', type: 'dir', mode: 0o700 },
    { name: 'puck/inbox/instance.json', type: 'file', mode: 0o600, body: json(inbox.instance) },
  ];
  if (github.length) entries.push({ name: 'puck/inbox/github.json', type: 'file', mode: 0o600, body: json({ grants: github }) });
  if (inbox.secrets && Object.keys(inbox.secrets).length) {
    entries.push({ name: 'puck/inbox/secrets.json', type: 'file', mode: 0o600, body: json({ values: inbox.secrets }) });
  }
  for (const h of inbox.harness ?? []) {
    entries.push({ name: `puck/inbox/harness-${h.id}.json`, type: 'file', mode: 0o600, body: h.content });
  }
  return tar(entries);
}

/** A rebuild's copy-in: the bundle and the new instance.json (everything else lives on the volumes). */
export function rebuildArchive(bundle: Buffer, instance: InstanceInbox['instance']): Buffer {
  return tar([
    { name: 'opt/puck/', type: 'dir', mode: 0o755 },
    { name: 'opt/puck/puckd.js', type: 'file', mode: 0o644, body: bundle },
    { name: 'puck/inbox/', type: 'dir', mode: 0o700 },
    { name: 'puck/inbox/instance.json', type: 'file', mode: 0o600, body: json(instance) },
  ]);
}
