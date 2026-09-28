import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonEvent, ItemStatus, Snapshot, WorkItem } from '../../src/harness/daemon-protocol';
import { exec, startEnv, turnEvents, untilSnapshot, waitReady, type Env } from './helpers';

// Scenario 3: work. The orchestrator creates two items for an agent with
// maxParallel 1 through its in-process tools; only one runs at a time, each
// in its own worktree and branch as the puck user, and each reaches review
// with its commits and diff stat. The tool handlers run in the root daemon
// while the (fake) harness process runs as puck.

let env: Env;
let client: Awaited<ReturnType<typeof waitReady>>;

beforeAll(async () => {
  env = await startEnv({});
  client = await waitReady(env.container);
});
afterAll(async () => {
  client?.close();
  await env?.remove();
});

/** A body the fake worker executes: commit a file, then take a moment so overlap would show. */
const body = (file: string): string =>
  [`!exec printf '${file}\\n' > ${file}.txt && git add ${file}.txt && git commit -qm "Add ${file}" && git log --oneline | head -1`, '!sleep 1500'].join(
    '\n',
  );

describe('Docker scenario 3: work', () => {
  it('runs one item at a time for maxParallel 1, each in its own worktree, and both reach review', async () => {
    const snap0 = await client.cmd<Snapshot>('snapshot.get');
    const orchestrator = snap0.orchestratorSessionId as string;
    const tool = (name: string, args: unknown): string => `!tool ${name} ${JSON.stringify(args)}`;
    const sent = await client.cmd<{ turnId: string }>('chat.send', {
      sessionId: orchestrator,
      text: [
        tool('backlog_create', { title: 'Add one', body: body('one'), agent: 'implementer' }),
        tool('backlog_create', { title: 'Add two', body: body('two'), agent: 'implementer' }),
        '!exec id -u',
        'Two items queued.',
      ].join('\n'),
    });
    await client.untilEvent('turn.end', (ev) => ev.turnId === sent.turnId);
    const orchestratorTurn = turnEvents(client.events(), sent.turnId);
    const toolEnds = orchestratorTurn.filter((e): e is Extract<typeof e, { kind: 'tool-end' }> => e.kind === 'tool-end');
    expect(toolEnds.slice(0, 2).map((e) => e.ok)).toEqual([true, true]);
    expect(JSON.parse(toolEnds[0].output)).toMatchObject({ item: 'W-1', status: 'queued', agent: 'implementer' });
    // The harness process runs as puck…
    expect(toolEnds[2].output).toContain('10001');
    // …while the tool handlers ran in the daemon, as root.
    const logs = await client.cmd<{ text: string }>('logs.tail', { lines: 400 });
    const toolLines = logs.text.split('\n').filter((l) => l.includes(' tool.call '));
    expect(toolLines).toHaveLength(2);
    for (const line of toolLines) expect(line).toMatch(/"uid":0\b/);

    const done = await untilSnapshot(client, (s) => s.items.length === 2 && s.items.every((i) => i.status === 'review'), 90_000);

    // Never more than one running at a time, from the recorded item events.
    const status = new Map<string, ItemStatus>();
    let peak = 0;
    for (const f of client.events()) {
      const ev: DaemonEvent = f.ev;
      if (ev.kind !== 'item.upsert') continue;
      status.set(ev.item.id, ev.item.status);
      peak = Math.max(peak, [...status.values()].filter((s) => s === 'running' || s === 'needs-input').length);
    }
    expect(peak).toBe(1);
    expect(done.capacity.agents.implementer).toEqual({ running: 0, max: 1 });

    for (const [i, name] of [[0, 'one'], [1, 'two']] as const) {
      const item: WorkItem = done.items[i];
      expect(item).toMatchObject({ number: i + 1, attempts: 1, repo: 'app', createdBy: 'orchestrator' });
      expect(item.branch).toBe(`puck/W-${i + 1}-add-${name}`);
      expect(item.worktree).toBe(`/workspace/.puck/worktrees/W-${i + 1}`);
      expect(item.result?.commits.map((c) => c.subject)).toEqual([`Add ${name}`]);
      expect(item.result?.diffStat).toMatchObject({ files: 1, insertions: 1, deletions: 0 });
      expect(item.result?.diffStat.text).toContain(`${name}.txt`);
      expect(item.result?.uncommitted).toEqual([]);
      expect(item.result?.summary).toContain('Echo (fresh): When you are done');

      const owner = await exec(env.container, ['stat', '-c', '%U', item.worktree as string]);
      expect(owner.stdout.trim()).toBe('puck');
      const branch = await exec(env.container, ['git', '-C', item.worktree as string, 'branch', '--show-current'], 'puck');
      expect(branch.stdout.trim()).toBe(item.branch);
    }
    // Each worker session is its own, rooted in its worktree.
    const workers = done.sessions.filter((s) => s.kind === 'worker');
    expect(workers.map((s) => s.cwd).sort()).toEqual(['/workspace/.puck/worktrees/W-1', '/workspace/.puck/worktrees/W-2']);
  });
});
