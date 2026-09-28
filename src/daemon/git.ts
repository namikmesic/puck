/**
 * Git for work items: the workspace side as the puck user, the mirror side
 * as root.
 *
 *   /workspace/<dir>                     the working clone (puck); origin is
 *                                        file:///puck/mirrors/<dir>.git
 *   /workspace/.puck/worktrees/W-<n>     one worktree and branch per item (puck)
 *   /puck/mirrors/<dir>.git              the bare mirror (root), the only
 *                                        place with a GitHub remote
 *
 * Root never runs git inside /workspace and never opens a file the puck
 * user controls: every root command targets a mirror, with hooks disabled,
 * and commits move from a worktree to its mirror as a bundle that the
 * puck-side git writes to stdout and the daemon stores under /puck/state.
 * Pushes are fenced to `puck/*` branches.
 *
 * Commands on one repository run one after another (a per-repository
 * chain), so a mirror fetch with --prune never races a publish that has
 * fetched a branch from a bundle but not pushed it yet, and concurrent
 * worktree operations never trip over git's lock files.
 */

import * as path from 'node:path';
import type { ItemResult } from '../harness/daemon-protocol';
import { type CommandRunner, type RunOptions, tailOf } from './exec';
import { HARNESS_PATH } from './harness/spawn';
import { validBranch } from './definition';
import { PUCK_USER, type DaemonPaths } from './paths';
import { mirrorGitEnv } from './provision';

const GIT_TIMEOUT_MS = 10 * 60_000;
const QUICK_MS = 60_000;

export const RESULT_LIMITS = {
  summaryBytes: 4 * 1024,
  commits: 100,
  diffTextBytes: 8 * 1024,
  uncommitted: 200,
} as const;

/** `puck/W-<n>-<slug>`: the only branch shape the daemon pushes. */
const PUSHABLE_RE = /^puck\/W-\d{1,9}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export function pushable(branch: string): boolean {
  return PUSHABLE_RE.test(branch) && validBranch(branch);
}

/** The title lowercased, non-alphanumerics collapsed to `-`, at most 40 characters. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
}

export function itemBranch(number: number, title: string): string {
  const slug = slugify(title);
  return slug ? `puck/W-${number}-${slug}` : `puck/W-${number}`;
}

export class GitError extends Error {}

export interface GitDeps {
  paths: DaemonPaths;
  run: CommandRunner;
  /** How to run as the puck user ({uid, gid} in the container; {} in tests). */
  asPuck: Pick<RunOptions, 'uid' | 'gid'>;
}

/** Parse `git diff --shortstat` output. */
export function parseShortstat(text: string): { files: number; insertions: number; deletions: number } {
  const num = (re: RegExp): number => Number(re.exec(text)?.[1] ?? 0);
  return {
    files: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  };
}

export function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  let out = text.slice(0, max);
  while (Buffer.byteLength(out, 'utf8') > max - 3) out = out.slice(0, -1);
  return `${out}…`;
}

