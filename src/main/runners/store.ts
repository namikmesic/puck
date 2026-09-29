/**
 * puck-runners.json: what this install remembers about runners.
 *
 * - `keys`: the key fingerprint first seen for each runner id. Channels are
 *   end-to-end encrypted to the key the Puck server lists; pinning it here
 *   means a server that later lists another key for the same runner is
 *   noticed, and channels to that runner are refused until the user removes
 *   and registers it again (re-registration always makes a new runner id).
 * - `local`: a This Mac install from before installs were keyed by account.
 * - `accounts`: the This Mac install for each Puck account. A second account
 *   on this OS user gets its own record and never replaces the first.
 *
 * Migrate, don't break: missing fields default at load.
 */

import { current } from '../server/session';
import { defineStore } from '../store';

export interface LocalRunnerRecord {
  /** Null until registration finished. */
  runnerId: string | null;
  /** The runner's directory (inside Puck's data folder). */
  dir: string;
  /** Its local socket. */
  socket: string;
  /** The Puck account this install belongs to. Absent on a legacy unbound record. */
  accountId?: string;
}

export interface RunnersFile {
  v: 1;
  keys: Record<string, string>;
  /** Legacy single install with no account id. Dual-read; new installs go in `accounts`. */
  local: LocalRunnerRecord | null;
  /** This Mac installs keyed by Puck account id. One account never replaces another's. */
  accounts: Record<string, LocalRunnerRecord>;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function normalizeRunners(raw: unknown): RunnersFile {
  const file = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const keys: Record<string, string> = {};
  if (typeof file.keys === 'object' && file.keys !== null) {
    for (const [id, fp] of Object.entries(file.keys as Record<string, unknown>)) if (isStr(fp)) keys[id] = fp;
  }
  const readRecord = (value: unknown): LocalRunnerRecord | null => {
    const l = (typeof value === 'object' && value !== null ? value : null) as Record<string, unknown> | null;
    if (!l || !isStr(l.dir) || !isStr(l.socket)) return null;
    const accountId = isStr(l.accountId) ? l.accountId : undefined;
    return { runnerId: isStr(l.runnerId) ? l.runnerId : null, dir: l.dir, socket: l.socket, ...(accountId ? { accountId } : {}) };
  };
  const accounts: Record<string, LocalRunnerRecord> = {};
  if (typeof file.accounts === 'object' && file.accounts !== null) {
    for (const [id, raw] of Object.entries(file.accounts as Record<string, unknown>)) {
      const rec = readRecord(raw);
      if (rec && isStr(id)) accounts[id] = { ...rec, accountId: id };
    }
  }
  const legacy = readRecord(file.local);
  if (legacy?.accountId && !accounts[legacy.accountId]) accounts[legacy.accountId] = { ...legacy, accountId: legacy.accountId };
  const local = legacy && !legacy.accountId ? { runnerId: legacy.runnerId, dir: legacy.dir, socket: legacy.socket } : null;
  return { v: 1, keys, local, accounts };
}

const store = defineStore<RunnersFile>({
  file: 'puck-runners.json',
  defaults: () => ({ v: 1, keys: {}, local: null, accounts: {} }),
  migrate: normalizeRunners,
});

/**
 * The pinned fingerprint for a runner, pinning `seen` when there is none.
 * True when `seen` matches what was pinned.
 */
export function checkPinnedKey(runnerId: string, seen: string): boolean {
  const state = store.read();
  const pinned = state.keys[runnerId];
  if (pinned === undefined) {
    state.keys[runnerId] = seen;
    store.persist();
    return true;
  }
  return pinned === seen;
}

/**
 * Drops a runner's pin once it was removed. Only removal does: a runner
 * missing from one listing and listed again later keeps its pin, so a
 * server cannot reset it by leaving the runner out once.
 */
export function forgetKey(runnerId: string): void {
  const state = store.read();
  if (!(runnerId in state.keys)) return;
  delete state.keys[runnerId];
  store.persist();
}

/** The This Mac install for the signed-in account, or null when signed out or unset. */
export function localRunner(): LocalRunnerRecord | null {
  const id = current()?.user.id;
  if (!id) return null;
  const rec = store.read().accounts[id];
  return rec ? { ...rec } : null;
}

/**
 * Records the signed-in account's This Mac install. A null record clears only
 * that account. With no signed-in account, a record is kept as the legacy
 * unbound install and null clears only that unbound record.
 */
export function setLocalRunner(record: LocalRunnerRecord | null): void {
  const state = store.read();
  if (!record) {
    const id = current()?.user.id;
    if (id) delete state.accounts[id];
    else state.local = null;
    store.persist();
    return;
  }
  const accountId = record.accountId || current()?.user.id || '';
  if (!accountId) {
    state.local = { runnerId: record.runnerId, dir: record.dir, socket: record.socket };
    store.persist();
    return;
  }
  state.accounts[accountId] = { runnerId: record.runnerId, dir: record.dir, socket: record.socket, accountId };
  store.persist();
}

/**
 * A legacy unbound install belongs to the account whose runner list contains
 * its id. Any other account leaves it, and the directory, alone.
 */
export function adoptLegacyLocal(accountId: string, runnerIds: readonly string[]): boolean {
  const state = store.read();
  if (!accountId || state.accounts[accountId] || !state.local?.runnerId) return false;
  if (!runnerIds.includes(state.local.runnerId)) return false;
  state.accounts[accountId] = { ...state.local, accountId };
  state.local = null;
  store.persist();
  return true;
}
