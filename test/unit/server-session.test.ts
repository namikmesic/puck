/**
 * Signing in to the Puck server from the app, against the real server (in
 * this process, fake GitHub, fake clock): the browser leg is scripted, the
 * loopback listener and the PKCE exchange are the app's own. Then the
 * session: stored encrypted, refreshed once however many callers ask,
 * rotated, a rejected refresh signs out, a 401 refreshes and retries, and
 * sign-out revokes the session on the server too.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as api from '../../src/main/server/api';
import { useServerDeps } from '../../src/main/server/http';
import {
  account,
  accessToken,
  authed,
  cancelSignIn,
  current,
  onSessionChange,
  signInPending,
  signOut,
  startSignIn,
} from '../../src/main/server/session';
import { loadSecret } from '../../src/main/secrets';
import { call, startServer, type Harness } from './server-fakes';

let h: Harness;
const opened: string[] = [];
const changes: boolean[] = [];
onSessionChange((signedIn) => changes.push(signedIn));

const settle = async (until: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
};

/** The browser: approve at GitHub, follow the server's callback, land on the app's loopback. */
function browser(login: string, opts: { deny?: boolean } = {}) {
  return async (authorizeUrl: string): Promise<void> => {
    opened.push(authorizeUrl);
    let githubRedirect = h.github.approve(authorizeUrl, login);
    if (opts.deny) {
      const u = new URL(githubRedirect);
      u.searchParams.delete('code');
      u.searchParams.set('error', 'access_denied');
      githubRedirect = u.toString();
    }
    const u = new URL(githubRedirect);
    const cb = await fetch(h.base + u.pathname + u.search, { redirect: 'manual' });
    const loopback = cb.headers.get('location');
    if (!loopback) throw new Error(`the server did not redirect: ${cb.status}`);
    expect(new URL(loopback).hostname).toBe('127.0.0.1');
    await fetch(loopback);
  };
}

async function signedIn(login = 'octocat'): Promise<void> {
  useServerDeps({ now: () => h.clock.now(), openExternal: browser(login) }, h.base);
  await startSignIn();
  await settle(() => current() !== null && !signInPending());
  expect(current()?.user.login).toBe(login);
}

beforeEach(async () => {
  h = await startServer();
  h.github.addUser('octocat');
  opened.length = 0;
  changes.length = 0;
});

afterEach(async () => {
  cancelSignIn();
  await account.logout();
  useServerDeps(null);
  await h.close();
});

describe('signing in to the Puck server', () => {
  it('runs the web flow through the loopback with PKCE and keeps the session encrypted', async () => {
    await signedIn();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^https:\/\/github\.test\/login\/oauth\/authorize\?/);
    const session = current();
    expect(session).toMatchObject({ server: h.base, user: { login: 'octocat' } });
    expect(session?.accessToken).toMatch(/^PSA_/);
    expect(session?.refreshToken).toMatch(/^PSR_/);
    const stored = loadSecret('puck-session.bin');
    expect(stored).toContain(session?.refreshToken);
    expect(changes).toContain(true);
    expect((await api.me()).login).toBe('octocat');
  });

  it('reports a denial and stays signed out', async () => {
    useServerDeps({ now: () => h.clock.now(), openExternal: browser('octocat', { deny: true }) }, h.base);
    await startSignIn();
    await settle(() => !signInPending());
    expect(current()).toBeNull();
    expect(account.lastError()).toMatch(/access_denied/);
  });

  it('explains a server without a GitHub App', async () => {
    const bare = await startServer({}, { github: false });
    try {
      useServerDeps({ now: () => bare.clock.now(), openExternal: async () => undefined }, bare.base);
      await expect(startSignIn()).rejects.toThrow(/no GitHub App configured/);
      expect(signInPending()).toBe(false);
    } finally {
      await bare.close();
    }
  });

  it('a sign-out during the exchange wins over the late result', async () => {
    let finish!: () => void;
    const held = new Promise<void>((r) => (finish = r));
    const real = browser('octocat');
    useServerDeps(
      {
        now: () => h.clock.now(),
        openExternal: async (url) => {
          void held.then(() => real(url));
        },
      },
      h.base,
    );
    await startSignIn();
    await account.logout();
    finish();
    await settle(() => !signInPending());
    await new Promise((r) => setTimeout(r, 50));
    expect(current()).toBeNull();
  });
});

describe('the session', () => {
  it('refreshes once for concurrent callers and rotates the pair', async () => {
    await signedIn();
    const first = current();
    h.clock.advance(15 * 60_000);
    const tokens = await Promise.all([accessToken(), accessToken(), accessToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).not.toBe(first?.accessToken);
    expect(current()?.refreshToken).not.toBe(first?.refreshToken);
    // The old refresh token is spent: presenting it again would revoke the session.
    expect((await api.me()).login).toBe('octocat');
  });

  it('signs out when the server rejects the refresh token', async () => {
    await signedIn();
    const s = current();
    await call(h, 'POST', '/v1/auth/logout', { token: s?.accessToken });
    h.clock.advance(15 * 60_000);
    await expect(accessToken()).rejects.toThrow(/Sign in to Puck first/);
    expect(account.load()).toBeNull();
  });

  it('a 401 refreshes and retries once; a revoked session signs out', async () => {
    await signedIn();
    // The server revokes the session behind the app's back.
    await call(h, 'POST', '/v1/auth/logout', { token: current()?.accessToken });
    await expect(authed('GET', '/v1/me')).rejects.toThrow(/Sign in to Puck first/);
    expect(current()).toBeNull();
  });

  it('sign-out drops the session here and revokes it on the server', async () => {
    await signedIn();
    const token = current()?.accessToken;
    await signOut();
    expect(current()).toBeNull();
    expect(changes.at(-1)).toBe(false);
    await settle(() => false);
    const res = await call(h, 'GET', '/v1/me', { token });
    expect(res.status).toBe(401);
  });

  it('a session for another server reads as signed out', async () => {
    await signedIn();
    useServerDeps({ now: () => h.clock.now() }, 'http://127.0.0.1:1');
    expect(current()).toBeNull();
    await expect(accessToken()).rejects.toThrow(/Sign in to Puck first/);
  });
});

describe('the REST client', () => {
  it('issues and revokes registration tokens, and reads runners and releases', async () => {
    await signedIn();
    const reg = await api.registrationToken();
    expect(reg.token).toMatch(/^PRT_/);
    expect(reg.serverUrl).toBe('http://puck.test');
    await api.revokeEnrollToken('registration', reg.id);
    expect(await api.listRunners()).toEqual([]);
    expect(await api.listInstances()).toEqual([]);
    expect(await api.releases()).toEqual({ latest: null, minVersion: null, assets: [] });
    const removal = await api.removalToken();
    expect(removal.token).toMatch(/^PRR_/);
  });

  it('hands the app the GitHub access token, never the refresh token', async () => {
    await signedIn();
    const gh = await api.githubToken();
    expect(gh.token).toBeTruthy();
    expect(gh.expiresAt).toBeGreaterThan(h.clock.now());
  });
});
