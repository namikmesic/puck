/**
 * A puck-providers.json saved by the removed personal-token sign-in
 * (`github.mode: 'pat'`): it loads cleanly, the saved token is dropped and
 * GitHub reads as signed out, and a later device-flow sign-in survives the
 * next launch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Electron = typeof import('../mocks/electron');
type GitHub = typeof import('../../src/main/providers/github');
type Store = typeof import('../../src/main/providers/providers-store');
type Secrets = typeof import('../../src/main/secrets');
type JsonStore = typeof import('../../src/main/jsonstore');

/** A fresh main-process module graph over `userData` (a launch). */
async function launch(userData?: string): Promise<{
  dir: string;
  github: GitHub;
  store: Store;
  secrets: Secrets;
  jsonstore: JsonStore;
}> {
  vi.resetModules();
  const { app } = (await import('electron')) as unknown as Electron;
  const dir = app.getPath();
  if (userData) fs.cpSync(userData, dir, { recursive: true });
  return {
    dir,
    github: await import('../../src/main/providers/github'),
    store: await import('../../src/main/providers/providers-store'),
    secrets: await import('../../src/main/secrets'),
    jsonstore: await import('../../src/main/jsonstore'),
  };
}

const tokenPair = (accessToken: string, refreshToken: string | null) =>
  JSON.stringify({ accessToken, expiresAt: null, refreshToken, refreshExpiresAt: null, login: 'octocat', userId: 1 });

afterEach(() => {
  vi.resetModules();
});

describe("a settings file saved with mode 'pat'", () => {
  it('loads cleanly and reads as signed out, keeping the config repo', async () => {
    const first = await launch();
    fs.writeFileSync(
      path.join(first.dir, 'puck-providers.json'),
      JSON.stringify({ v: 1, sshHosts: [], github: { configRepo: 'me/cfg', mode: 'pat' } }),
    );
    first.secrets.saveSecret('github-oauth.bin', tokenPair('github_pat_old', null));

    await first.github.retireLegacyTokenSignIn();

    expect(first.github.account.load()).toBeNull();
    expect(first.secrets.loadSecret('github-oauth.bin')).toBeNull();
    expect(first.github.githubProvider.auth.status().connected).toBe(false);
    expect(first.github.githubProvider.state().login).toBeNull();
    expect(first.store.githubSettings()).toEqual({ configRepo: 'me/cfg' });
    await first.jsonstore.flushWrites();
    const onDisk = JSON.parse(fs.readFileSync(path.join(first.dir, 'puck-providers.json'), 'utf8')) as {
      github: Record<string, unknown>;
    };
    expect(onDisk.github).toEqual({ configRepo: 'me/cfg' });
  });

  it('never drops a device-flow sign-in made after the old token was retired', async () => {
    const first = await launch();
    fs.writeFileSync(
      path.join(first.dir, 'puck-providers.json'),
      JSON.stringify({ v: 1, sshHosts: [], github: { configRepo: null, mode: 'pat' } }),
    );
    first.secrets.saveSecret('github-oauth.bin', tokenPair('github_pat_old', null));
    await first.github.retireLegacyTokenSignIn();
    // The user signs in again with the device flow.
    first.github.account.save(JSON.parse(tokenPair('ghu_new', 'ghr_new')));
    await first.jsonstore.flushWrites();

    const second = await launch(first.dir);
    await second.github.retireLegacyTokenSignIn();
    expect(second.github.account.load()).toMatchObject({ accessToken: 'ghu_new' });
    expect(second.github.githubProvider.auth.status().connected).toBe(true);
  });

  it('leaves an app sign-in alone', async () => {
    const first = await launch();
    fs.writeFileSync(
      path.join(first.dir, 'puck-providers.json'),
      JSON.stringify({ v: 1, sshHosts: [], github: { configRepo: null, mode: 'app' } }),
    );
    first.secrets.saveSecret('github-oauth.bin', tokenPair('ghu_app', 'ghr_app'));
    await first.github.retireLegacyTokenSignIn();
    expect(first.github.account.load()).toMatchObject({ accessToken: 'ghu_app' });
  });
});
