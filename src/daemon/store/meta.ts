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
 *
 * Format 2 is the three-state ticket model: protocol 1's eight statuses
 * map onto status, stage and outcome (`mapLegacy` in
 * `src/harness/workflow.ts`, the mapping the protocol-1 projection shares),
 * `source` and `pr` become references, and a pending question becomes the
 * ticket's ask. The migration is idempotent, because the files are written
 * one by one and meta.json last: a record it wrote carries
 * `recordFormat: 2` and is left alone on a second run, and every id it
 * invents derives from the ticket's own id. The boot that follows journals
 * each ticket's legacy workflow (the bootstrap in daemon.ts). meta.json
 * records the event log's head at the migration as `formatBoundary`:
 * events up to it hold protocol-1 shapes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ItemStatusV1, Reference, TicketAsk } from '../../harness/daemon-protocol';
import { legacyIds, mapLegacy, referencesFromV1 } from '../../harness/workflow';
import { readJsonFile, writeFileAtomicSync } from './jsonfile';

/** The state format this daemon reads and writes. */
export const FORMAT_VERSION = 2;

/** The fixed store files a migration may rewrite (transcripts carry their own `v`; the delivery journal is never rewritten). */
export const STORE_FILES = ['instance.json', 'sessions.json', 'items.json', 'notices.json', 'delivery/tables.json'] as const;
export type StoreFile = (typeof STORE_FILES)[number];

/** Parsed store files by name; a missing file is absent from the map. */
export type StateFiles = Partial<Record<StoreFile, unknown>>;

export interface Migration {
  /** The format version this migration produces (from `to - 1`). */
  to: number;
  run(state: StateFiles): StateFiles;
}

const V1_STATUSES: readonly ItemStatusV1[] = ['backlog', 'queued', 'running', 'needs-input', 'review', 'done', 'failed', 'cancelled'];

type Raw = Record<string, unknown>;

/** One protocol-1 ticket record in format 2 (4.1's mapping; everything else kept). */
export function migrateRecord(id: string, raw: Raw): Raw {
  if (raw.recordFormat === 2) return raw;
  const old = V1_STATUSES.includes(raw.status as ItemStatusV1) ? (raw.status as ItemStatusV1) : 'backlog';
  const pr = raw.pr as { state?: 'open' | 'closed' | 'merged' } | null | undefined;
  const result = raw.result as Raw | null | undefined;
  const mapping = mapLegacy({ status: old, sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null, prState: pr?.state, interrupted: !!result?.interrupted });
  const ids = legacyIds(id);
  const pending = raw.pendingAsk as { askId?: unknown; routedTo?: unknown } | null | undefined;
  const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0;
  const asks: TicketAsk[] =
    pending && typeof pending.askId === 'string'
      ? [{ askId: pending.askId, kind: 'question', roundId: ids.roundId, stepId: ids.implementId, routedTo: pending.routedTo === 'user' ? 'user' : 'orchestrator', since: updatedAt }]
      : [];
  const references: Reference[] = referencesFromV1({ id, source: (raw.source ?? null) as never, pr: (raw.pr ?? null) as never }, null);
  const { source: _source, pr: _pr, pendingAsk: _pending, ...rest } = raw;
  void [_source, _pr, _pending];
  const user = asks.find((a) => a.routedTo === 'user');
  return {
    ...rest,
    status: mapping.status,
    stage: mapping.stage,
    outcome: mapping.outcome,
    closedAt: mapping.status === 'done' ? updatedAt : null,
    createdBy: raw.createdBy === 'orchestrator' ? 'orchestrator' : 'user',
    result: result ? { ...result, head: typeof result.head === 'string' ? result.head : '' } : null,
    references,
    asks,
    needsInput: asks[0] ?? null,
    oldestUserAsk: user ? { askId: user.askId, kind: user.kind, roundId: user.roundId, stepId: user.stepId, since: user.since } : null,
    openAsks: asks.length,
    userAsks: user ? 1 : 0,
    delivery: null,
    legacyStatus: old,
    workflowId: mapping.implement ? ids.workflowId : null,
    recordFormat: 2,
  };
}

/** Format 1 to 2: items.json's records, and each worker session's implement step. */
export function migrateToFormat2(state: StateFiles): StateFiles {
  const out: StateFiles = { ...state };
  const items = state['items.json'] as { items?: Record<string, Raw> } | undefined;
  const records: Record<string, Raw> = {};
  if (items && items.items && typeof items.items === 'object') {
    for (const [id, raw] of Object.entries(items.items)) {
      records[id] = raw && typeof raw === 'object' ? migrateRecord(id, raw) : raw;
    }
    out['items.json'] = { ...items, items: records };
  }
  const sessions = state['sessions.json'] as Record<string, Raw> | undefined;
  if (sessions && typeof sessions === 'object') {
    const next: Record<string, Raw> = {};
    for (const [id, s] of Object.entries(sessions)) {
      const itemId = s && typeof s.itemId === 'string' ? s.itemId : null;
      const ticket = itemId ? records[itemId] : undefined;
      const legacy = ticket ? (ticket.legacyStatus as ItemStatusV1 | undefined) : undefined;
      next[id] =
        s && s.kind === 'worker' && itemId && typeof s.stepId !== 'string' && legacy && legacy !== 'backlog'
          ? { ...s, stepId: legacyIds(itemId).implementId }
          : s;
    }
    out['sessions.json'] = next;
  }
  return out;
}

/** Ordered: the first daemon format was 1. */
export const MIGRATIONS: readonly Migration[] = [{ to: 2, run: migrateToFormat2 }];

export interface Meta {
  formatVersion: number;
  daemonVersion: string;
  createdAt: number;
  /** The event log's head when the state moved to format 2: events up to it hold protocol-1 shapes. */
  formatBoundary?: number;
}

export type MigrateResult =
  | { ok: true; from: number | null; to: number; meta: Meta }
  | { ok: false; error: string };

export function migrateState(
  stateDir: string,
  opts: {
    daemonVersion: string;
    now: number;
    target?: number;
    migrations?: readonly Migration[];
    /** The event log's head now (recorded as the format boundary when this run crosses format 2). */
    eventHead?: number;
    /** Test seam: the atomic write (crash injection between store files). */
    write?: (file: string, text: string) => void;
  },
): MigrateResult {
  const target = opts.target ?? FORMAT_VERSION;
  const migrations = opts.migrations ?? MIGRATIONS;
  const write = opts.write ?? ((file: string, text: string) => writeFileAtomicSync(file, text));
  const metaFile = path.join(stateDir, 'meta.json');
  let meta: Meta | null;
  try {
    meta = readJsonFile<Meta>(metaFile);
  } catch (err) {
    return { ok: false, error: `meta.json is unreadable: ${(err as Error).message}` };
  }

  if (meta === null) {
    const fresh: Meta = { formatVersion: target, daemonVersion: opts.daemonVersion, createdAt: opts.now, formatBoundary: 0 };
    write(metaFile, JSON.stringify(fresh));
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
      if (name in state) write(file, JSON.stringify(state[name]));
      else fs.rmSync(file, { force: true });
    }
  }

  const crossed = from < 2 && target >= 2;
  const next: Meta = {
    ...meta,
    formatVersion: target,
    daemonVersion: opts.daemonVersion,
    ...(crossed ? { formatBoundary: opts.eventHead ?? 0 } : {}),
  };
  write(metaFile, JSON.stringify(next));
  return { ok: true, from, to: target, meta: next };
}
