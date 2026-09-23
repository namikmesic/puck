/** Minimal Electron surface for unit tests (never a real browser process). */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Fresh per test file (vitest re-evaluates the module graph per file), so
// stores never see a previous run's or another file's state.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-test-'));

export const app = {
  getPath: (): string => userData,
  quit: (): void => undefined,
  on: (): void => undefined,
  isPackaged: false,
};

export const safeStorage = {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer): string => b.toString('utf8'),
};

export class BrowserWindow {
  webContents = { on: (): void => undefined, setWindowOpenHandler: (): void => undefined };
  loadURL(): void {
    /* never navigates in tests */
  }
  close(): void {
    /* nothing to close */
  }
}

export const shell = { openExternal: async (): Promise<void> => undefined };

/** Records registrations so tests can assert channel-table totality. */
export const ipcMain = {
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    ipcMain.handlers.set(channel, fn);
  },
};

export const session = {
  defaultSession: { webRequest: { onHeadersReceived: (): void => undefined } },
};
