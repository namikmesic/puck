/**
 * Transcript format v2 and its recording reducer, used by the environment
 * daemon. Consecutive text-deltas with the same parentId merge into one,
 * `thinking` events are dropped, and each recorded event carries a `ts`
 * stamped when it was received.
 *
 * Entry kinds are append-only: replay skips unknown kinds, so new kinds are
 * fine, while changing an existing kind's shape needs a new `v` and a
 * read-side migration. The app's conversation files (`ConversationData` in
 * `bridge.ts`) use the same merge for user and turn entries; this format
 * also stores `notice` entries and a `turnId` on each turn.
 */

import type { HarnessEvent } from './types';

export const TRANSCRIPT_VERSION = 2;

/** Who put a user-side message into a session. */
export type EntryAuthor = 'user' | 'orchestrator' | 'system';

export type NoticeKind =
  | 'item.review'
  | 'item.failed'
  | 'item.requeued'
  | 'item.needs-input'
  | 'pr.published'
  | 'environment.restarted'
  | 'definition.applied'
  | 'github.auth'
  | 'item.created'
  | 'item.updated'
  | 'issue.closed'
  | 'issue.updated'
  | 'issue.commented'
  | 'pr.merged'
  | 'pr.closed'
  | 'pr.checks'
  | 'pr.review';

/** A daemon-written update delivered to the orchestrator with its next turn. */
export interface Notice {
  id: string;
  kind: NoticeKind;
  at: number;
  /** One line, as the orchestrator reads it in its prompt. */
  text: string;
  itemId?: string;
}

export interface UserEntry {
  kind: 'user';
  text: string;
  author: EntryAuthor;
  ts: number;
}

export interface TurnEntry {
  kind: 'turn';
  turnId: string;
  ts: number;
  events: HarnessEvent[];
}

export interface NoticeEntry {
  kind: 'notice';
  ts: number;
  notices: Notice[];
}

export type TranscriptEntry = UserEntry | TurnEntry | NoticeEntry;

export interface Transcript {
  v: typeof TRANSCRIPT_VERSION;
  sessionId: string;
  log: TranscriptEntry[];
  /** Token total (input+output) of the LAST turn, not cumulative. */
  lastTurnTokens: number;
  lastActiveAt: number;
  turns: number;
}

export function emptyTranscript(sessionId: string, now: number): Transcript {
  return { v: TRANSCRIPT_VERSION, sessionId, log: [], lastTurnTokens: 0, lastActiveAt: now, turns: 0 };
}

/**
 * Record one live event into a turn entry. Returns false when the event is
 * not part of the persisted dialect (thinking), true when the entry changed.
 * The recorded event is a stamped copy; the caller's event is not mutated.
 */
export function recordEvent(turn: TurnEntry, event: HarnessEvent, now: number): boolean {
  if (event.kind === 'thinking') return false;
  const prev = turn.events[turn.events.length - 1];
  // Merge consecutive text deltas: token-level entries would bloat the log
  // and make replay quadratic.
  if (event.kind === 'text-delta' && prev?.kind === 'text-delta' && prev.parentId === event.parentId) {
    prev.text += event.text;
    return true;
  }
  turn.events.push({ ...event, ts: now });
  return true;
}

/**
 * Record the outcome of a mid-turn question on its `ask` event, so replayed
 * history shows the question and what was chosen (null = dismissed).
 */
export function recordAskAnswer(
  turn: TurnEntry,
  askId: string,
  answers: Record<string, string> | null,
): boolean {
  for (const event of turn.events) {
    if (event.kind === 'ask' && event.askId === askId) {
      event.answers = answers;
      return true;
    }
  }
  return false;
}
