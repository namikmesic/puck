/**
 * Encrypted-at-rest secret storage for provider tokens and environment
 * secrets (main process). Electron safeStorage (OS keychain-backed) is the
 * ONLY backend: when it is unavailable, saving refuses with a clear error
 * instead of falling back to plaintext, and an existing file that cannot be
 * decrypted reads as absent. The Settings copy in index.html describes this
 * behavior - keep the two in sync.
 */

import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The OS secure store cannot encrypt right now; nothing was written. */
export class SecureStorageUnavailableError extends Error {
  constructor() {
    super(
      `The OS secure store is unavailable (Electron safeStorage reports the ${backendName()} ` +
        'cannot encrypt), so Puck refused to save the secret. Puck never stores secrets in ' +
        'plaintext. Unlock the login keychain and try again.',
    );
    this.name = 'SecureStorageUnavailableError';
  }
}

function backendName(): string {
  if (process.platform === 'darwin') return 'macOS Keychain';
  if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
    return `${safeStorage.getSelectedStorageBackend()} backend`;
  }
  return 'OS keychain';
}

function fileFor(name: string): string {
  return path.join(app.getPath('userData'), name);
}

/**
 * Store `json` encrypted, owner-readable only, atomically (tmp + rename): a
 * rotated token pair replaces the old one whole or not at all, because the
 * old pair is already dead on the provider's side. Throws
 * SecureStorageUnavailableError - and writes nothing - when the OS store
 * cannot encrypt. Callers surface the message as-is (auth status, editor).
 */
export function saveSecret(name: string, json: string): void {
  if (!safeStorage.isEncryptionAvailable()) throw new SecureStorageUnavailableError();
  const file = fileFor(name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, safeStorage.encryptString(json), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * The decrypted secret, or null when there is none - or when it cannot be
 * decrypted: the store is unavailable, or the file is one this build does not
 * accept (a plaintext file from the removed fallback is never read back).
 */
export function loadSecret(name: string): string | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(fileFor(name));
  } catch {
    return null;
  }
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(raw);
  } catch {
    return null;
  }
}

export function deleteSecret(name: string): void {
  try {
    fs.unlinkSync(fileFor(name));
  } catch {
    // already gone
  }
}
