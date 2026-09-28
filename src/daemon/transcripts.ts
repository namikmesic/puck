/**
 * Session transcripts (format v2), one file per session under
 * /puck/state/transcripts/. Loaded lazily, mutated in memory as events
 * arrive (through the shared recording reducer), and saved atomically:
 * debounced while a turn streams, immediately at turn boundaries.
 */

import * as path from 'node:path';
import {
  emptyTranscript,
  type Transcript,
  type TranscriptEntry,
  type TurnEntry,
  TRANSCRIPT_VERSION,
} from '../harness/transcript';
import { readJsonFile, writeJsonAtomic, writeJsonAtomicSync } from './store/jsonfile';

const SAVE_DEBOUNCE_MS = 250;

function normalize(raw: unknown, sessionId: string, now: number): Transcript {
  const t = raw && typeof raw === 'object' ? (raw as Partial<Transcript>) : {};
  return {
    v: TRANSCRIPT_VERSION,
    sessionId,
    log: Array.isArray(t.log) ? t.log : [],
    lastTurnTokens: t.lastTurnTokens ?? 0,
    lastActiveAt: t.lastActiveAt ?? now,
    turns: t.turns ?? 0,
  };
}

export class TranscriptBook {
  private readonly open = new Map<string, Transcript>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly writes = new Set<Promise<void>>();

  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private file(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.json`);
  }

  get(sessionId: string): Transcript {
    let t = this.open.get(sessionId);
    if (!t) {
      let raw: unknown = null;
      try {
        raw = readJsonFile<unknown>(this.file(sessionId));
      } catch {
        raw = null; // an unreadable transcript starts over rather than wedging the session
      }
      t = raw === null ? emptyTranscript(sessionId, this.now()) : normalize(raw, sessionId, this.now());
      this.open.set(sessionId, t);
    }
    return t;
  }

  append(sessionId: string, entry: TranscriptEntry): void {
    this.get(sessionId).log.push(entry);
    this.saveNow(sessionId);
  }

  /** The newest turn entry with this id (the one being recorded). */
  turn(sessionId: string, turnId: string): TurnEntry | null {
    const log = this.get(sessionId).log;
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (e.kind === 'turn' && e.turnId === turnId) return e;
    }
    return null;
  }

  /** Coalesce saves while a turn streams. */
  saveSoon(sessionId: string): void {
    if (this.timers.has(sessionId)) return;
    const timer = setTimeout(() => this.saveNow(sessionId), SAVE_DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  commit(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    const t = this.open.get(sessionId);
    if (!t) return;
    writeJsonAtomicSync(this.file(sessionId), t);
  }

  saveNow(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    const t = this.open.get(sessionId);
    if (!t) return;
    const write = writeJsonAtomic(this.file(sessionId), t);
    this.writes.add(write);
    const done = (): void => {
      this.writes.delete(write);
    };
    write.then(done, done);
  }

  /** A page of entries ending before index `before` (default: the end). */
  page(sessionId: string, before: number | undefined, limit: number): { entries: TranscriptEntry[]; total: number; hasMore: boolean } {
    const log = this.get(sessionId).log;
    const end = Math.max(0, Math.min(before ?? log.length, log.length));
    const start = Math.max(0, end - limit);
    return { entries: log.slice(start, end), total: log.length, hasMore: start > 0 };
  }

  /** Save everything pending and wait for the writes. */
  async flush(): Promise<void> {
    for (const sessionId of [...this.timers.keys()]) this.saveNow(sessionId);
    await Promise.allSettled([...this.writes]);
  }
}
