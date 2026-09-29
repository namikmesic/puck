/**
 * The GitHub integration: signing in to Puck with GitHub (the Puck server's
 * web flow), the install link, and the app's own GitHub API access with the
 * access token the server hands out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubProvider, installations, loadInstallLink, repositories, setConfigRepo, useGitHubDeps } from '../../src/main/providers/github';
import { githubSettings, updateGithubSettings } from '../../src/main/providers/providers-store';
import * as api from '../../src/main/server/api';
import { useServerDeps } from '../../src/main/server/http';
import { account, current, signInPending } from '../../src/main/server/session';
import { fakeGitHub, type Recorded, type Scripted } from './github-fakes';
import { APP_SLUG, startServer, WEB, type Harness } from './server-fakes';

let h: Harness;

const settle = async (until: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !until(); i++) await new Promise((r) => setTimeout(r, 5));
};

/** The browser leg of the Puck server's GitHub sign-in. */
function browser(login: string) {
  return async (authorizeUrl: string): Promise<void> => {
    const u = new URL(h.github.approve(authorizeUrl, login));
    const cb = await fetch(h.base + u.pathname + u.search, { redirect: 'manual' });
    await fetch(cb.headers.get('location') as string);
  };
}

async function signIn(login = 'octocat'): Promise<void> {
  useServerDeps({ now: () => h.clock.now(), openExternal: browser(login) }, h.base);
  await githubProvider.auth.start();
  await settle(() => current() !== null && !signInPending());
}

/** GitHub's REST API for the app's own calls; every request is recorded. */
function github(over: (req: Recorded) => Scripted | undefined) {
  return fakeGitHub((req) => over(req) ?? new Error(`unexpected ${req.method} ${req.url}`));
}

beforeEach(async () => {
  h = await startServer();
  h.github.addUser('octocat');
  h.github.addUser('me');
});

afterEach(async () => {
  await githubProvider.auth.logout();
  updateGithubSettings({ configRepo: null });
  useGitHubDeps(undefined);
  useServerDeps(null);
  await h.close();
});

describe('GitHub App install link', () => {
  it('comes from the Puck server once per session, and is gone after sign-out', async () => {
    expect(githubProvider.state().installUrl).toBeNull();
    await loadInstallLink();
    expect(h.github.calls.some((c) => c.endsWith('/app'))).toBe(false);

    await signIn();
    expect(githubProvider.state().installUrl).toBeNull();
    await loadInstallLink();
    await loadInstallLink();
    expect(githubProvider.state().installUrl).toBe(`${WEB}/apps/${APP_SLUG}/installations/new`);
    expect(h.github.calls.filter((c) => c.endsWith('/app'))).toHaveLength(1);

    await githubProvider.auth.logout();
    expect(githubProvider.state().installUrl).toBeNull();
  });

  it('asks again while the server cannot name it, and shares one request between concurrent calls', async () => {
    await signIn();
    h.github.rejectAppJwt = true; // GitHub refuses the App: the server has no slug to offer
    await loadInstallLink();
    expect(githubProvider.state().installUrl).toBeNull();

    h.github.rejectAppJwt = false;
    const appCalls = () => h.github.calls.filter((c) => c.endsWith('/app')).length;
    const before = appCalls();
    await Promise.all([loadInstallLink(), loadInstallLink()]);
    expect(appCalls() - before).toBe(1);
    expect(githubProvider.state().installUrl).toBe(`${WEB}/apps/${APP_SLUG}/installations/new`);
  });
});

