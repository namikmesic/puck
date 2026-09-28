/**
 * puck-instances.json: what this app remembers about environments. The
 * Puck server holds the index (which environments exist, on which runner);
 * this file keeps only what is this app's own:
 *
 * - `lastSeq`: the last daemon event applied, so reattaching (and a restart
 *   of the app) replays from there. Saved debounced (2 s) while events
 *   stream; the quit drain flushes it.
 * - `pin`: the definition pin, for rebuilds, and `harnesses`, whose
 *   credential files the app keeps in sync.
 * - `pendingCredentialRemoval`: harnesses the user signed out of while
 *   this environment was not attached; removed on its next attach.
 * - `currentId`: the environment the window shows.
 *
 * Migrate, don't break: every field defaults at load.
 */

import type { Pin } from '../../harness/daemon-protocol';
import { validPin } from '../../harness/inbox';
import { defineStore } from '../store';

export interface InstanceCursor {
  /** Where it runs, so This Mac's environments attach over the local socket even while the server is down. */
  runnerId: string | null;
  lastSeq: number | null;
  pin: Pin | null;
  /** The harnesses its agents use (their credential files are kept in sync). */
  harnesses: string[];
  pendingCredentialRemoval: string[];
  lastAttachedAt: number | null;
}

export interface InstancesFile {
  v: 1;
  instances: Record<string, InstanceCursor>;
  currentId: string | null;
}

const SEQ_SAVE_MS = 2_000;

export function normalizeInstances(raw: unknown): InstancesFile {
  const file = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const instances: Record<string, InstanceCursor> = {};
  const src = typeof file.instances === 'object' && file.instances !== null ? (file.instances as Record<string, unknown>) : {};
  for (const [id, v] of Object.entries(src)) {
    if (!/^env_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) || typeof v !== 'object' || v === null) continue;
    const c = v as Record<string, unknown>;
    instances[id] = {
      runnerId: typeof c.runnerId === 'string' ? c.runnerId : null,
      lastSeq: typeof c.lastSeq === 'number' && Number.isInteger(c.lastSeq) && c.lastSeq >= 0 ? c.lastSeq : null,
      pin: validPin(c.pin),
      harnesses: Array.isArray(c.harnesses) ? c.harnesses.filter((h): h is string => typeof h === 'string') : [],
      pendingCredentialRemoval: Array.isArray(c.pendingCredentialRemoval)
        ? c.pendingCredentialRemoval.filter((h): h is string => typeof h === 'string')
        : [],
      lastAttachedAt: typeof c.lastAttachedAt === 'number' ? c.lastAttachedAt : null,
    };
  }
  const currentId = typeof file.currentId === 'string' && instances[file.currentId] ? file.currentId : null;
  return { v: 1, instances, currentId };
}

const store = defineStore<InstancesFile>({
  file: 'puck-instances.json',
  defaults: () => ({ v: 1, instances: {}, currentId: null }),
  migrate: normalizeInstances,
});

const blank = (): InstanceCursor => ({ runnerId: null, lastSeq: null, pin: null, harnesses: [], pendingCredentialRemoval: [], lastAttachedAt: null });

export function cursor(envId: string): InstanceCursor | null {
  const c = store.read().instances[envId];
  return c ? { ...c, pendingCredentialRemoval: [...c.pendingCredentialRemoval] } : null;
}

export function allCursors(): Record<string, InstanceCursor> {
  return store.read().instances;
}

export function updateCursor(envId: string, patch: Partial<InstanceCursor>): void {
  const state = store.read();
  state.instances[envId] = { ...(state.instances[envId] ?? blank()), ...patch };
  store.persist();
}

export function removeCursor(envId: string): void {
  const state = store.read();
  if (!state.instances[envId] && state.currentId !== envId) return;
  delete state.instances[envId];
  if (state.currentId === envId) state.currentId = null;
  store.persist();
}

export function currentId(): string | null {
  return store.read().currentId;
}

export function setCurrent(envId: string | null): void {
  const state = store.read();
  if (envId && !state.instances[envId]) state.instances[envId] = blank();
  state.currentId = envId;
  store.persist();
}

let seqTimer: ReturnType<typeof setTimeout> | null = null;

/** Records the replay cursor; the file is written at most every two seconds. */
export function saveSeq(envId: string, seq: number): void {
  const state = store.read();
  const c = (state.instances[envId] ??= blank());
  if (c.lastSeq !== null && seq <= c.lastSeq) return;
  c.lastSeq = seq;
  if (seqTimer) return;
  seqTimer = setTimeout(() => {
    seqTimer = null;
    store.persist();
  }, SEQ_SAVE_MS);
}

/** Writes a pending cursor now (the quit drain). */
export function flushSeq(): void {
  if (!seqTimer) return;
  clearTimeout(seqTimer);
  seqTimer = null;
  store.persist();
}
