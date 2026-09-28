import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubAuth, GithubGrant } from '../../src/harness/daemon-protocol';
import { ApiError, RunnerRemovedError } from '../../src/puck-runner/api';
import { DaemonLinkError, type DaemonLink } from '../../src/puck-runner/daemon-link';
import { nullLogger } from '../../src/puck-runner/log';
import { CHECK_EVERY_MS, REFRESH_BEFORE_MS, TokenPump } from '../../src/puck-runner/pump';

// The GitHub token pump on a fake clock: it pushes fresh grants when the
// daemon's are missing or close to expiry, sleeps until the refresh margin
// (never longer than the periodic check), and backs off on failures.

const ENV = 'env_01J9ZZZZZZZZZZZZZZZZZZZZZZ';
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

function setup(opts: { auth?: () => GithubAuth; linkFails?: () => Error | null; mintFails?: () => Error | null } = {}) {
  const puts: GithubGrant[][] = [];
  const opened: string[] = [];
  let removed: RunnerRemovedError | null = null;
  let auth: GithubAuth = { state: 'missing' };
  const pump = new TokenPump({
    log: nullLogger,
    now: () => Date.now(),
    link: async (envId) => {
      opened.push(envId);
      const fail = opts.linkFails?.();
      if (fail) throw fail;
      const link: DaemonLink = {
        cmd: (async (op: string, args: { grants: GithubGrant[] }) => {
          if (op === 'snapshot.get') return { github: opts.auth ? opts.auth() : auth };
          puts.push(args.grants);
          auth = { state: 'ok', expiresAt: Math.min(...args.grants.map((g) => g.expiresAt)) };
          return {};
        }) as DaemonLink['cmd'],
        close: () => undefined,
      };
      return link;
    },
    mint: async () => {
      const fail = opts.mintFails?.();
      if (fail) throw fail;
      return [{ owner: 'octo', installationId: 1, repos: ['octo/app'], token: `ghs_${Date.now()}`, expiresAt: Date.now() + 60 * MIN }];
    },
    onRemoved: (err) => (removed = err),
  });
  return { pump, puts, opened, removed: () => removed };
}

describe('token pump', () => {
  it('pushes grants to an environment without any, then refreshes 15 minutes before they expire', async () => {
    const t = setup();
    t.pump.sync([ENV]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.puts).toHaveLength(1);
    // Grants live 60 min: the pump checks at the 10-minute cap until the margin is near.
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(t.opened).toHaveLength(2);
    expect(t.puts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * MIN - REFRESH_BEFORE_MS - CHECK_EVERY_MS);
    expect(t.puts).toHaveLength(2);
    t.pump.stop();
  });

  it('leaves healthy grants alone and refreshes ones that are expiring', async () => {
    let auth: GithubAuth = { state: 'ok', expiresAt: 50 * MIN };
    const t = setup({ auth: () => auth });
    t.pump.check(ENV);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.puts).toHaveLength(0);
    auth = { state: 'expiring', expiresAt: 25 * MIN };
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(t.puts).toHaveLength(1);
    t.pump.stop();
  });

  it('retries a daemon that is not up yet within seconds, backing off', async () => {
    let fails = 2;
    const t = setup({ linkFails: () => (fails-- > 0 ? new DaemonLinkError('daemon-unavailable', 'not running') : null) });
    t.pump.check(ENV);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.puts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.puts).toHaveLength(1);
    expect(t.opened).toHaveLength(3);
    t.pump.stop();
  });

  it('leaves an environment the server refuses alone for a while, and stops the runner when it was removed', async () => {
    const refused = setup({ mintFails: () => new ApiError(409, 'instance-inactive', 'gone') });
    refused.pump.check(ENV);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(refused.opened).toHaveLength(1);
    refused.pump.stop();

    const removed = setup({ mintFails: () => new RunnerRemovedError() });
    removed.pump.check(ENV);
    await vi.advanceTimersByTimeAsync(0);
    expect(removed.removed()).toBeInstanceOf(RunnerRemovedError);
    removed.pump.stop();
  });

  it('follows the running set: new environments are checked, gone ones dropped', async () => {
    const t = setup();
    t.pump.sync([ENV, 'env_01J9YYYYYYYYYYYYYYYYYYYYYY']);
    expect(t.pump.tracked()).toHaveLength(2);
    t.pump.sync([ENV]);
    expect(t.pump.tracked()).toEqual([ENV]);
    t.pump.stop();
    expect(t.pump.tracked()).toEqual([]);
  });
});