describe('signing in to Puck with GitHub', () => {
  it('opens the sign-in page, reports pending, then the login from the Puck session', async () => {
    useServerDeps({ now: () => h.clock.now(), openExternal: async () => undefined }, h.base);
    expect(githubProvider.auth.status()).toMatchObject({ connected: false, detail: 'Not signed in — sign in to Puck with GitHub' });
    const url = await githubProvider.auth.start();
    expect(url).toMatch(/^https:\/\/github\.test\/login\/oauth\/authorize/);
    expect(githubProvider.auth.status().pending).toBe(true);
    expect(githubProvider.status().state).toBe('pending');
    githubProvider.auth.cancel();
    expect(githubProvider.auth.status().pending).toBe(false);

    await signIn();
    expect(githubProvider.auth.status()).toEqual({ connected: true, pending: false, detail: 'Signed in to Puck as octocat' });
    expect(githubProvider.state()).toMatchObject({ login: 'octocat', server: h.base });
    await githubProvider.auth.logout();
    expect(githubProvider.state().login).toBeNull();
    expect(account.load()).toBeNull();
  });

  it('calls GitHub with the access token the server hands out, cached until it nears expiry', async () => {
    await signIn();
    const handed = await api.githubToken();
    const gh = github((req) => (req.url.startsWith('https://api.github.com/user/installations') ? { body: { total_count: 0, installations: [] } } : undefined));
    useGitHubDeps({ ...gh.deps, now: () => h.clock.now() });
    await Promise.all([installations(), installations()]);
    const calls = gh.requests.filter((r) => r.url.startsWith('https://api.github.com/'));
    expect(calls).toHaveLength(2);
    for (const r of calls) expect(r.headers.Authorization).toBe(`Bearer ${handed.token}`);
  });

  it('drops a GitHub access token that arrives after the Puck session changed', async () => {
    await signIn('octocat');
    const gh = github((req) =>
      req.url.startsWith('https://api.github.com/user/installations') ? { body: { total_count: 0, installations: [] } } : undefined,
    );
    useGitHubDeps({ ...gh.deps, now: () => h.clock.now() });

    let releaseA!: (t: { token: string; expiresAt: number }) => void;
    const pendingA = new Promise<{ token: string; expiresAt: number }>((resolve) => {
      releaseA = resolve;
    });
    const spy = vi.spyOn(api, 'githubToken').mockImplementationOnce(() => pendingA);
    const stale = installations();
    try {
      await settle(() => spy.mock.calls.length === 1);
      await githubProvider.auth.logout();
      await signIn('me');
      spy.mockImplementation(async () => ({ token: 'ghu_me', expiresAt: h.clock.now() + 60 * 60_000 }));

      const fresh = installations();
      const arrived = await Promise.race([fresh.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100))]);
      expect(arrived).toBe(true);
      await fresh;

      releaseA({ token: 'ghu_octocat', expiresAt: h.clock.now() + 60 * 60_000 });
      await expect(stale).rejects.toThrow(/Sign in to Puck with GitHub first/);
      await installations();
      expect(gh.requests.filter((r) => r.url.startsWith('https://api.github.com/')).map((r) => r.headers.Authorization)).toEqual([
        'Bearer ghu_me',
        'Bearer ghu_me',
      ]);
    } finally {
      releaseA({ token: 'ghu_octocat', expiresAt: h.clock.now() + 60 * 60_000 });
      spy.mockRestore();
      await stale.catch(() => undefined);
    }
  });
});

describe('repositories and the config repo', () => {
  const repo = (full: string) => ({ full_name: full, private: true, default_branch: 'main', html_url: `https://github.com/${full}` });

  it('lists the repos of every installation, deduplicated and sorted', async () => {
    const gh = github((req): Scripted | undefined => {
      if (req.url.startsWith('https://api.github.com/user/installations?')) {
        return {
          body: {
            installations: [
              { id: 1, account: { login: 'me', type: 'User' }, html_url: 'https://github.com/settings/installations/1', repository_selection: 'selected' },
              { id: 2, account: { login: 'org', type: 'Organization' }, html_url: 'https://github.com/organizations/org/settings/installations/2', repository_selection: 'all' },
            ],
          },
        };
      }
      if (req.url.includes('/user/installations/1/repositories')) return { body: { repositories: [repo('me/cfg')] } };
      if (req.url.includes('/user/installations/2/repositories')) return { body: { repositories: [repo('org/app'), repo('me/cfg')] } };
      return undefined;
    });
    await signIn('me');
    useGitHubDeps(gh.deps);
    expect((await repositories()).map((r) => r.fullName)).toEqual(['me/cfg', 'org/app']);
    expect(await installations()).toEqual([
      { id: 1, account: 'me', accountType: 'User', manageUrl: 'https://github.com/settings/installations/1', repositorySelection: 'selected' },
      { id: 2, account: 'org', accountType: 'Organization', manageUrl: 'https://github.com/organizations/org/settings/installations/2', repositorySelection: 'all' },
    ]);
  });

  it('stores the canonical name of a reachable config repo and explains an unreachable one', async () => {
    const gh = github((req): Scripted | undefined => {
      if (req.url === 'https://api.github.com/repos/Me/Cfg') return { body: repo('me/cfg') };
      if (req.url === 'https://api.github.com/repos/me/private') return { status: 404, body: { message: 'Not Found' } };
      return undefined;
    });
    await signIn('me');
    useGitHubDeps(gh.deps);
    await setConfigRepo('Me/Cfg');
    expect(githubSettings().configRepo).toBe('me/cfg');
    await expect(setConfigRepo('me/private')).rejects.toThrow(/not reachable with this GitHub sign-in/);
    expect(githubSettings().configRepo).toBe('me/cfg');
  });

  it('refuses to list without a sign-in', async () => {
    useServerDeps({ now: () => h.clock.now() }, h.base);
    await expect(repositories()).rejects.toThrow(/Sign in to Puck with GitHub first/);
    expect(await installations()).toEqual([]);
  });
});