export class Git {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: GitDeps) {}

  workspaceDir(dir: string): string {
    return path.join(this.deps.paths.workspace, dir);
  }

  mirrorDir(dir: string): string {
    return path.join(this.deps.paths.mirrors, `${dir}.git`);
  }

  worktreeDir(number: number): string {
    return path.join(this.deps.paths.workspace, '.puck', 'worktrees', `W-${number}`);
  }

  /** Run `fn` after every earlier command on the same repository. */
  serial<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(dir) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      dir,
      next.catch(() => undefined),
    );
    return next;
  }

  private puckEnv(): Record<string, string> {
    return { PATH: HARNESS_PATH, HOME: this.deps.paths.home, USER: PUCK_USER, LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' };
  }

  /** git as the puck user; throws GitError with the output tail unless `allowFail`. */
  private async asPuck(argv: string[], opts: { allowFail?: boolean; stdoutTo?: string; timeoutMs?: number } = {}) {
    const r = await this.deps.run(['git', ...argv], {
      ...this.deps.asPuck,
      env: this.puckEnv(),
      timeoutMs: opts.timeoutMs ?? QUICK_MS,
      ...(opts.stdoutTo ? { stdoutTo: opts.stdoutTo } : {}),
    });
    if (r.code !== 0 && !opts.allowFail) {
      const sub = argv[0] === '-C' ? argv[2] : argv[0];
      throw new GitError(`git ${sub} failed${r.timedOut ? ' (timed out)' : ''}: ${tailOf(r.stderr || r.stdout, 3) || `exit ${String(r.code)}`}`);
    }
    return r;
  }

  /** git as root against a mirror (hooks off); `github` picks the grant askpass answers with. */
  private async asRoot(mirror: string, github: string, argv: string[], timeoutMs = GIT_TIMEOUT_MS) {
    const r = await this.deps.run(['git', '-c', 'core.hooksPath=/dev/null', '-C', mirror, ...argv], {
      env: mirrorGitEnv(this.deps.paths, github),
      timeoutMs,
    });
    if (r.code !== 0) {
      const sub = argv.find((a, i) => !a.startsWith('-') && argv[i - 1] !== '-c') ?? 'command';
      throw new GitError(`git ${sub} failed${r.timedOut ? ' (timed out)' : ''}: ${tailOf(r.stderr || r.stdout, 3) || `exit ${String(r.code)}`}`);
    }
    return r;
  }

  /* ---------- Mirror (root) ---------- */

  fetchMirror(dir: string, github: string): Promise<void> {
    return this.asRoot(this.mirrorDir(dir), github, ['fetch', '--prune', 'origin']).then(() => undefined);
  }

  /** Bring a branch from a bundle file (under /puck/state) into the mirror. */
  fetchBundle(dir: string, github: string, bundle: string, branch: string): Promise<void> {
    if (!pushable(branch)) return Promise.reject(new GitError(`Refusing to take ${branch}: only puck/* branches are published.`));
    return this.asRoot(this.mirrorDir(dir), github, ['fetch', bundle, `+refs/heads/${branch}:refs/heads/${branch}`]).then(
      () => undefined,
    );
  }

  /**
   * Push one puck/* branch from the mirror, leased on what we pushed last
   * (empty: the branch must not exist on GitHub yet).
   */
  async push(dir: string, github: string, branch: string, lease: string | null): Promise<void> {
    if (!pushable(branch)) throw new GitError(`Refusing to push ${branch}: only puck/* branches are pushed.`);
    if (lease !== null && !/^[0-9a-f]{40,64}$/.test(lease)) throw new GitError('Invalid lease.');
    const r = await this.deps.run(
      [
        'git',
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        this.mirrorDir(dir),
        // A mirror clone pushes every ref by default; push only this one.
        '-c',
        'remote.origin.mirror=false',
        'push',
        '--porcelain',
        `--force-with-lease=refs/heads/${branch}:${lease ?? ''}`,
        'origin',
        `refs/heads/${branch}:refs/heads/${branch}`,
      ],
      { env: mirrorGitEnv(this.deps.paths, github), timeoutMs: GIT_TIMEOUT_MS },
    );
    if (r.code === 0) return;
    // --porcelain reports each ref as "<flag>\t<from>:<to>\t<summary>" on stdout.
    const refLine = r.stdout.split('\n').find((l) => l.startsWith('!\t'));
    const summary = refLine?.split('\t')[2]?.trim();
    if (summary && /stale info|fetch first|non-fast-forward/.test(summary)) {
      const reason = /\(([^)]+)\)\s*$/.exec(summary)?.[1] ?? summary;
      throw new GitError(`GitHub refused the push of ${branch} (${reason}): the branch changed on GitHub since Puck last pushed it.`);
    }
    const detail = summary ?? tailOf(r.stderr || r.stdout, 3);
    throw new GitError(`git push failed${r.timedOut ? ' (timed out)' : ''}: ${detail || `exit ${String(r.code)}`}`);
  }

  /* ---------- Workspace (puck) ---------- */

  async fetchWorkspace(dir: string): Promise<void> {
    await this.asPuck(['-C', this.workspaceDir(dir), 'fetch', '--prune', 'origin'], { timeoutMs: GIT_TIMEOUT_MS });
  }

  /** The repository's default branch as the workspace clone sees it (origin/HEAD). */
  async defaultBranch(dir: string): Promise<string> {
    const r = await this.asPuck(['-C', this.workspaceDir(dir), 'rev-parse', '--abbrev-ref', 'origin/HEAD']);
    const name = r.stdout.trim().replace(/^origin\//, '');
    if (!name || name === 'HEAD' || !validBranch(name)) throw new GitError('Could not tell the repository’s default branch.');
    return name;
  }

  async revParse(cwd: string, ref: string): Promise<string> {
    const r = await this.asPuck(['-C', cwd, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    return r.stdout.trim();
  }

  /**
   * Create the item's worktree on a new branch from origin/<base>, or adopt
   * one an interrupted dispatch already created. Returns the commit the
   * branch was created from.
   */
  async addWorktree(dir: string, worktree: string, branch: string, base: string): Promise<string> {
    const work = this.workspaceDir(dir);
    if (!validBranch(branch) || !validBranch(base)) throw new GitError('Invalid branch name.');
    const baseSha = await this.revParse(work, `refs/remotes/origin/${base}`);
    const existing = await this.asPuck(['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
    if (existing.code === 0 && existing.stdout.trim() === branch) return this.forkPoint(work, branch, base);
    const hasBranch = await this.asPuck(['-C', work, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true });
    if (hasBranch.code === 0) {
      await this.asPuck(['-C', work, 'worktree', 'add', worktree, branch]);
      return this.forkPoint(work, branch, base);
    }
    await this.asPuck(['-C', work, 'worktree', 'add', '-b', branch, worktree, baseSha]);
    return baseSha;
  }

  private async forkPoint(work: string, branch: string, base: string): Promise<string> {
    const merged = await this.asPuck(
      ['-C', work, 'merge-base', '--end-of-options', `refs/heads/${branch}`, `refs/remotes/origin/${base}`],
      { allowFail: true },
    );
    const sha = merged.stdout.trim();
    if (merged.code === 0 && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
    return this.revParse(work, `refs/heads/${branch}`);
  }

  async removeWorktree(dir: string, worktree: string): Promise<void> {
    await this.asPuck(['-C', this.workspaceDir(dir), 'worktree', 'remove', '--force', worktree], { allowFail: true });
    await this.asPuck(['-C', this.workspaceDir(dir), 'worktree', 'prune'], { allowFail: true });
  }

  /** Commits, diff stat and uncommitted files of a worktree relative to its base. */
  async capture(worktree: string, baseSha: string): Promise<Omit<ItemResult, 'summary' | 'interrupted' | 'endedAt'> & { head: string }> {
    const log = await this.asPuck(['-C', worktree, 'log', '--format=%H%x09%s', `${baseSha}..HEAD`]);
    const commits = log.stdout
      .split('\n')
      .filter(Boolean)
      .slice(0, RESULT_LIMITS.commits)
      .map((line) => {
        const tab = line.indexOf('\t');
        return { sha: line.slice(0, tab), subject: line.slice(tab + 1).slice(0, 300) };
      });
    const short = await this.asPuck(['-C', worktree, 'diff', '--shortstat', `${baseSha}...HEAD`]);
    const stat = await this.asPuck(['-C', worktree, 'diff', '--stat=120', `${baseSha}...HEAD`]);
    const status = await this.asPuck(['-C', worktree, 'status', '--porcelain=v1']);
    const head = await this.revParse(worktree, 'HEAD');
    return {
      commits,
      diffStat: { ...parseShortstat(short.stdout), text: capBytes(stat.stdout.trimEnd(), RESULT_LIMITS.diffTextBytes) },
      uncommitted: status.stdout
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, RESULT_LIMITS.uncommitted),
      head,
    };
  }

  /** Write `<base>..<branch>` of a worktree as a bundle to `file` (git runs as puck; the daemon writes the file). */
  async bundle(worktree: string, baseSha: string, branch: string, file: string): Promise<void> {
    await this.asPuck(['-C', worktree, 'bundle', 'create', '-', `${baseSha}..refs/heads/${branch}`], { stdoutTo: file, timeoutMs: GIT_TIMEOUT_MS });
  }
}

