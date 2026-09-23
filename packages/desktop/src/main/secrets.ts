/**
 * Encrypted-at-rest secret storage for provider tokens (main process).
 * Uses Electron safeStorage (OS keychain-backed) with a plaintext fallback
 * only when the OS facility is unavailable.
 */

import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

function fileFor(name: string): string {
  return path.join(app.getPath('userData'), name);
}

export function saveSecret(name: string, json: string): void {
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8');
  fs.writeFileSync(fileFor(name), data, { mode: 0o600 });
}

export function loadSecret(name: string): string | null {
  try {
    const raw = fs.readFileSync(fileFor(name));
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8');
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
