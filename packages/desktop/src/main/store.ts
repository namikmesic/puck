/**
 * Persisted-store primitive shared by the entity modules (agents,
 * environments): lazy load from userData, a migrate hook for legacy on-disk
 * shapes (dual-reads live there), and atomic serialized writes. Keeping the
 * lazy singleton here means importing an entity module never touches
 * Electron paths.
 */

import { app } from 'electron';
import * as path from 'node:path';
import { readJson, writeJsonAtomic } from './jsonstore';

export interface PersistedStore<T> {
  read(): T;
  /** Persist the current state (atomic, serialized, fire-and-forget). */
  persist(): void;
}

export function defineStore<T>(cfg: {
  file: string;
  defaults: () => T;
  /** Normalize legacy on-disk shapes at first load. */
  migrate?: (raw: T) => T;
}): PersistedStore<T> {
  let state: T | null = null;
  const filePath = (): string => path.join(app.getPath('userData'), cfg.file);
  return {
    read(): T {
      if (state === null) {
        const raw = readJson<T>(filePath()) ?? cfg.defaults();
        state = cfg.migrate ? cfg.migrate(raw) : raw;
      }
      return state;
    },
    persist(): void {
      if (state !== null) void writeJsonAtomic(filePath(), state);
    },
  };
}
