import { describe, expect, it } from 'vitest';
import { CHANNELS, EVENT_CHANNEL } from '../../src/harness/channels';
import { ipcMain } from '../mocks/electron';
// Importing the main entry registers every IPC handler on the mocked ipcMain.
import '../../src/index';

describe('IPC channel table', () => {
  it('channel names are unique (and distinct from the event channel)', () => {
    const values = [...Object.values(CHANNELS), EVENT_CHANNEL];
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
});
