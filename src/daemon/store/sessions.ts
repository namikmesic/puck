/**
 * sessions.json: every harness session of this environment (the
 * orchestrator's and, later, each worker's), keyed by session id. The
 * provider resume id lives here and never leaves the daemon.
 */

import * as path from 'node:path';
import type { SessionKind, SessionStatus } from '../../harness/daemon-protocol';
import type { EntryAuthor } from '../../harness/transcript';
import { JsonStore } from './store';

/** An input accepted while its turn has not started. Durable on the session record. */
export interface QueuedInput {
  text: string;
  author: EntryAuthor;
}

export interface SessionRecord {
  id: string;
  kind: SessionKind;
  agent: string;
  harness: string;
  itemId?: string;
  cwd: string;
  status: SessionStatus;
  resumeId?: string;
  /** Inputs acknowledged but not yet started. Empty once their turn starts. */
  queue: QueuedInput[];
  turns: number;
  lastTurnTokens: number;
  costUsd: number;
  createdAt: number;
  lastActiveAt: number;
}

export type SessionMap = Record<string, SessionRecord>;

function normalizeQueue(raw: unknown): QueuedInput[] {
  if (!Array.isArray(raw)) return [];
  const queue: QueuedInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text !== 'string') continue;
    const author = (item as { author?: unknown }).author;
    queue.push({ text, author: author === 'orchestrator' || author === 'system' ? author : 'user' });
  }
  return queue;
}

function normalize(raw: unknown): SessionMap {
  const out: SessionMap = Object.create(null) as SessionMap;
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw as Record<string, Partial<SessionRecord>>)) {
    if (!value || typeof value !== 'object' || typeof value.agent !== 'string') continue;
    out[id] = {
      id,
      kind: value.kind === 'worker' ? 'worker' : 'orchestrator',
      agent: value.agent,
      harness: value.harness ?? 'claude-code',
      ...(value.itemId ? { itemId: value.itemId } : {}),
      cwd: value.cwd ?? '/workspace',
      status: value.status ?? 'idle',
      ...(value.resumeId ? { resumeId: value.resumeId } : {}),
      queue: normalizeQueue(value.queue),
      turns: value.turns ?? 0,
      lastTurnTokens: value.lastTurnTokens ?? 0,
      costUsd: value.costUsd ?? 0,
      createdAt: value.createdAt ?? 0,
      lastActiveAt: value.lastActiveAt ?? 0,
    };
  }
  return out;
}

export function sessionsStore(stateDir: string): JsonStore<SessionMap> {
  return new JsonStore(path.join(stateDir, 'sessions.json'), () => Object.create(null) as SessionMap, normalize);
}
