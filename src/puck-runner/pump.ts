/**
 * The GitHub token pump: keeps every environment on this host supplied
 * with installation tokens from the Puck server, so agents can push and
 * open pull requests while the app is closed.
 *
 * Tokens live an hour. For each running environment the pump opens a short
 * daemon connection, reads `github.auth` from the snapshot, and closes that
 * connection before it asks the server for fresh grants. `github.put` goes
 * over a new connection, so the link's timer never covers the mint. It
 * refreshes when the snapshot is not `ok` or expires within
 * REFRESH_BEFORE_MS, then sleeps until that margin before the earliest
 * expiry, but never longer than CHECK_EVERY_MS, so a daemon that reports
 * `expiring` or `missing` for any reason (a restart, a rebuilt container)
 * is noticed within minutes. Tokens pass through the runner's memory only:
 * never argv, never a file on the host, never a log line.
 *
 * Failures back off. A daemon that is not up yet is retried within seconds;
 * an environment the server no longer mints for (removed from the index,
 * lost every repository) is left alone for a while; a removed runner stops
 * the whole runner.
 */

import type { GithubAuth, GithubGrant } from '../harness/daemon-protocol';
import { ApiError, RunnerRemovedError } from './api';
import type { DaemonLink } from './daemon-link';
import type { Logger } from './log';

export const REFRESH_BEFORE_MS = 15 * 60_000;
export const CHECK_EVERY_MS = 10 * 60_000;
/** Never re-check sooner than this after a successful push. */
const MIN_WAIT_MS = 30_000;
const RETRY_MS = [5_000, 15_000, 60_000, 120_000, 300_000];
/** How long an environment the server refuses to mint for is left alone. */
const REFUSED_WAIT_MS = 30 * 60_000;

export interface PumpDeps {
  mint(envId: string): Promise<GithubGrant[]>;
  link(envId: string): Promise<DaemonLink>;
  log: Logger;
  now?: () => number;
  /** A removed runner stops for good. */
  onRemoved(err: RunnerRemovedError): void;
}

interface Tracked {
  timer: ReturnType<typeof setTimeout> | null;
  failures: number;
  running: boolean;
  /** A check was asked for while one was running. */
  again: boolean;
}

export class TokenPump {
  private readonly envs = new Map<string, Tracked>();
  private readonly now: () => number;
  private stopped = false;

  constructor(private readonly deps: PumpDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The running environments on this host now; new ones are checked at once, gone ones dropped. */
  sync(running: string[]): void {
    const set = new Set(running);
    for (const envId of [...this.envs.keys()]) if (!set.has(envId)) this.untrack(envId);
    for (const envId of running) if (!this.envs.has(envId)) this.check(envId);
  }

  /** Check now (a container just started, or its daemon asked). */
  check(envId: string): void {
    if (this.stopped) return;
    let t = this.envs.get(envId);
    if (!t) {
      t = { timer: null, failures: 0, running: false, again: false };
      this.envs.set(envId, t);
    }
    if (t.running) {
      t.again = true;
      return;
    }
    this.schedule(envId, t, 0);
  }

  untrack(envId: string): void {
    const t = this.envs.get(envId);
    if (t?.timer) clearTimeout(t.timer);
    this.envs.delete(envId);
  }

  stop(): void {
    this.stopped = true;
    for (const envId of [...this.envs.keys()]) this.untrack(envId);
  }

  /** Test seam: the environments tracked now. */
  tracked(): string[] {
    return [...this.envs.keys()];
  }

  private schedule(envId: string, t: Tracked, ms: number): void {
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      t.timer = null;
      void this.run(envId, t);
    }, ms);
    t.timer.unref?.();
  }

  private async run(envId: string, t: Tracked): Promise<void> {
    if (this.stopped || this.envs.get(envId) !== t) return;
    t.running = true;
    let next: number;
    try {
      next = await this.refresh(envId);
      t.failures = 0;
    } catch (err) {
      next = this.onFailure(envId, t, err);
    } finally {
      t.running = false;
    }
    if (this.stopped || this.envs.get(envId) !== t) return;
    if (t.again) {
      t.again = false;
      next = 0;
    }
    this.schedule(envId, t, next);
  }

  /** One check; returns how long to wait before the next. */
  private async refresh(envId: string): Promise<number> {
    const link = await this.deps.link(envId);
    let gh: GithubAuth;
    try {
      gh = (await link.cmd('snapshot.get', {})).github;
    } finally {
      link.close();
    }
    const now = this.now();
    if (gh.state === 'ok' && typeof gh.expiresAt === 'number' && gh.expiresAt - now > REFRESH_BEFORE_MS) {
      return clampWait(gh.expiresAt - REFRESH_BEFORE_MS - now);
    }
    const grants = await this.deps.mint(envId);
    const put = await this.deps.link(envId);
    try {
      await put.cmd('github.put', { grants });
    } finally {
      put.close();
    }
    const earliest = Math.min(...grants.map((g) => g.expiresAt));
    this.deps.log.info('pump.pushed', {
      envId,
      was: gh.state,
      installations: grants.length,
      expiresInS: Math.round((earliest - this.now()) / 1000),
    });
    return clampWait(earliest - REFRESH_BEFORE_MS - this.now());
  }

  private onFailure(envId: string, t: Tracked, err: unknown): number {
    if (err instanceof RunnerRemovedError) {
      this.deps.onRemoved(err);
      return CHECK_EVERY_MS;
    }
    if (err instanceof ApiError && [403, 404, 409].includes(err.status)) {
      this.deps.log.warn('pump.refused', { envId, status: err.status, code: err.code });
      return REFUSED_WAIT_MS;
    }
    const wait = RETRY_MS[Math.min(t.failures, RETRY_MS.length - 1)];
    t.failures++;
    this.deps.log.warn('pump.retry', {
      envId,
      failures: t.failures,
      retryInS: wait / 1000,
      error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : 'unknown',
    });
    return wait;
  }
}

function clampWait(ms: number): number {
  return Math.min(Math.max(ms, MIN_WAIT_MS), CHECK_EVERY_MS);
}
