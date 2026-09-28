/**
 * Boot provisioning. Each stage reports itself through `onStage` (clients
 * see it as `instance.status { status: 'provisioning', stage }`), and a
 * failure names its stage. Stages whose inputs are unchanged since they
 * last succeeded on THIS container are skipped: the fingerprint folds in a
 * container-layer id, because a rebuilt container keeps its volumes (and
 * so the recorded fingerprints) but loses its layer (users, packages,
 * wrapper scripts).
 *
 * Every command is argv, run through the CommandRunner seam. Root runs git
 * only against the mirrors under /puck/mirrors, with hooks disabled; every
 * command in /workspace or HOME runs as the puck user.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProvisionStage } from '../harness/daemon-protocol';
import { harnessDescriptorById, type HarnessDescriptor } from '../harness/providers';
import {
  bootstrapPlan,
  describePinFailure,
  expectedPackages,
  parseInstalledVersions,
  pinnedSpec,
  verifyPins,
  verifyScript,
} from '../harness/provisioning';
import type { Credentials } from './credentials';
import { referencedHarnesses, type DaemonDefinition } from './definition';
import { type CommandRunner, type RunOptions, tailOf } from './exec';
import { codexWrapperScript, CODEX_AS_PUCK, HARNESS_PATH } from './harness/spawn';
import type { Logger } from './log';
import { PUCK_GID, PUCK_UID, PUCK_USER, type DaemonPaths } from './paths';

export const RUNTIME_MESSAGE = 'The image must provide Node 20+, git and util-linux.';

export class ProvisionError extends Error {
  constructor(
    readonly stage: ProvisionStage,
    message: string,
  ) {
    super(message);
  }
}

export interface ProvisionDeps {
  paths: DaemonPaths;
  log: Logger;
  run: CommandRunner;
  credentials: Credentials;
  definition: DaemonDefinition;
  sha: string | null;
  /** Skip package installation and verification (test images bring none). */
  skipPackages: boolean;
  /** Where repos are fetched from: `https://github.com/` (tests: a local file:// root). */
  gitBase: string;
  /** Recorded per-stage fingerprints from the last successful run. */
  prior: Record<string, string>;
  /** Apply ownership and privilege drops (false only in unit tests, which do not run as root). */
  privileged: boolean;
  onStage(stage: ProvisionStage, detail?: string): void;
  nodeVersion?: string;
  chown?: (file: string, uid: number, gid: number) => void;
}

const TIMEOUTS = {
  quick: 30_000,
  install: 15 * 60_000,
  git: 10 * 60_000,
};

/** The environment variable that tells git-askpass whose grant to answer with. */
export const ASKPASS_OWNER_ENV = 'PUCK_GIT_OWNER';

/**
 * The git-askpass helper: root's git asks it for GitHub credentials. The
 * password is the installation token of the repository's owner, named by
 * PUCK_GIT_OWNER on the git command (git's prompt does not carry the path).
 */
export function askpassScript(paths: DaemonPaths): string {
  const file = path.join(paths.secrets, 'github.json');
  const read =
    'try{const o=(process.env.' +
    ASKPASS_OWNER_ENV +
    '||"").toLowerCase();const g=(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).grants||[]).find(function(x){return String(x.owner).toLowerCase()===o});process.stdout.write(g&&g.token||"")}catch(e){}';
  return [
    '#!/bin/sh',
    '# Answers git credential prompts for the mirrors (written by puckd; root only).',
    'case "$1" in',
    '  Username*) echo x-access-token ;;',
    `  *) node -e '${read}' ${JSON.stringify(file)} ;;`,
    'esac',
    '',
  ].join('\n');
}

/** The environment of a root git command against a mirror of `github` (`owner/name`). */
export function mirrorGitEnv(paths: DaemonPaths, github: string): Record<string, string> {
  return {
    PATH: HARNESS_PATH,
    HOME: '/root',
    LANG: 'C.UTF-8',
    GIT_ASKPASS: path.join(paths.bin, 'git-askpass'),
    GIT_TERMINAL_PROMPT: '0',
    [ASKPASS_OWNER_ENV]: github.split('/')[0],
  };
}

