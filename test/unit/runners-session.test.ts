/**
 * A runner or instance list is applied only for the session that requested
 * it. A list started for one account must not land after another account
 * has signed in, and signing in drops whatever the previous account loaded.
 */

import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerInstance, ServerRunner } from '../../src/harness/server-api';
import { checkPinnedKey, localRunner, setLocalRunner } from '../../src/main/runners/store';
import { useServerDeps } from '../../src/main/server/http';
import { account } from '../../src/main/server/session';

const pending = vi.hoisted(() => [] as { kind: 'runners' | 'instances'; resolve: (value: unknown) => void }[]);

vi.mock('../../src/main/server/api', () => ({
  listRunners: () => new Promise((resolve) => pending.push({ kind: 'runners', resolve })),
  listInstances: () => new Promise((resolve) => pending.push({ kind: 'instances', resolve })),
  forceRemoveRunner: async () => undefined,
  registrationToken: async () => ({ id: 'reg', token: 'PRT_x', expiresAt: 0, serverUrl: 'http://127.0.0.1:9' }),
  removalToken: async () => ({ id: 'reg', token: 'PRR_x', expiresAt: 0, serverUrl: 'http://127.0.0.1:9' }),
  revokeEnrollToken: async () => undefined,
  releases: async () => {
    throw new Error('should-not-install');
  },
  updateRunner: async () => {
    throw new Error('no');
  },
  createInstance: async () => {
    throw new Error('no');
  },
  forgetInstance: async () => undefined,
  me: async () => ({ id: '', login: '' }),
  githubToken: async () => ({ token: '', expiresAt: 0 }),
}));

const SERVER = 'http://127.0.0.1:9';

function key(): string {
  return generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x as string;
}

function runner(id: string, publicKey: string, name = 'a-box'): ServerRunner {
  return {
    id,
    name,
    labels: ['linux', 'x64'],
    os: 'linux',
    arch: 'x64',
    version: '0.1.0',
    publicKey,
    fingerprint: 'SHA256:label',
    maxEnvironments: null,
    docker: null,
    status: 'idle',
    running: 0,
    createdAt: 1,
    lastSeenAt: 1,
  };
}

function instance(id: string, runnerId: string, owner: string): ServerInstance {
  return {
    id,
    runnerId,
    definition: 'example',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    repos: [{ owner, name: 'private', revoked: false }],
  };
}

async function signIn(id: string, login: string): Promise<void> {
  account.save({
    server: SERVER,
    accessToken: `PSA_${id}`,
    accessExpiresAt: Date.now() + 600_000,
    refreshToken: `PSR_${id}`,
    refreshExpiresAt: Date.now() + 86_400_000,
    user: { id, login },
  });
  account.notifyLogin();
}

async function settle(n: number): Promise<void> {
  for (let i = 0; i < 20 && pending.length < n; i++) await new Promise((r) => setTimeout(r, 0));
  if (pending.length < n) throw new Error(`expected ${n} list calls, saw ${pending.length}`);
}

function release(from: number, runners: ServerRunner[], instances: ServerInstance[]): void {
  const batch = pending.splice(from, pending.length - from);
  batch.find((call) => call.kind === 'runners')?.resolve(runners);
  batch.find((call) => call.kind === 'instances')?.resolve(instances);
}

beforeEach(() => {
  pending.length = 0;
  useServerDeps({}, SERVER);
});

afterEach(async () => {
  for (const call of pending.splice(0)) call.resolve([]);
  await account.logout();
  setLocalRunner(null);
  useServerDeps(null);
});

describe('runner index session fence', () => {
  it('drops a list that resolves after a different account has signed in', async () => {
    const { onRunnerOnline, refresh, serverInstances, state } = await import('../../src/main/runners');
    const nudged: string[] = [];
    onRunnerOnline((id) => nudged.push(id));
    const publicKey = key();
    const aRunner = runner('rnr_a', publicKey);
    const aInstance = instance('env_a', aRunner.id, 'alice');

    await signIn('usr_a', 'alice');
    const from = pending.length;
    const late = refresh();
    await settle(from + 2);
    await account.logout();
    await signIn('usr_b', 'bee');
    release(from, [aRunner], [aInstance]);
    await late;

    expect(state().runners.map((r) => r.id)).not.toContain(aRunner.id);
    expect(serverInstances().map((i) => i.repos.map((repo) => repo.owner)).flat()).not.toContain('alice');
    expect(nudged).not.toContain(aRunner.id);
    expect(checkPinnedKey(aRunner.id, 'SHA256:not-alice')).toBe(true);
  });

  it('keeps a list when the session that started it is still current', async () => {
    const { refresh, state } = await import('../../src/main/runners');
    const publicKey = key();
    await signIn('usr_a', 'alice');
    const from = pending.length;
    const done = refresh();
    await settle(from + 2);
    release(from, [runner('rnr_a', publicKey, 'alice-box')], []);
    await done;
    expect(state().runners.map((r) => r.name)).toEqual(['alice-box']);
  });

  it('clears the previous account on sign-in, and ignores a push from a signed-out session', async () => {
    const { onPush, refresh, state } = await import('../../src/main/runners');
    const publicKey = key();
    await signIn('usr_a', 'alice');
    const from = pending.length;
    const done = refresh();
    await settle(from + 2);
    release(from, [runner('rnr_a', publicKey, 'alice-box')], []);
    await done;
    expect(state().runners.map((r) => r.name)).toEqual(['alice-box']);

    await signIn('usr_b', 'bee');
    expect(state().runners).toEqual([]);

    await account.logout();
    onPush({ type: 'runner.upsert', runner: runner('rnr_late', key(), 'late') });
    await signIn('usr_b', 'bee');
    expect(state().runners.map((r) => r.name)).not.toContain('late');
    onPush({ type: 'runner.upsert', runner: runner('rnr_now', key(), 'now') });
    expect(state().runners.map((r) => r.name)).toEqual(['now']);
  });

  it('does not install This Mac from another account\'s runner list', async () => {
    const { installLocal } = await import('../../src/main/runners');
    await signIn('usr_a', 'alice');
    const from = pending.length;
    const installing = installLocal();
    await settle(from + 1);
    await account.logout();
    await signIn('usr_b', 'bee');
    pending[from]?.resolve([runner('rnr_a', key(), 'This Mac (mbp)')]);
    await expect(installing).rejects.toThrow(/session changed/);
  });

  it('adopts a legacy This Mac record only for the account whose list contains it', async () => {
    const { refresh } = await import('../../src/main/runners');
    const id = 'rnr_legacy';
    setLocalRunner({ runnerId: id, dir: '/legacy', socket: '/legacy/s' });
    await signIn('usr_b', 'bee');
    let from = pending.length;
    let done = refresh();
    await settle(from + 2);
    release(from, [], []);
    await done;
    expect(localRunner()).toBeNull();

    await account.logout();
    await signIn('usr_a', 'alice');
    from = pending.length;
    done = refresh();
    await settle(from + 2);
    release(from, [runner(id, key(), 'This Mac')], []);
    await done;
    expect(localRunner()).toMatchObject({ runnerId: id, dir: '/legacy', accountId: 'usr_a' });
  });
});
