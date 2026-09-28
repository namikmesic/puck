import { describe, expect, it } from 'vitest';
import { CHANNELS, EVENT_CHANNEL, FLUSH_CHANNEL, FLUSHED_CHANNEL } from '../../src/harness/channels';
import { ipcMain } from '../mocks/electron';
// Importing the main entry registers every IPC handler on the mocked ipcMain.
import '../../src/index';

describe('IPC channel table', () => {
  it('channel names are unique (and distinct from the push channels)', () => {
    const values = [...Object.values(CHANNELS), EVENT_CHANNEL, FLUSH_CHANNEL, FLUSHED_CHANNEL];
    expect(new Set(values).size).toBe(values.length);
  });

  it('main registers a handler for every bridge channel', () => {
    for (const [method, channel] of Object.entries(CHANNELS)) {
      expect(ipcMain.handlers.has(channel), `${method} → ${channel} has no handler`).toBe(true);
    }
  });

  it('main registers nothing outside the table', () => {
    const known = new Set<string>(Object.values(CHANNELS));
    for (const channel of ipcMain.handlers.keys()) {
      expect(known.has(channel), `handler for unknown channel ${channel}`).toBe(true);
    }
  });

  it('the provider channels validate their payloads before touching a store or docker', async () => {
    const invoke = (channel: string, args: unknown): unknown =>
      (ipcMain.handlers.get(channel) as (event: unknown, args: unknown) => Promise<unknown>)({}, args);
    await expect(invoke(CHANNELS.sshHostAdd, { label: 'x', host: '-oProxyCommand=touch /tmp/p' })).rejects.toThrow(
      /Invalid SSH host/,
    );
    await expect(invoke(CHANNELS.sshHostRemove, '../etc')).rejects.toThrow(/Invalid SSH host id/);
    await expect(invoke(CHANNELS.targetHealth, { providerId: 'github', targetId: 'local' })).rejects.toThrow(
      /has no targets/,
    );
    await expect(invoke(CHANNELS.githubSetConfigRepo, 'not a repo')).rejects.toThrow(/Invalid repository name/);
    await expect(invoke(CHANNELS.githubSetPat, 'a b')).rejects.toThrow(/Invalid personal access token/);
    await expect(invoke(CHANNELS.providerAuthStart, 'docker-local')).rejects.toThrow(/has no sign-in/);
  });
});
