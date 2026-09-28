import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Snapshot } from '../../src/harness/daemon-protocol';
import type { TranscriptEntry } from '../../src/harness/transcript';
import { attachClient, docker, startEnv, untilSnapshot, waitReady, type Env } from './helpers';

// Scenario 5: restart. `docker restart` while an item runs. The restart is
// not a failed attempt: after boot the item is requeued without a count,
// its next dispatch resumes the SAME worker session through the harness's
// saved conversation (the fake reports it as "resumed"), nothing is run
// from the start, and the orchestrator gets an environment.restarted
// notice naming the item.

let env: Env;

beforeAll(async () => {
  env = await startEnv({});
});
afterAll(async () => {
  await env?.remove();
});

describe('Docker scenario 5: restart', () => {
  it('resumes the interrupted item in its existing session without counting an attempt', async () => {
    const a = await waitReady(env.container);
    await a.cmd('item.create', {
      title: 'Long job',
      body: ["!exec printf 'start\\n' > start.txt && git add start.txt && git commit -qm Start && echo ok", '!sleep 120000'].join('\n'),
      agent: 'implementer',
    });
    const running = (await untilSnapshot(a, (s) => s.items[0]?.status === 'running' && s.inflight.some((t) => t.sessionId === s.items[0].sessionId))).items[0];
    const sessionId = running.sessionId as string;
    // Let the worker's commit land before the restart.
    await a.untilEvent('turn.event', (ev) => ev.sessionId === sessionId && ev.event.kind === 'tool-end', 60_000);
    const cursor = (await a.cmd<Snapshot>('snapshot.get')).head;
    a.close();

    await docker(['restart', '-t', '30', env.container], { timeoutMs: 120_000 });

    const b = await waitReady(env.container);
    const done = (await untilSnapshot(b, (s) => s.items[0]?.status === 'review', 90_000)).items[0];
    expect(done.attempts).toBe(1);
    expect(done.sessionId).toBe(sessionId);
    expect(done.result?.commits.map((c) => c.subject)).toEqual(['Start']);
    const snap = await b.cmd<Snapshot>('snapshot.get');
    expect(snap.sessions.filter((s) => s.kind === 'worker').map((s) => s.id)).toEqual([sessionId]);
    b.close();

    // Replayed from before the restart: the item went back to queued with its attempt count unchanged.
    const c = attachClient(env.container);
    expect((await c.hello(cursor)).replay).toBe('events');
    await c.untilEvent('item.upsert', (ev) => ev.item.status === 'review');
    const statuses = c
      .events()
      .flatMap((f) => (f.ev.kind === 'item.upsert' ? [[f.ev.item.status, f.ev.item.attempts] as const] : []));
    expect(statuses).toContainEqual(['queued', 1]);
    expect(statuses.every(([, attempts]) => attempts === 1)).toBe(true);

    // The worker conversation continued: its resumed turn got the continue message, not the work item from the start.
    const worker = await c.cmd<{ entries: TranscriptEntry[] }>('session.history', { sessionId });
    const users = worker.entries.flatMap((e) => (e.kind === 'user' ? [e.text] : []));
    expect(users).toHaveLength(2);
    expect(users[0]).toMatch(/^You are working on work item W-1: Long job/);
    expect(users[1]).toBe('Your previous attempt was interrupted (the environment restarted). Continue work item W-1. Check `git status` and the log before continuing.');
    const lastTurn = worker.entries.filter((e): e is Extract<TranscriptEntry, { kind: 'turn' }> => e.kind === 'turn').at(-1);
    const text = lastTurn?.events.flatMap((e) => (e.kind === 'text-delta' ? [e.text] : [])).join('');
    expect(text).toMatch(/^Echo \(resumed\): Your previous attempt was interrupted/);

    // The orchestrator hears about it (auto-wake delivers the notice in its own turn).
    const orchestrator = snap.orchestratorSessionId as string;
    const deadline = Date.now() + 30_000;
    let noticeText = '';
    while (!noticeText && Date.now() < deadline) {
      const h = await c.cmd<{ entries: TranscriptEntry[] }>('session.history', { sessionId: orchestrator });
      noticeText =
        h.entries.flatMap((e) => (e.kind === 'notice' ? e.notices : [])).find((n) => n.kind === 'environment.restarted')?.text ?? '';
      if (!noticeText) await new Promise((r) => setTimeout(r, 500));
    }
    expect(noticeText).toContain('requeued without counting an attempt, each continuing its existing worker session: W-1 "Long job"');
    c.close();
  });
});
