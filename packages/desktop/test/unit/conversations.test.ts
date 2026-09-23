import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { app } from '../mocks/electron';
import * as conversations from '../../src/main/conversations';

const dir = path.join(app.getPath('userData'), 'puck-convos');
const file = (agentId: string): string => path.join(dir, `${agentId}.json`);
const empty = { v: 1, log: [], lastTurnTokens: 0, lastActiveAt: 0, turns: 0 };

describe('conversations', () => {
  it('writes one JSON file per agent', async () => {
    await conversations.save('agent-a', empty);
    expect(JSON.parse(fs.readFileSync(file('agent-a'), 'utf8'))).toMatchObject({ v: 1, turns: 0 });
  });

  it('enforces the size ceiling', async () => {
    const big = { kind: 'user' as const, text: 'x'.repeat(9_000_000), author: 'u', ts: 1 };
    await expect(conversations.save('agent-big', { ...empty, log: [big] })).rejects.toThrow(
      /too large/,
    );
    expect(fs.existsSync(file('agent-big'))).toBe(false);
  });

  it('normalizes legacy shapes on load and skips log-less snapshots', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file('agent-old'), JSON.stringify({ log: [], usage: 42, lastActiveAt: 7, turns: 3 }));
    fs.writeFileSync(file('agent-html'), JSON.stringify({ html: '<ol></ol>', usage: 1 }));
    const all = conversations.loadAll();
    expect(all['agent-old']).toEqual({ v: 1, log: [], lastTurnTokens: 42, lastActiveAt: 7, turns: 3 });
    expect(all['agent-html']).toBeUndefined();
    expect(all['agent-a']).toMatchObject({ v: 1 });
  });
});

describe('fromIpc (strict IPC-save codec)', () => {
  const turn = { kind: 'turn', ts: 5, events: [{ kind: 'text-delta', text: 'hi' }] };
  const user = { kind: 'user', text: 'hello', author: 'user', ts: 4 };

  it('round-trips a valid payload and coerces the numeric fields', () => {
    const out = conversations.fromIpc({ log: [user, turn], lastTurnTokens: 'x', lastActiveAt: 9, turns: 1 });
    expect(out.log).toEqual([user, turn]);
    expect(out.lastTurnTokens).toBe(0); // non-number coerced
    expect(out.lastActiveAt).toBe(9);
    expect(out.draft).toBeUndefined();
  });

  it('keeps a string draft and drops a non-string one', () => {
    expect(conversations.fromIpc({ log: [], lastActiveAt: 0, turns: 0, draft: 'd' }).draft).toBe('d');
    expect(
      conversations.fromIpc({ log: [], lastActiveAt: 0, turns: 0, draft: 7 }).draft,
    ).toBeUndefined();
  });

  it('throws on malformed payloads instead of writing them to disk', () => {
    expect(() => conversations.fromIpc(null)).toThrow();
    expect(() => conversations.fromIpc([])).toThrow();
    expect(() => conversations.fromIpc({ log: 'nope' })).toThrow();
    expect(() => conversations.fromIpc({ log: [{ kind: 'mystery' }] })).toThrow();
    expect(() => conversations.fromIpc({ log: [{ kind: 'turn', ts: 1 }] })).toThrow(); // no events array
  });

  it('rejects turn events that are not event-shaped', () => {
    expect(() =>
      conversations.fromIpc({ log: [{ kind: 'turn', ts: 1, events: ['junk'] }] }),
    ).toThrow(/event/i);
    expect(() =>
      conversations.fromIpc({ log: [{ kind: 'turn', ts: 1, events: [{ text: 'no kind' }] }] }),
    ).toThrow(/event/i);
    expect(() =>
      conversations.fromIpc({ log: [{ kind: 'turn', ts: 1, events: [{ kind: 42 }] }] }),
    ).toThrow(/event/i);
  });
});
