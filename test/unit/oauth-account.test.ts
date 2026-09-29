import { afterEach, describe, expect, it } from 'vitest';
import { createOAuthAccount, providerCredential } from '../../src/main/providers/oauth';
import { deleteSecret } from '../../src/main/secrets';

interface Tok {
  v: string;
  at: number; // freshness
}

// The token store has no in-memory cache, so each account gets its own file
// (tests must not see each other's tokens) and every file is removed after.
let seq = 0;
const stores: string[] = [];
afterEach(() => {
  for (const name of stores.splice(0)) deleteSecret(name);
});

function makeAccount(refresh: (t: Tok) => Promise<Tok | null>, refreshRejected?: (err: unknown) => boolean) {
  const name = `oauth-test-${++seq}.bin`;
  stores.push(name);
  return createOAuthAccount<Tok>({
    refreshRejected,
    storeName: name,
    freshnessOf: (t) => t.at,
    needsRefresh: (t) => t.at < 1000,
    refresh,
    parseContainerFile: (parsed) => {
      const p = parsed as Partial<Tok> | null;
      return typeof p?.at === 'number' && typeof p.v === 'string' ? { v: p.v, at: p.at } : null;
    },
  });
}

describe('createOAuthAccount', () => {
  it('round-trips tokens and clears on logout', async () => {
    const account = makeAccount(async (t) => t);
    account.save({ v: 'a', at: 5000 });
    expect(account.load()).toEqual({ v: 'a', at: 5000 });
    await account.logout();
    expect(account.load()).toBeNull();
  });

  it('adopts container credentials only when strictly fresher, and only while signed in', () => {
    const account = makeAccount(async (t) => t);
    account.adoptIfNewer(JSON.stringify({ v: 'stranger', at: 50 }));
    expect(account.load()).toBeNull(); // never signed in: a container copy is not ours
    account.save({ v: 'ours', at: 100 });
    account.adoptIfNewer(JSON.stringify({ v: 'older', at: 50 }));
    expect(account.load()?.v).toBe('ours');
    account.adoptIfNewer(JSON.stringify({ v: 'newer', at: 200 }));
    expect(account.load()?.v).toBe('newer');
    account.adoptIfNewer('{not json');
    expect(account.load()?.v).toBe('newer');
  });

  it('supersedes: fresher wins, unparseable container copies are overwritten', () => {
    const account = makeAccount(async (t) => t);
    expect(account.supersedes('{}')).toBe(false); // no tokens of our own
    account.save({ v: 'ours', at: 100 });
    expect(account.supersedes(JSON.stringify({ v: 't', at: 50 }))).toBe(true);
    expect(account.supersedes(JSON.stringify({ v: 't', at: 150 }))).toBe(false);
    expect(account.supersedes('garbage')).toBe(true);
  });

  it('keeps old tokens and records the error when a refresh fails', async () => {
    const account = makeAccount(async () => {
      throw new Error('network down');
    });
    account.save({ v: 'stale', at: 10 }); // at < 1000 → needsRefresh
    const tokens = await account.getFreshTokens();
    expect(tokens).toEqual({ v: 'stale', at: 10 }); // offline start still works
    expect(account.lastError()).toMatch(/network down/);
  });

  it('saves refreshed tokens and skips refresh when not needed', async () => {
    let refreshes = 0;
    const account = makeAccount(async (t) => {
      refreshes += 1;
      return { ...t, at: 5000 };
    });
    account.save({ v: 'x', at: 10 });
    expect(await account.getFreshTokens()).toEqual({ v: 'x', at: 5000 });
    expect(await account.getFreshTokens()).toEqual({ v: 'x', at: 5000 }); // now fresh
    expect(refreshes).toBe(1);
  });

  // Logout is a fence: every path that could write tokens after a sign-out
  // must find its result dropped, and nothing may sign the account back in.
  describe('logout fence', () => {
    it('drops a login exchange that lands after logout, keeps one started after it', async () => {
      const account = makeAccount(async (t) => t);
      const beforeLogout = account.fence(); // taken when the login started
      await account.logout();
      expect(account.save({ v: 'late', at: 9000 }, beforeLogout)).toBe(false);
      expect(account.load()).toBeNull();
      const afterLogout = account.fence();
      expect(account.save({ v: 'next', at: 9001 }, afterLogout)).toBe(true);
      expect(account.load()?.v).toBe('next');
    });

    it('drops a refresh that completes after logout and reports signed out', async () => {
      let release!: (t: Tok) => void;
      const account = makeAccount(() => new Promise<Tok>((r) => (release = r)));
      account.save({ v: 'stale', at: 10 }); // at < 1000 → needsRefresh
      const refreshing = account.getFreshTokens();
      await account.logout();
      release({ v: 'refreshed', at: 9000 });
      expect(await refreshing).toBeNull();
      expect(account.load()).toBeNull();
      expect(account.lastError()).toBeNull();
    });

    it('a refresh that fails after logout leaves no error on the signed-out account', async () => {
      let fail!: (err: Error) => void;
      const account = makeAccount(() => new Promise<Tok>((_, reject) => (fail = reject)));
      account.save({ v: 'stale', at: 10 });
      const refreshing = account.getFreshTokens();
      await account.logout();
      fail(new Error('network down'));
      expect(await refreshing).toBeNull();
      expect(account.lastError()).toBeNull();
    });

    it('container credentials never sign a logged-out account back in', async () => {
      const account = makeAccount(async (t) => t);
      account.save({ v: 'ours', at: 100 });
      await account.logout();
      account.adoptIfNewer(JSON.stringify({ v: 'container', at: 5000 }));
      expect(account.load()).toBeNull();
      expect(account.supersedes(JSON.stringify({ v: 'container', at: 5000 }))).toBe(false);
    });

    it('runs the logout hook after the local fence and propagates its failure', async () => {
      const account = makeAccount(async (t) => t);
      account.save({ v: 'x', at: 100 });
      const seenByHook: Array<Tok | null> = [];
      account.setOnLogout(async () => {
        seenByHook.push(account.load());
        throw new Error('container busy');
      });
      await expect(account.logout()).rejects.toThrow(/container busy/);
      expect(seenByHook).toEqual([null]); // tokens were already gone when the hook ran
      expect(account.load()).toBeNull();
    });

    it('a credential snapshot knows when a logout happened after it was taken', async () => {
      const account = makeAccount(async (t) => t);
      account.save({ v: 'x', at: 5000 });
      const cred = providerCredential(account, { serialize: (t) => t.v });
      expect(cred.signedIn()).toBe(true);
      const snapshot = await cred.fresh();
      expect(snapshot?.content).toBe('x');
      expect(snapshot?.current()).toBe(true);
      await account.logout();
      expect(snapshot?.current()).toBe(false);
      expect(cred.signedIn()).toBe(false);
      expect(await cred.fresh()).toBeNull();
    });
  });

  it('refreshes single-flight: concurrent callers share one rotation, saved before it is returned', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const account = makeAccount(async () => {
      calls += 1;
      await gate;
      return { v: 'rotated', at: 5000 };
    });
    account.save({ v: 'stale', at: 10 });
    const all = Promise.all([account.getFreshTokens(), account.getFreshTokens(), account.getFreshTokens()]);
    release();
    const results = await all;
    expect(calls).toBe(1);
    expect(results.map((t) => t?.v)).toEqual(['rotated', 'rotated', 'rotated']);
    expect(account.load()?.v).toBe('rotated');
    // The next stale read starts a new refresh (the flight is not cached forever).
    account.save({ v: 'stale-again', at: 20 });
    await account.getFreshTokens();
    expect(calls).toBe(2);
  });

  it('a rejected refresh token signs out, trips fences, and records why', async () => {
    class Dead extends Error {}
    const account = makeAccount(
      async () => {
        throw new Dead('GitHub sign-in expired. Sign in again.');
      },
      (err) => err instanceof Dead,
    );
    account.save({ v: 'stale', at: 10 });
    const fence = account.fence();
    expect(await account.getFreshTokens()).toBeNull();
    expect(account.load()).toBeNull();
    expect(fence.current()).toBe(false);
    expect(account.lastError()).toBe('GitHub sign-in expired. Sign in again.');
  });

  it('any other refresh failure keeps the old tokens (offline starts must not break)', async () => {
    const account = makeAccount(
      async () => {
        throw new Error('network down');
      },
      () => false,
    );
    account.save({ v: 'stale', at: 10 });
    expect((await account.getFreshTokens())?.v).toBe('stale');
    expect(account.load()?.v).toBe('stale');
    expect(account.lastError()).toBe('network down');
  });
});
