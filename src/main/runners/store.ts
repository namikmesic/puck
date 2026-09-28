/**
 * puck-runners.json: what this install remembers about runners.
 *
 * - `keys`: the key fingerprint first seen for each runner id. Channels are
 *   end-to-end encrypted to the key the Puck server lists; pinning it here
 *   means a server that later lists another key for the same runner is
 *   noticed, and channels to that runner are refused until the user removes
 *   and registers it again (re-registration always makes a new runner id).
 * - `local`: the This Mac runner this app installed, and where.
 *
 * Migrate, don't break: missing fields default at load.
 */

import { defineStore } from '../store';

export interface LocalRunnerRecord {
  /** Null until registration finished. */
  runnerId: string | null;
  /** The runner's directory (inside Puck's data folder). */
  dir: string;
  /** Its local socket. */
  socket: string;
}

export interface RunnersFile {
  v: 1;
  keys: Record<string, string>;
  local: LocalRunnerRecord | null;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function normalizeRunners(raw: unknown): RunnersFile {
  const file = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const keys: Record<string, string> = {};
  if (typeof file.keys === 'object' && file.keys !== null) {
    for (const [id, fp] of Object.entries(file.keys as Record<string, unknown>)) if (isStr(fp)) keys[id] = fp;
  }
  const l = (typeof file.local === 'object' && file.local !== null ? file.local : null) as Record<string, unknown> | null;
  const local = l && isStr(l.dir) && isStr(l.socket) ? { runnerId: isStr(l.runnerId) ? l.runnerId : null, dir: l.dir, socket: l.socket } : null;
  return { v: 1, keys, local };
}

const store = defineStore<RunnersFile>({
  file: 'puck-runners.json',
  defaults: () => ({ v: 1, keys: {}, local: null }),
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

/** Drops pins for runners that no longer exist. */
export function forgetKeys(keep: Set<string>): void {
  const state = store.read();
  const drop = Object.keys(state.keys).filter((id) => !keep.has(id));
  if (!drop.length) return;
  for (const id of drop) delete state.keys[id];
  store.persist();
}

export function localRunner(): LocalRunnerRecord | null {
  const l = store.read().local;
  return l ? { ...l } : null;
}

export function setLocalRunner(record: LocalRunnerRecord | null): void {
  store.read().local = record ? { ...record } : null;
  store.persist();
}
