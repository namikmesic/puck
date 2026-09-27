import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_ID_ENV, githubClientId, githubInstallUrl } from '../../src/main/providers/github-app';
import {
  account,
  githubProvider,
  installations,
  repositories,
  setConfigRepo,
  setPersonalToken,
  useGitHubDeps,
  type GitHubTokens,
} from '../../src/main/providers/github';
import { githubSettings, updateGithubSettings } from '../../src/main/providers/providers-store';
import { loadSecret } from '../../src/main/secrets';
import { fakeGitHub, form, type Recorded, type Scripted } from './github-fakes';

const settle = async (until: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 1));
};

const USER = { login: 'octocat', id: 583231 };

/** A GitHub that answers the OAuth and REST endpoints Puck uses. */
function github(over: (req: Recorded) => Scripted | undefined = () => undefined) {
  return fakeGitHub((req) => {
    const custom = over(req);
    if (custom) return custom;
    if (req.url === 'https://github.com/login/device/code') {
      return {
        body: {
          device_code: 'dev-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        },
      };
    }
    if (req.url === 'https://github.com/login/oauth/access_token') {
      const f = form(req);
      if (f.grant_type === 'refresh_token') {
        return {
          body: { access_token: `ghu_${f.refresh_token}_next`, expires_in: 28800, refresh_token: `${f.refresh_token}_next`, refresh_token_expires_in: 15897600 },
        };
      }
      return { body: { access_token: 'ghu_one', expires_in: 28800, refresh_token: 'ghr_one', refresh_token_expires_in: 15897600 } };
    }
    if (req.url === 'https://api.github.com/user') return { body: USER };
    return new Error(`unexpected ${req.method} ${req.url}`);
  });
}

beforeEach(() => {
  process.env[CLIENT_ID_ENV] = 'Iv1.testclient';
});

afterEach(async () => {
  delete process.env[CLIENT_ID_ENV];
  await githubProvider.auth.logout();
  updateGithubSettings({ configRepo: null, mode: 'app' });
  useGitHubDeps(undefined);
});

describe('GitHub App identity', () => {
  it('ships a placeholder that disables app sign-in until PUCK_GITHUB_CLIENT_ID is set', async () => {
    expect(githubClientId({})).toBeNull();
    expect(githubClientId({ [CLIENT_ID_ENV]: ' Iv1.dev ' })).toBe('Iv1.dev');
    expect(githubInstallUrl({})).toBe('https://github.com/apps/puck/installations/new');
    delete process.env[CLIENT_ID_ENV];
    expect(githubProvider.state().appConfigured).toBe(false);
    await expect(githubProvider.auth.start()).rejects.toThrow(/not registered/);
    expect(githubProvider.auth.status().detail).toMatch(/personal access token/);
  });
});

describe('device-flow sign-in', () => {
  it('shows the code, polls, stores the pair encrypted with the login, and reports pending meanwhile', async () => {
    const gh = github();
    useGitHubDeps(gh.deps);
    const prompt = await githubProvider.auth.start();
    expect(prompt).toEqual({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: expect.any(Number) });
    expect(githubProvider.state().pendingCode).toEqual(prompt);
    await settle(() => account.load() !== null && !githubProvider.auth.status().pending);
    const saved = account.load() as GitHubTokens;
    expect(saved).toMatchObject({ accessToken: 'ghu_one', refreshToken: 'ghr_one', login: 'octocat', userId: 583231 });
    expect(githubProvider.auth.status()).toMatchObject({ connected: true, pending: false });
    expect(githubProvider.state()).toMatchObject({ login: 'octocat', mode: 'app', pendingCode: null });
    // Nothing on the wire carries a client secret.
    expect(gh.requests.some((r) => /client_secret/.test(r.body ?? ''))).toBe(false);
    expect(loadSecret('github-oauth.bin')).toContain('ghr_one');
  });

  it('cancel drops the flow and a late result never signs in', async () => {
    let approve!: () => void;
    const approved = new Promise<void>((r) => (approve = r));
    const gh = github();
    const slow = { ...gh.deps, sleep: async () => approved };
    useGitHubDeps(slow);
    await githubProvider.auth.start();
    githubProvider.auth.cancel();
    expect(githubProvider.auth.status().pending).toBe(false);
    approve();
    await settle(() => false);
    expect(account.load()).toBeNull();
  });

  it('reports a denial on the provider status', async () => {
    const gh = github((req) => (req.url.endsWith('/access_token') ? { body: { error: 'access_denied' } } : undefined));
    useGitHubDeps(gh.deps);
    await githubProvider.auth.start();
    await settle(() => !githubProvider.auth.status().pending);
    expect(account.load()).toBeNull();
    expect(githubProvider.auth.status().detail).toBe('Sign-in failed: Sign-in was denied on GitHub.');
  });
});

describe('refresh rotation', () => {
  function signedIn(gh: ReturnType<typeof fakeGitHub>, over: Partial<GitHubTokens> = {}): void {
    account.save({
      accessToken: 'ghu_old',
      expiresAt: gh.now() + 60_000, // inside the 5-minute refresh margin
      refreshToken: 'ghr_old',
      refreshExpiresAt: gh.now() + 1_000_000_000,
      login: 'octocat',
      userId: 583231,
      ...over,
    });
  }

  it('concurrent API calls refresh once, and every call uses the rotated token', async () => {
    const gh = github((req) =>
      req.url.startsWith('https://api.github.com/user/installations') ? { body: { total_count: 0, installations: [] } } : undefined,
    );
    useGitHubDeps(gh.deps);
    signedIn(gh);
    await Promise.all([installations(), installations(), installations()]);
    const refreshes = gh.requests.filter((r) => r.url.endsWith('/access_token'));
    expect(refreshes).toHaveLength(1);
    expect(form(refreshes[0])).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ghr_old' });
    const api = gh.requests.filter((r) => r.url.startsWith('https://api.github.com/'));
    expect(api).toHaveLength(3);
    for (const r of api) expect(r.headers.Authorization).toBe('Bearer ghu_ghr_old_next');
    expect(account.load()).toMatchObject({ refreshToken: 'ghr_old_next', login: 'octocat' });
  });

  it('bad_refresh_token signs out', async () => {
    const gh = github((req) => (req.url.endsWith('/access_token') ? { body: { error: 'bad_refresh_token' } } : undefined));
    useGitHubDeps(gh.deps);
    signedIn(gh);
    await expect(installations()).rejects.toThrow(/Sign in to GitHub first/);
    expect(account.load()).toBeNull();
    expect(githubProvider.auth.status()).toMatchObject({ connected: false, detail: 'Sign-in failed: GitHub sign-in expired. Sign in again.' });
  });

  it('an expired refresh token signs out without calling GitHub', async () => {
    const gh = github();
    useGitHubDeps(gh.deps);
    signedIn(gh, { refreshExpiresAt: gh.now() - 1 });
    await expect(installations()).rejects.toThrow(/Sign in to GitHub first/);
    expect(gh.requests).toHaveLength(0);
    expect(account.load()).toBeNull();
  });
});

describe('personal access token fallback', () => {
  it('validates the token against GET /user and switches to token mode', async () => {
    const gh = github();
    useGitHubDeps(gh.deps);
    await setPersonalToken('  github_pat_abc  ');
    expect(gh.requests[0].headers.Authorization).toBe('Bearer github_pat_abc');
    expect(account.load()).toMatchObject({ accessToken: 'github_pat_abc', refreshToken: null, login: 'octocat' });
    expect(githubSettings().mode).toBe('pat');
    expect(githubProvider.auth.status().detail).toBe('Signed in as octocat (personal access token)');
    // Installation endpoints are app-only; a token lists /user/repos instead.
    expect(await installations()).toEqual([]);
  });

  it('rejects a token GitHub refuses, storing nothing', async () => {
    const gh = github((req) => (req.url.endsWith('/user') ? { status: 401, body: { message: 'Bad credentials' } } : undefined));
    useGitHubDeps(gh.deps);
    await expect(setPersonalToken('github_pat_bad')).rejects.toThrow(/rejected this token/);
    expect(account.load()).toBeNull();
  });
});

describe('repositories and the config repo', () => {
  const repo = (full: string) => ({ full_name: full, private: true, default_branch: 'main', html_url: `https://github.com/${full}` });

  it('app mode lists the repos of every installation, deduplicated and sorted', async () => {
    const gh = github((req) => {
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
    useGitHubDeps(gh.deps);
    account.save({ accessToken: 'ghu', expiresAt: null, refreshToken: null, refreshExpiresAt: null, login: 'me', userId: 1 });
    expect((await repositories()).map((r) => r.fullName)).toEqual(['me/cfg', 'org/app']);
    expect(await installations()).toEqual([
      { id: 1, account: 'me', accountType: 'User', manageUrl: 'https://github.com/settings/installations/1', repositorySelection: 'selected' },
      { id: 2, account: 'org', accountType: 'Organization', manageUrl: 'https://github.com/organizations/org/settings/installations/2', repositorySelection: 'all' },
    ]);
  });

  it('stores the canonical name of a reachable config repo and explains an unreachable one', async () => {
    const gh = github((req) => {
      if (req.url === 'https://api.github.com/repos/Me/Cfg') return { body: repo('me/cfg') };
      if (req.url === 'https://api.github.com/repos/me/private') return { status: 404, body: { message: 'Not Found' } };
      return undefined;
    });
    useGitHubDeps(gh.deps);
    account.save({ accessToken: 'ghu', expiresAt: null, refreshToken: null, refreshExpiresAt: null, login: 'me', userId: 1 });
    await setConfigRepo('Me/Cfg');
    expect(githubSettings().configRepo).toBe('me/cfg');
    await expect(setConfigRepo('me/private')).rejects.toThrow(/not reachable with this GitHub sign-in/);
    expect(githubSettings().configRepo).toBe('me/cfg');
  });

  it('refuses to list without a sign-in', async () => {
    await expect(repositories()).rejects.toThrow(/Sign in to GitHub first/);
    expect(await installations()).toEqual([]);
  });
});
