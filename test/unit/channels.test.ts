import { describe, expect, it } from 'vitest';
import {
  CHANNELS,
  DAEMON_EVENT_CHANNEL,
  FLUSH_CHANNEL,
  FLUSHED_CHANNEL,
  INSTANCE_EVENT_CHANNEL,
  RUNNER_EVENT_CHANNEL,
} from '../../src/harness/channels';
import { useServerDeps } from '../../src/main/server/http';
import { ipcMain } from '../mocks/electron';
// Importing the main entry registers every IPC handler on the mocked ipcMain.
import '../../src/index';

describe('IPC channel table', () => {
  it('channel names are unique (and distinct from the push channels)', () => {
    const values = [
      ...Object.values(CHANNELS),
      FLUSH_CHANNEL,
      FLUSHED_CHANNEL,
      RUNNER_EVENT_CHANNEL,
      INSTANCE_EVENT_CHANNEL,
      DAEMON_EVENT_CHANNEL,
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it('main registers a handler for every bridge channel', () => {
    for (const [method, channel] of Object.entries(CHANNELS)) {
      expect(ipcMain.handlers.has(channel), `${method} → ${channel} has no handler`).toBe(true);
    }
  });

  it('carries no chat, agent, or local environment surface: turns run in environments', () => {
    const values = Object.values(CHANNELS) as string[];
    expect(values.filter((c) => /^(agent|env|convo|harness):/.test(c))).toEqual([]);
  });

  it('main registers nothing outside the table', () => {
    const known = new Set<string>(Object.values(CHANNELS));
    for (const channel of ipcMain.handlers.keys()) {
      expect(known.has(channel), `handler for unknown channel ${channel}`).toBe(true);
    }
  });

  it('the provider channels validate their payloads before touching a store or the server', async () => {
    const invoke = (channel: string, args: unknown): unknown =>
      (ipcMain.handlers.get(channel) as (event: unknown, args: unknown) => Promise<unknown>)({}, args);
    await expect(invoke(CHANNELS.githubSetConfigRepo, 'not a repo')).rejects.toThrow(/Invalid repository name/);
    await expect(invoke(CHANNELS.providerAuthStart, 'runner')).rejects.toThrow(/has no sign-in/);
  });

  it('every sign-in answers with the page it opened, GitHub (the Puck server) included', async () => {
    const invoke = (channel: string, args: unknown): unknown =>
      (ipcMain.handlers.get(channel) as (event: unknown, args: unknown) => Promise<unknown>)({}, args);
    const opened: string[] = [];
    const authorizeUrl = 'https://github.test/login/oauth/authorize?client_id=x';
    useServerDeps(
      { fetch: async () => new Response(JSON.stringify({ authorizeUrl }), { status: 200 }), openExternal: async (u) => void opened.push(u) },
      'http://puck.test',
    );
    try {
      await expect(invoke(CHANNELS.providerAuthStart, 'github')).resolves.toEqual({ url: authorizeUrl });
      expect(opened).toEqual([authorizeUrl]);
      await invoke(CHANNELS.providerAuthCancel, 'github');
    } finally {
      useServerDeps(null);
    }
  });

  it('the runner and environment channels validate ids and payloads first', async () => {
    const invoke = (channel: string, args: unknown): unknown =>
      (ipcMain.handlers.get(channel) as (event: unknown, args: unknown) => Promise<unknown>)({}, args);
    await expect(invoke(CHANNELS.runnerForceRemove, '../etc')).rejects.toThrow(/Invalid runner id/);
    await expect(invoke(CHANNELS.runnerRemovalToken, 'local')).rejects.toThrow(/Invalid runner id/);
    await expect(invoke(CHANNELS.runnerRegistrationCancel, 'PRT_x')).rejects.toThrow(/Invalid token id/);
    await expect(invoke(CHANNELS.runnerUpdate, { runnerId: 'rnr_01J8Z3X0000000000000000000', patch: { name: '-x' } })).rejects.toThrow(
      /runner name/,
    );
    await expect(invoke(CHANNELS.instanceStop, 'env_nope')).rejects.toThrow(/Invalid environment id/);
    await expect(invoke(CHANNELS.instanceStart, { definition: 'x' })).rejects.toThrow();
    await expect(
      invoke(CHANNELS.daemon, { envId: 'env_01J8Z3X0000000000000000000', op: 'github.put', args: { grants: [] } }),
    ).rejects.toThrow(/not allowed/);
    // Signed out: runner calls say how to sign in instead of reaching the server.
    await expect(invoke(CHANNELS.runnerRegistrationToken, undefined)).rejects.toThrow(/Sign in to Puck/);
    expect(await invoke(CHANNELS.runners, undefined)).toMatchObject({ signedIn: false, runners: [] });
  });

  it('the definition channels validate the pin before any GitHub call', async () => {
    const invoke = (channel: string, args: unknown): unknown =>
      (ipcMain.handlers.get(channel) as (event: unknown, args: unknown) => Promise<unknown>)({}, args);
    await expect(invoke(CHANNELS.definitionsAt, { kind: 'branch', name: '../../etc' })).rejects.toThrow(/Invalid branch name/);
    await expect(invoke(CHANNELS.definitionsAt, { kind: 'commit', name: 'HEAD' })).rejects.toThrow(/Invalid commit SHA/);
    // A valid pin with no config repo chosen fails with guidance, not a request.
    await expect(invoke(CHANNELS.definitionsAt, { kind: 'tag', name: 'v1.0.0' })).rejects.toThrow(/Choose a config repo/);
    await expect(invoke(CHANNELS.definitionRefs, undefined)).rejects.toThrow(/Choose a config repo/);
  });
});
