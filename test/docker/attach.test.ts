import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Snapshot } from '../../src/harness/daemon-protocol';
import type { TranscriptEntry } from '../../src/harness/transcript';
import { attachClient, docker, startEnv, turnEvents, waitReady, type Env } from './helpers';

// Scenario 2: attach. Handshake, then a fake orchestrator turn streams,
// persists, and replays after a reattach from the last applied seq, also
// across a daemon restart.

let env: Env;

beforeAll(async () => {
  env = await startEnv({});
});
afterAll(async () => {
  await env?.remove();
});

describe('Docker scenario 2: attach', () => {
  it('streams an orchestrator turn, persists it, and replays from `since` after reattaching', async () => {
    const a = await waitReady(env.container);
    const snap = await a.cmd<Snapshot>('snapshot.get');
    const sessionId = snap.orchestratorSessionId as string;
    expect(sessionId).toMatch(/^ses_/);

    const sent = await a.cmd<{ queued: boolean; turnId: string }>('chat.send', { text: 'hello from the suite' });
    expect(sent.queued).toBe(false);
    const end = await a.untilEvent('turn.end', (ev) => ev.turnId === sent.turnId);
    const live = turnEvents(a.events(), sent.turnId);
    const text = live.filter((e) => e.kind === 'text-delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Echo (fresh): hello from the suite');
    expect(live[live.length - 1].kind).toBe('turn-end');
    const start = a.events().find((f) => f.ev.kind === 'turn.start' && f.ev.turnId === sent.turnId);
    if (!start) throw new Error('no turn.start event');
    a.close();

    // Reattach with the cursor at turn.start: exactly the later events replay.
    const b = attachClient(env.container);
    const welcome = await b.hello(start.seq);
    expect(welcome.replay).toBe('events');
    await b.untilEvent('turn.end', (ev) => ev.turnId === sent.turnId);
    const replayed = b.events().filter((f) => f.seq <= end.seq);
    expect(replayed[0].seq).toBe(start.seq + 1);
    expect(replayed.map((f) => f.seq)).toEqual(a.events().filter((f) => f.seq > start.seq && f.seq <= end.seq).map((f) => f.seq));
    expect(turnEvents(replayed, sent.turnId)).toEqual(live);

    // The turn is in the persisted transcript.
    const history = await b.cmd<{ entries: TranscriptEntry[]; total: number }>('session.history', { sessionId });
    expect(history.entries.map((e) => e.kind)).toEqual(['user', 'turn']);
    const turn = history.entries[1] as Extract<TranscriptEntry, { kind: 'turn' }>;
    expect(turn.events.find((e) => e.kind === 'text-delta')).toMatchObject({ text: 'Echo (fresh): hello from the suite' });
    expect(turn.events.some((e) => e.kind === 'thinking')).toBe(false);
    b.close();

    // Restart the container: seq, sessions, resume ids and transcripts survive.
    await docker(['restart', '-t', '30', env.container], { timeoutMs: 90_000 });
    const c = await waitReady(env.container);
    const after = await c.cmd<Snapshot>('snapshot.get');
    expect(after.head).toBeGreaterThan(end.seq);
    expect(after.orchestratorSessionId).toBe(sessionId);
    const again = await c.cmd<{ turnId: string }>('chat.send', { text: 'still there?' });
    await c.untilEvent('turn.end', (ev) => ev.turnId === again.turnId);
    const resumed = turnEvents(c.events(), again.turnId)
      .filter((e) => e.kind === 'text-delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(resumed).toBe('Echo (resumed): still there?');
    c.close();

    const d = attachClient(env.container);
    expect((await d.hello(end.seq)).replay).toBe('events');
    await d.untilEvent('turn.end', (ev) => ev.turnId === again.turnId);
    expect(d.events()[0].seq).toBe(end.seq + 1);
    const full = await d.cmd<{ entries: TranscriptEntry[] }>('session.history', { sessionId });
    expect(full.entries.map((e) => e.kind)).toEqual(['user', 'turn', 'user', 'turn']);
    d.close();
  });

  it('answers a daemon-unavailable frame when the daemon is not running', async () => {
    // Hide the socket for one attach: that is what attach sees before the daemon listens.
    const fail = await docker([
      'exec',
      env.container,
      'sh',
      '-c',
      'mv /run/puck/puckd.sock /run/puck/moved.sock; node /opt/puck/puckd.js attach </dev/null; echo "exit=$?"; mv /run/puck/moved.sock /run/puck/puckd.sock',
    ]);
    expect(fail.stdout).toContain('"code":"daemon-unavailable"');
    expect(fail.stdout).toContain('exit=3');
    const client = await waitReady(env.container);
    client.close();
  });
});
