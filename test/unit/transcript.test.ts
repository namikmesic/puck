import { describe, expect, it } from 'vitest';
import { emptyTranscript, recordAskAnswer, recordEvent, type TurnEntry } from '../../src/harness/transcript';
import type { HarnessEvent } from '../../src/harness/types';
import convoV1 from '../fixtures/convo-v1.json';

const turn = (): TurnEntry => ({ kind: 'turn', turnId: 'trn_1', ts: 1, events: [] });

describe('transcript recording reducer', () => {
  it('merges consecutive deltas per parentId, drops thinking, stamps ts on a copy', () => {
    const t = turn();
    const live: HarnessEvent = { kind: 'text-delta', text: 'Hel' };
    expect(recordEvent(t, { kind: 'thinking', active: true }, 5)).toBe(false);
    recordEvent(t, live, 10);
    recordEvent(t, { kind: 'text-delta', text: 'lo' }, 11);
    recordEvent(t, { kind: 'text-delta', text: 'sub', parentId: 'tool1' }, 12);
    recordEvent(t, { kind: 'text-delta', text: '!' }, 13);
    expect(t.events).toEqual([
      { kind: 'text-delta', text: 'Hello', ts: 10 },
      { kind: 'text-delta', text: 'sub', parentId: 'tool1', ts: 12 },
      { kind: 'text-delta', text: '!', ts: 13 },
    ]);
    expect(live).toEqual({ kind: 'text-delta', text: 'Hel' }); // the live event is untouched
  });

  it('records ask answers on the ask event', () => {
    const t = turn();
    recordEvent(t, { kind: 'ask', askId: 'a1', questions: [] }, 1);
    expect(recordAskAnswer(t, 'a1', { q: 'Yes' })).toBe(true);
    expect(recordAskAnswer(t, 'missing', null)).toBe(false);
    expect(t.events[0]).toMatchObject({ answers: { q: 'Yes' } });
  });

  it('keeps the v1 event dialect: a v1 turn replays into a v2 log unchanged', () => {
    const v1Turn = convoV1.log[1] as unknown as { events: HarnessEvent[] };
    const t = turn();
    for (const e of v1Turn.events) recordEvent(t, e, e.ts ?? 0);
    expect(t.events).toEqual(v1Turn.events);
    const empty = emptyTranscript('ses_1', 7);
    expect(empty).toEqual({ v: 2, sessionId: 'ses_1', log: [], lastTurnTokens: 0, lastActiveAt: 7, turns: 0 });
  });
});
