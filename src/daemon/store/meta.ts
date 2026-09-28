/**
 * The state format version and its migrations.
 *
 * meta.json records `formatVersion`. On boot, before anything reads a store,
 * the daemon runs every migration between the recorded version and its own,
 * in order. Migrations are pure functions over the parsed store files, so
 * they are testable without a filesystem; the results are written back
 * atomically file by file, then meta.json. State written by a NEWER daemon
 * is refused rather than guessed at. A failure leaves the daemon in the
 * `failed` state (it still answers the handshake, status and logs).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonFile, writeFileAtomicSync } from './jsonfile';

/** The state format this daemon reads and writes. */
export const FORMAT_VERSION = 1;

/** The fixed store files a migration may rewrite (transcripts carry their own `v`). */
export const STORE_FILES = ['instance.json', 'sessions.json', 'items.json', 'notices.json'] as const;
export type StoreFile = (typeof STORE_FILES)[number];

/** Parsed store files by name; a missing file is absent from the map. */
export type StateFiles = Partial<Record<StoreFile, unknown>>;

export interface Migration {
  /** The format version this migration produces (from `to - 1`). */
  to: number;
  run(state: StateFiles): StateFiles;
}

/** Ordered. Format 1 is the first daemon format, so nothing migrates yet. */
export const MIGRATIONS: readonly Migration[] = [];

export interface Meta {
  formatVersion: number;
  daemonVersion: string;
  createdAt: number;
}

export type MigrateResult =
  | { ok: true; from: number | null; to: number; meta: Meta }
  | { ok: false; error: string };

export function migrateState(
  stateDir: string,
  opts: { daemonVersion: string; now: number; target?: number; migrations?: readonly Migration[] },
): MigrateResult {
  const target = opts.target ?? FORMAT_VERSION;
  const migrations = opts.migrations ?? MIGRATIONS;
  const metaFile = path.join(stateDir, 'meta.json');
  let meta: Meta | null;
  try {
    meta = readJsonFile<Meta>(metaFile);
  } catch (err) {
    return { ok: false, error: `meta.json is unreadable: ${(err as Error).message}` };
  }

  if (meta === null) {
    const fresh: Meta = { formatVersion: target, daemonVersion: opts.daemonVersion, createdAt: opts.now };
    writeFileAtomicSync(metaFile, JSON.stringify(fresh));
    return { ok: true, from: null, to: target, meta: fresh };
  }

  const from = meta.formatVersion;
  if (!Number.isInteger(from) || from < 1) {
    return { ok: false, error: `meta.json has an invalid formatVersion (${String(from)}).` };
  }
  if (from > target) {
    return {
      ok: false,
      error: `This environment's state was written by a newer daemon (format ${from}; this daemon reads ${target}). Update Puck.`,
    };
  }

  if (from < target) {
    let state: StateFiles = {};
    try {
      for (const name of STORE_FILES) {
        const value = readJsonFile<unknown>(path.join(stateDir, name));
        if (value !== null) state[name] = value;
      }
      for (let version = from + 1; version <= target; version++) {
        const step = migrations.find((m) => m.to === version);
        if (!step) throw new Error(`no migration to format ${version}`);
        state = step.run(state);
      }
    } catch (err) {
      return { ok: false, error: `State migration from format ${from} failed: ${(err as Error).message}` };
    }
    for (const name of STORE_FILES) {
      const file = path.join(stateDir, name);
      if (name in state) writeFileAtomicSync(file, JSON.stringify(state[name]));
      else fs.rmSync(file, { force: true });
    }
  }

  const next: Meta = { ...meta, formatVersion: target, daemonVersion: opts.daemonVersion };
  writeFileAtomicSync(metaFile, JSON.stringify(next));
  return { ok: true, from, to: target, meta: next };
}