function fingerprint(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/** This container layer's id, created on first boot of the layer. */
export function layerId(paths: DaemonPaths): string {
  try {
    const id = fs.readFileSync(paths.layerId, 'utf8').trim();
    if (id) return id;
  } catch {
    // first boot of this layer
  }
  const id = randomUUID();
  fs.mkdirSync(path.dirname(paths.layerId), { recursive: true });
  fs.writeFileSync(paths.layerId, id + '\n', { mode: 0o644 });
  return id;
}

export async function provision(deps: ProvisionDeps): Promise<Record<string, string>> {
  const { paths, log, run, definition } = deps;
  const layer = layerId(paths);
  const harnesses = referencedHarnesses(definition)
    .map((id) => harnessDescriptorById(id))
    .filter((d): d is HarnessDescriptor => !!d);
  const stages: Record<string, string> = {};
  const rootEnv: Record<string, string> = { PATH: HARNESS_PATH, HOME: '/root', LANG: 'C.UTF-8' };
  const puckEnv: Record<string, string> = { PATH: HARNESS_PATH, HOME: paths.home, USER: PUCK_USER, LANG: 'C.UTF-8' };
  const asPuck: RunOptions = deps.privileged ? { uid: PUCK_UID, gid: PUCK_GID } : {};

  const stage = async (name: ProvisionStage, inputs: unknown[] | null, body: () => Promise<string | void>): Promise<void> => {
    const fp = inputs ? fingerprint(layer, name, ...inputs) : null;
    if (fp && deps.prior[name] === fp) {
      stages[name] = fp;
      deps.onStage(name, 'unchanged');
      return;
    }
    deps.onStage(name);
    const started = Date.now();
    try {
      const detail = await body();
      if (detail) deps.onStage(name, detail);
    } catch (err) {
      if (err instanceof ProvisionError) throw err;
      throw new ProvisionError(name, (err as Error).message);
    }
    log.info('provision.stage', { stage: name, ms: Date.now() - started });
    if (fp) stages[name] = fp;
  };

  const must = async (name: ProvisionStage, argv: string[], opts: RunOptions, what: string): Promise<string> => {
    const r = await run(argv, { timeoutMs: TIMEOUTS.quick, ...opts });
    if (r.code !== 0) {
      const tail = tailOf(r.stderr || r.stdout);
      throw new ProvisionError(name, `${what} failed${r.timedOut ? ' (timed out)' : ''}${tail ? `: ${tail}` : '.'}`);
    }
    return r.stdout;
  };

  await stage('checking-runtime', [], async () => {
    const major = Number((deps.nodeVersion ?? process.versions.node).split('.')[0]);
    const r = await run(
      ['sh', '-c', 'for c in git setpriv useradd groupadd; do command -v "$c" >/dev/null 2>&1 || echo "$c"; done'],
      { env: rootEnv, timeoutMs: TIMEOUTS.quick },
    );
    const missing = [...(major >= 20 ? [] : [`node ${major}`]), ...r.stdout.split('\n').filter(Boolean)];
    if (r.code !== 0 || missing.length) {
      throw new ProvisionError('checking-runtime', `${RUNTIME_MESSAGE} Missing: ${missing.join(', ') || 'unknown'}.`);
    }
  });

  await stage('creating-user', [], async () => {
    const id = await run(['id', '-u', PUCK_USER], { env: rootEnv });
    if (id.code === 0) {
      if (id.stdout.trim() !== String(PUCK_UID)) {
        throw new ProvisionError('creating-user', `The image already has a "${PUCK_USER}" user with uid ${id.stdout.trim()}, not ${PUCK_UID}.`);
      }
    } else {
      const group = await run(['getent', 'group', String(PUCK_GID)], { env: rootEnv });
      if (group.code !== 0) {
        await must('creating-user', ['groupadd', '-g', String(PUCK_GID), PUCK_USER], { env: rootEnv }, 'groupadd');
      }
      await must(
        'creating-user',
        ['useradd', '-u', String(PUCK_UID), '-g', String(PUCK_GID), '-d', '/puck/home', '-M', '-s', '/bin/bash', PUCK_USER],
        { env: rootEnv },
        'useradd',
      );
    }
    const dirs: Array<[string, number, 'root' | 'puck']> = [
      [paths.data, 0o755, 'root'],
      [paths.state, 0o700, 'root'],
      [paths.inbox, 0o700, 'root'],
      [paths.mirrors, 0o755, 'root'],
      [paths.home, 0o700, 'puck'],
      [paths.workspace, 0o755, 'puck'],
      [path.join(paths.workspace, '.puck'), 0o755, 'puck'],
      [paths.bin, 0o755, 'root'],
    ];
    for (const [dir, mode, owner] of dirs) {
      fs.mkdirSync(dir, { recursive: true });
      // Only these exact directories are chowned (never recursively): a
      // recursive root chown inside agent-writable trees could be steered.
      if (deps.privileged) {
        const st = fs.lstatSync(dir);
        if (st.isSymbolicLink()) throw new ProvisionError('creating-user', `${dir} is a symbolic link.`);
        (deps.chown ?? fs.chownSync)(dir, owner === 'puck' ? PUCK_UID : 0, owner === 'puck' ? PUCK_GID : 0);
      }
      fs.chmodSync(dir, mode);
    }
  });

  const pins = expectedPackages(harnesses);
  const pinKey = pins.map(pinnedSpec);
  for (const step of bootstrapPlan(harnesses)) {
    const name: ProvisionStage = step.kind === 'clis' ? 'installing-clis' : 'installing-sdks';
    await stage(name, [pinKey, deps.skipPackages], async () => {
      if (deps.skipPackages) return 'skipped';
      const check = await run(['sh', '-lc', step.check], { env: rootEnv, timeoutMs: TIMEOUTS.quick });
      if (check.code === 0) return 'already installed';
      deps.onStage(name, step.install);
      await must(name, ['sh', '-lc', step.install], { env: rootEnv, timeoutMs: TIMEOUTS.install }, step.install);
    });
  }
  await stage('verifying-packages', [pinKey, deps.skipPackages], async () => {
    if (deps.skipPackages) return 'skipped';
    const r = await run(['sh', '-lc', verifyScript(pins)], { env: rootEnv, timeoutMs: TIMEOUTS.quick });
    const report = verifyPins(pins, parseInstalledVersions(r.stdout), true);
    if (report.errors.length) throw new ProvisionError('verifying-packages', describePinFailure(report, true));
  });

  // Installation tokens act as the Puck GitHub App, not as a user, so there
  // is no login to derive an identity from.
  const userName = definition.git.userName ?? 'Puck';
  const userEmail = definition.git.userEmail ?? 'puck@users.noreply.github.com';
  await stage('configuring-git', [userName, userEmail, askpassScript(paths), codexWrapperScript()], async () => {
    await must('configuring-git', ['git', 'config', '--system', '--replace-all', 'safe.directory', '*'], { env: rootEnv }, 'git config --system');
    await must('configuring-git', ['git', 'config', '--global', 'user.name', userName], { ...asPuck, env: puckEnv }, 'git config user.name');
    await must('configuring-git', ['git', 'config', '--global', 'user.email', userEmail], { ...asPuck, env: puckEnv }, 'git config user.email');
    fs.mkdirSync(paths.bin, { recursive: true });
    fs.writeFileSync(path.join(paths.bin, 'git-askpass'), askpassScript(paths), { mode: 0o755 });
    fs.chmodSync(path.join(paths.bin, 'git-askpass'), 0o755);
    const codexPath = path.join(paths.bin, path.basename(CODEX_AS_PUCK));
    fs.writeFileSync(codexPath, codexWrapperScript(), { mode: 0o755 });
    fs.chmodSync(codexPath, 0o755);
  });

  // Always runs: fetching keeps the mirrors current, and a repo added to the
  // definition is cloned here.
  await stage('syncing-repos', null, async () => {
    for (const repo of definition.repos) {
      const gitEnv = mirrorGitEnv(paths, repo.github);
      const mirror = path.join(paths.mirrors, `${repo.dir}.git`);
      const url = `${deps.gitBase}${repo.github}.git`;
      if (fs.existsSync(mirror)) {
        deps.onStage('syncing-repos', `git fetch ${repo.github}`);
        const r = await run(['git', '-c', 'core.hooksPath=/dev/null', '-C', mirror, 'fetch', '--prune', 'origin'], {
          env: gitEnv,
          timeoutMs: TIMEOUTS.git,
        });
        // A stale mirror is still usable; an unreachable GitHub must not keep the environment down.
        if (r.code !== 0) log.warn('provision.fetch-failed', { repo: repo.github, detail: tailOf(r.stderr, 2) });
      } else {
        deps.onStage('syncing-repos', `git clone --mirror ${repo.github}`);
        await must(
          'syncing-repos',
          ['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--mirror', '--', url, mirror],
          { env: gitEnv, timeoutMs: TIMEOUTS.git },
          `Cloning ${repo.github}`,
        );
      }
      const work = path.join(paths.workspace, repo.dir);
      if (!fs.existsSync(work)) {
        deps.onStage('syncing-repos', `git clone ${repo.dir}`);
        await must(
          'syncing-repos',
          ['git', 'clone', ...(repo.branch ? ['--branch', repo.branch] : []), '--', `file://${mirror}`, work],
          { ...asPuck, env: puckEnv, timeoutMs: TIMEOUTS.git },
          `Checking out ${repo.github}`,
        );
      }
    }
  });

  await stage('writing-credentials', null, async () => {
    const written = await deps.credentials.writeStaged();
    return written.length ? written.join(', ') : 'nothing new';
  });

  return stages;
}

/** The fingerprint recorded for the whole run (definition sha plus stage prints). */
export function provisionFingerprint(sha: string | null, stages: Record<string, string>): string {
  return fingerprint(sha, stages);
}
