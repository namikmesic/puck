/**
 * Conversation store (main process).
 *
 * Long-lived per-agent transcripts: one JSON file per agent under
 * userData/puck-convos/, written atomically so a crash can never truncate
 * more than one agent's history — and never leave a partially-written file.
 * This module owns the persisted dialect end to end: the strict IPC-save
 * codec (`fromIpc`) and the lenient disk-read codec (`normalize`) share one
 * field assembly, so a new ConversationData field is added in one place.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConversationData, ConversationEntry } from '../harness/bridge';
import type { HarnessEvent } from '../harness/types';
import { isPlainObject } from '../harness/options';
import { readJson, writeTextAtomic } from './jsonstore';

const dir = (): string => path.join(app.getPath('userData'), 'puck-convos');
const legacyPath = (): string => path.join(app.getPath('userData'), 'puck-convos.json');

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

/** The non-log fields with their defaults — shared by both codecs. */
function assemble(
  raw: Record<string, unknown>,
  log: ConversationData['log'],
  lastTurnTokens: unknown,
): ConversationData {
  return {
    v: typeof raw.v === 'number' ? raw.v : 1,
    log,
    lastTurnTokens: num(lastTurnTokens),
    lastActiveAt: num(raw.lastActiveAt),
    turns: num(raw.turns),
    ...(typeof raw.draft === 'string' ? { draft: raw.draft } : {}),
  };
}

/**
 * Strict codec for renderer-authored saves: the payload lands on disk
 * forever, so a malformed entry surfaces as a failed save instead of a
 * corrupted file. (The size ceiling lives in `save`, where the payload is
 * serialized anyway.)
 */
export function fromIpc(raw: unknown): ConversationData {
  if (!isPlainObject(raw)) throw new Error('Invalid conversation payload.');
  if (!Array.isArray(raw.log)) throw new Error('Invalid conversation log.');
  const log = raw.log.map((entry): ConversationEntry => {
    if (!isPlainObject(entry)) throw new Error('Invalid conversation entry.');
    if (entry.kind === 'user') {
      return {
        kind: 'user',
        text: str(entry.text),
        author: str(entry.author, 'user'),
        ts: num(entry.ts),
      };
    }
    if (entry.kind === 'turn' && Array.isArray(entry.events)) {
      // Replay is lenient about unknown kinds, but what we persist must at
      // least be event-shaped — deep per-kind validation stays with replay.
      const events = entry.events.map((ev): HarnessEvent => {
        if (!isPlainObject(ev) || typeof ev.kind !== 'string') {
          throw new Error('Invalid conversation event.');
        }
        return ev as unknown as HarnessEvent;
      });
      return { kind: 'turn', ts: num(entry.ts), events };
    }
    throw new Error('Invalid conversation entry.');
  });
  return assemble(raw, log, raw.lastTurnTokens);
}

/**
 * Lenient read-side normalization: older HTML-snapshot saves have no `log`
 * and start fresh (memory is preserved separately via provider resume ids);
 * `usage` was renamed `lastTurnTokens`. Entries are not re-validated — the
 * renderer's replay skips unknown kinds.
 */
function normalize(raw: unknown): ConversationData | null {
  if (!isPlainObject(raw) || !Array.isArray(raw.log)) return null;
  return assemble(raw, raw.log as ConversationData['log'], raw.lastTurnTokens ?? raw.usage);
}

/** Every agent's transcript, keyed by agent id. */
export function loadAll(): Record<string, ConversationData> {
  const raw: Record<string, unknown> = {};
  // One-time migration from the old single-blob store.
  const legacy = readJson<Record<string, unknown>>(legacyPath());
  if (legacy) Object.assign(raw, legacy);
  try {
    for (const file of fs.readdirSync(dir())) {
      if (!file.endsWith('.json')) continue;
      const data = readJson<unknown>(path.join(dir(), file));
      if (data) raw[file.slice(0, -5)] = data;
    }
  } catch {
    // directory doesn't exist yet
  }
  const all: Record<string, ConversationData> = {};
  for (const [agentId, data] of Object.entries(raw)) {
    const convo = normalize(data);
    if (convo) all[agentId] = convo;
  }
  return all;
}

/** Cap on one serialized conversation file — beyond this, refuse the save. */
const CONVO_MAX_BYTES = 8_000_000;

export function save(agentId: string, data: ConversationData): Promise<void> {
  const json = JSON.stringify(data);
  if (json.length > CONVO_MAX_BYTES) {
    return Promise.reject(new Error('Conversation too large to save.'));
  }
  return writeTextAtomic(path.join(dir(), `${agentId}.json`), json);
}
