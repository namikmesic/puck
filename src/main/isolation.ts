/**
 * Isolated launch mode for tests and live checks (main process). Opted into
 * with PUCK_ISOLATED=1 (`npm run start:isolated`); a normal launch is
 * untouched. Isolation never replaces HOME: every Electron data path moves
 * into a throwaway directory instead, and Chromium's mock keychain encrypts
 * with a fixed built-in key, so safeStorage never asks macOS for a keychain
 * (no "Puck Safe Storage" item, no keychain dialog). Windows open without
 * taking focus from whoever is at the desk.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Set to "1" to launch isolated. */
export const ISOLATED_ENV = 'PUCK_ISOLATED';
/**
 * Optional caller-owned data directory, read only when PUCK_ISOLATED=1.
 * Without it Puck makes a fresh one under the OS temp dir. Chromium writes
 * into the profile until the process exits, so whoever wants a dir gone
 * removes it after exit.
 */
export const ISOLATED_DIR_ENV = 'PUCK_ISOLATED_DIR';
/** The Chromium switch that swaps the OS keychain for its mock. */
export const MOCK_KEYCHAIN_SWITCH = 'use-mock-keychain';

export interface IsolatedLaunch {
  /** Where userData, sessionData, and crash dumps live for this run. */
  dataDir: string;
}

/** The slice of Electron's `app` isolation touches (injected for tests). */
export interface IsolationApp {
  setPath(name: 'userData' | 'sessionData' | 'crashDumps', value: string): void;
  commandLine: { appendSwitch(name: string): void };
}

/**
 * Switch `app` into isolated mode when `env` asks for it, before anything
 * reads a data path. Returns the launch, or null for a normal launch (which
 * touches nothing).
 */
export function applyIsolatedLaunch(
  app: IsolationApp,
  env: NodeJS.ProcessEnv = process.env,
  tmpdir: string = os.tmpdir(),
): IsolatedLaunch | null {
  if (env[ISOLATED_ENV] !== '1') return null;
  const given = env[ISOLATED_DIR_ENV]?.trim();
  const dataDir = given ? path.resolve(given) : fs.mkdtempSync(path.join(tmpdir, 'puck-isolated-'));
  fs.mkdirSync(dataDir, { recursive: true });
  app.setPath('userData', dataDir);
  app.setPath('sessionData', dataDir);
  app.setPath('crashDumps', path.join(dataDir, 'Crashpad'));
  app.commandLine.appendSwitch(MOCK_KEYCHAIN_SWITCH);
  return { dataDir };
}
