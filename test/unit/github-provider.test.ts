/**
 * The GitHub integration: signing in to Puck with GitHub (the Puck server's
 * web flow), the install link, and the app's own GitHub API access with the
 * access token the server hands out.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_SLUG_ENV, CLIENT_ID_ENV, githubAppSlug, githubClientId, githubInstallUrl } from '../../src/main/providers/github-app';
import { githubProvider, installations, repositories, setConfigRepo, useGitHubDeps } from '../../src/main/providers/github';
import { githubSettings, updateGithubSettings } from '../../src/main/providers/providers-store';
import * as api from '../../src/main/server/api';
import { useServerDeps } from '../../src/main/server/http';
import { account, current, signInPending } from '../../src/main/server/session';
import { fakeGitHub, type Recorded, type Scripted } from './github-fakes';
import { startServer, type Harness } from './server-fakes';

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
  delete process.env[CLIENT_ID_ENV];
  delete process.env[APP_SLUG_ENV];
  await githubProvider.auth.logout();
  updateGithubSettings({ configRepo: null });
  useGitHubDeps(undefined);
  useServerDeps(null);
  await h.close();
});

describe('GitHub App identity', () => {
  it('links the install page of the registered app, with both development overrides as one test app', () => {
    expect(githubClientId({})).toBe('Iv23liEFTqLz112apImK');
    expect(githubAppSlug({})).toBe('puck-agents');
    expect(githubInstallUrl({})).toBe('https://github.com/apps/puck-agents/installations/new');
    expect(githubClientId({ [CLIENT_ID_ENV]: 'Iv1.dev', [APP_SLUG_ENV]: ' puck-dev ' })).toBe('Iv1.dev');
    expect(githubAppSlug({ [CLIENT_ID_ENV]: 'Iv1.dev', [APP_SLUG_ENV]: ' puck-dev ' })).toBe('puck-dev');
    expect(githubInstallUrl({ [CLIENT_ID_ENV]: 'Iv1.dev', [APP_SLUG_ENV]: ' puck-dev ' })).toBe(
      'https://github.com/apps/puck-dev/installations/new',
    );
  });

  it('keeps a half override on the test app and offers no install link', () => {
    process.env[CLIENT_ID_ENV] = 'Iv1.dev';
    expect(githubAppSlug()).toBeNull();
    expect(githubInstallUrl()).toBeNull();
    expect(githubProvider.state().installUrl).toBeNull();
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
