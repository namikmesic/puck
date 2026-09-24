/** Minimal Electron surface for unit tests (never a real browser process). */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Fresh per test file (vitest re-evaluates the module graph per file), so
// stores never see a previous run's or another file's state.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-test-'));

export const app = {
  getPath: (): string => userData,
  getVersion: (): string => '0.0.0-test',
  getName: (): string => 'Puck',
  quit: (): void => undefined,
  on: (): void => undefined,
  isPackaged: false,
};

/** Stand-in for the OS keychain: a marker prefix plus base64 plays the role
 *  of encryption - the stored bytes never contain the plaintext, a file
 *  without the marker fails to decrypt (as a plaintext file would), and
 *  `available` can be flipped to simulate a locked or missing keychain. */
const MAGIC = Buffer.from('puck-test-enc:');
export const safeStorage = {
  available: true,
  isEncryptionAvailable: (): boolean => safeStorage.available,
  encryptString: (s: string): Buffer =>
    Buffer.concat([MAGIC, Buffer.from(Buffer.from(s, 'utf8').toString('base64'), 'ascii')]),
  decryptString: (b: Buffer): string => {
    if (!b.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an encrypted payload');
    return Buffer.from(b.subarray(MAGIC.length).toString('ascii'), 'base64').toString('utf8');
  },
};

export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return [];
  }
  webContents = {
    on: (): void => undefined,
    setWindowOpenHandler: (): void => undefined,
    send: (): void => undefined,
  };
  static fromWebContents(): BrowserWindow | null {
    return null;
  }
  isDestroyed(): boolean {
    return false;
  }
  loadURL(): void {
    /* never navigates in tests */
  }
  close(): void {
    /* nothing to close */
  }
}

export const shell = { openExternal: async (): Promise<void> => undefined };

/** Save dialog with a scripted answer: tests set `nextSave` before the call. */
export const dialog = {
  nextSave: { canceled: true } as { canceled: boolean; filePath?: string },
  showSaveDialog: async (): Promise<{ canceled: boolean; filePath?: string }> => dialog.nextSave,
  showErrorBox: (): void => undefined,
};

/** Records registrations so tests can assert channel-table totality. */
export const ipcMain = {
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    ipcMain.handlers.set(channel, fn);
  },
  on(): void {
    /* one-way listeners are not exercised in unit tests */
  },
  removeListener(): void {
    /* see on() */
  },
};

export const session = {
  defaultSession: { webRequest: { onHeadersReceived: (): void => undefined } },
};
