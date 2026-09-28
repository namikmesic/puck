import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Snapshot } from '../../src/harness/daemon-protocol';
import { exec, startEnv, waitReady, type Env } from './helpers';

// Scenario 1: boot. Provisioning reaches ready; the puck user owns its HOME
// and the workspace; the daemon's state is root-only and so is its socket.

let env: Env;
let client: Awaited<ReturnType<typeof waitReady>>;

beforeAll(async () => {
  env = await startEnv({
    'github.json': { accessToken: 'ghu_testtokenvalue', refreshToken: 'ghr_testtokenvalue', expiresAt: 4102444800000, login: 'octo' },
    'secrets.json': { values: { NPM_TOKEN: 'npm-secret' } },
    'harness-claude-code.json': JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } }),
  });
  client = await waitReady(env.container);
});
afterAll(async () => {
  client?.close();
  await env?.remove();
});

describe('Docker scenario 1: boot', () => {
  it('reaches ready through every provisioning stage', async () => {
    const snap = await client.cmd<Snapshot>('snapshot.get');
    expect(snap.envId).toBe(env.envId);
    expect(snap.instance.status).toBe('ready');
    expect(snap.github).toEqual({ state: 'ok', login: 'octo' });
    expect(snap.sessions.map((s) => [s.kind, s.agent, s.cwd])).toEqual([['orchestrator', 'lead', '/workspace']]);
    const logs = await client.cmd<{ text: string }>('logs.tail', { lines: 200 });
    for (const stage of ['checking-runtime', 'creating-user', 'configuring-git', 'syncing-repos', 'writing-credentials']) {
      expect(logs.text).toContain(`"stage":"${stage}"`);
    }
    expect(logs.text).not.toContain('ghu_testtokenvalue');
    expect(logs.text).not.toContain('npm-secret');
  });

  it('gives puck its HOME and the workspace, and keeps state and the socket root-only', async () => {
    const stat = await exec(env.container, [
      'stat',
      '-c',
      '%n %U %G %a',
      '/puck',
      '/puck/home',
      '/workspace',
      '/puck/state',
      '/puck/inbox',
      '/puck/state/secrets/github.json',
      '/run/puck/puckd.sock',
    ]);
    expect(stat.stdout.trim().split('\n')).toEqual([
      '/puck root root 755',
      '/puck/home puck puck 700',
      '/workspace puck puck 755',
      '/puck/state root root 700',
      '/puck/inbox root root 700',
      '/puck/state/secrets/github.json root root 600',
      '/run/puck/puckd.sock root root 600',
    ]);
    expect((await exec(env.container, ['id', 'puck'])).stdout.trim()).toBe('uid=10001(puck) gid=10001(puck) groups=10001(puck)');
    // The inbox was consumed.
    expect((await exec(env.container, ['ls', '-A', '/puck/inbox'])).stdout.trim()).toBe('');
  });

  it('clones the repo from its mirror as puck, and writes the harness credential as puck', async () => {
    const clone = await exec(env.container, ['stat', '-c', '%U %a', '/workspace/app', '/workspace/app/README.md'], 'root');
    expect(clone.stdout.trim().split('\n')).toEqual(['puck 755', 'puck 644']);
    const origin = await exec(env.container, ['git', '-C', '/workspace/app', 'remote', 'get-url', 'origin'], 'puck');
    expect(origin.stdout.trim()).toBe('file:///puck/mirrors/app.git');
    const branch = await exec(env.container, ['git', '-C', '/workspace/app', 'branch', '--show-current'], 'puck');
    expect(branch.stdout.trim()).toBe('main');
    const mirror = await exec(env.container, ['stat', '-c', '%U %a', '/puck/mirrors/app.git']);
    expect(mirror.stdout.trim()).toBe('root 755');
    const cred = await exec(env.container, ['stat', '-c', '%U %a', '/puck/home/.claude/.credentials.json']);
    expect(cred.stdout.trim()).toBe('puck 600');
    const identity = await exec(env.container, ['sh', '-c', 'HOME=/puck/home git config --global user.email'], 'puck');
    expect(identity.stdout.trim()).toBe('puck-test@example.com');
  });

  it('reports its identity with `version`', async () => {
    const r = await exec(env.container, ['node', '/opt/puck/puckd.js', 'version']);
    const v = JSON.parse(r.stdout) as { daemonVersion: string; protocolVersion: number; build: string };
    expect(v.protocolVersion).toBe(1);
    expect(v.build).toMatch(/^[0-9a-f]{64}$/);
    expect(v.daemonVersion.endsWith(`+${v.build.slice(0, 12)}`)).toBe(true);
  });
});
