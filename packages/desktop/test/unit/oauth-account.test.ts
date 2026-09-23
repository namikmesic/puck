import { afterEach, describe, expect, it } from 'vitest';
import { createOAuthAccount } from '../../src/main/providers/oauth';
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

function makeAccount(refresh: (t: Tok) => Promise<Tok | null>) {
  const name = `oauth-test-${++seq}.bin`;
  stores.push(name);
  return createOAuthAccount<Tok>({
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
  it('round-trips tokens and clears on logout', () => {
    const account = makeAccount(async (t) => t);
    account.save({ v: 'a', at: 5000 });
    expect(account.load()).toEqual({ v: 'a', at: 5000 });
    account.logout();
    expect(account.load()).toBeNull();
  });

  it('adopts container credentials only when strictly fresher', () => {
    const account = makeAccount(async (t) => t);
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
});
