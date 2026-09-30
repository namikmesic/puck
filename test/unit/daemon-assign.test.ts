import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDefinition } from '../../src/harness/env-definition';
import { latestAttempts } from '../../src/harness/workflow';
import { assignable } from '../../src/renderer/board-model';
import type { Backlog } from '../../src/daemon/items';
import { nullLogger } from '../../src/daemon/log';
import { pickDispatches } from '../../src/daemon/scheduler';
import type { SessionRecord } from '../../src/daemon/store/sessions';
import { Work, type WorkDeps } from '../../src/daemon/work';
import { deliveryStack, exampleDefinition, seedTicket, type Stack } from './daemon-fakes';

/**
 * Assigning a Todo ticket, and a ticket that already has a worker session.
 * The session's own agent is accepted when the ticket's agent was cleared;
 * any other agent is refused; a ticket with no session assigns as before,
 * each change a new attempt of its queued implement step. Only Todo
 * tickets are assigned. Retry gives such a ticket its owner back, so the
 * scheduler can dispatch it.
 */

const log = nullLogger;

function worker(id: string, agent: string): SessionRecord {
  return {
    id,
    kind: 'worker',
    agent,
    harness: 'claude-code',
    cwd: '/workspace',
    status: 'idle',
    queue: [],
    turns: 1,
    lastTurnTokens: 0,
    costUsd: 0,
    createdAt: 1,
    lastActiveAt: 1,
  };
}

describe('Work.assign keeps a session with its agent', () => {
  let dir: string;
  let stack: Stack;
  let backlog: Backlog;
  let work: Work;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-assign-'));
    const parsed = readDefinition(exampleDefinition());
    if (!parsed.ok) throw new Error(parsed.error);
    stack = deliveryStack(dir);
    backlog = stack.backlog;
    const sessions = new Map<string, SessionRecord>([['ses_owner', worker('ses_owner', 'implementer')]]);
    const deps: WorkDeps = {
      backlog,
      workflow: stack.workflow,
      turns: { get: (id: string) => sessions.get(id) ?? null, clearQueue: () => undefined, interrupt: () => undefined } as unknown as WorkDeps['turns'],
      git: {} as WorkDeps['git'],
      publisher: {} as WorkDeps['publisher'],
      definition: () => parsed.value,
      notify: () => undefined,
      slotsChanged: () => undefined,
      requestTick: () => undefined,
      reprovisioning: () => false,
      log,
    };
    work = new Work(deps);
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A Todo ticket that kept its worker session but lost its agent (a legacy backlog record). */
  function strand(): ReturnType<Backlog['get']> & object {
    return seedTicket(stack, { title: 'Stuck', agent: null }, 'backlog', { sessionId: 'ses_owner' });
  }

  function steps(itemId: string) {
    return latestAttempts(stack.workflow.steps(itemId)).filter((s) => s.kind === 'implement');
  }

  function view() {
    return {
      steps: backlog.list().flatMap((i, order) =>
        steps(i.id)
          .filter((s) => s.state !== 'done')
          .map((s) => ({ id: s.id, itemId: i.id, kind: 'implement' as const, state: s.state, agent: s.agent, tier: (i.status === 'in-progress' ? 1 : 2) as 1 | 2, order })),
      ),
      assignments: { implementer: 1 },
      maxWorkers: 3,
    };
  }

  it('accepts the session owner when the ticket agent was cleared', () => {
    const item = strand();
    const assigned = work.assign(item.id, 'implementer', 'user');
    expect(assigned).toMatchObject({ status: 'todo', agent: 'implementer', sessionId: 'ses_owner' });
    expect(steps(item.id).map((s) => [s.state, s.agent, s.sessionId])).toEqual([['queued', 'implementer', 'ses_owner']]);
  });

  it('refuses a different agent and leaves the ticket as it was', () => {
    const cleared = strand();
    const before = { status: cleared.status, agent: cleared.agent, sessionId: cleared.sessionId, updatedAt: cleared.updatedAt };
    expect(() => work.assign(cleared.id, 'reviewer', 'user')).toThrow(/keeps that agent/);
    expect(backlog.get(cleared.id)).toMatchObject(before);
    expect(steps(cleared.id)).toEqual([]);
  });

  it('refuses to assign a ticket that is in progress', () => {
    const running = seedTicket(stack, { title: 'Busy' }, 'running');
    expect(() => work.assign(running.id, 'reviewer', 'orchestrator')).toThrow('W-1 is in progress; only a ticket in Todo is assigned.');
    expect(backlog.get(running.id)).toMatchObject({ status: 'in-progress', agent: 'implementer' });
  });

  it('retry restores the session owner after its agent was cleared and it was cancelled', () => {
    const item = seedTicket(stack, { title: 'Returned' }, 'running', { sessionId: 'ses_owner' });
    expect(work.cancel(item.id, 'user')).toMatchObject({ status: 'done', outcome: 'cancelled', sessionId: 'ses_owner' });
    const tx = stack.workflow.begin('clear');
    tx.push({ kind: 'ticket.patch', itemId: item.id, change: { agent: null } });
    stack.workflow.commit(tx);
    const retried = work.retry(item.id);
    expect(retried).toMatchObject({ status: 'in-progress', agent: 'implementer', sessionId: 'ses_owner', attempts: 0, requeue: 'retry' });
    const queued = steps(item.id).find((s) => s.state === 'queued');
    expect(queued?.round).toBe(2);
    expect(pickDispatches(view())).toEqual([queued?.id]);
    // An In progress ticket keeps its agent: the board offers no assignment.
    expect(assignable({ status: 'in-progress', agent: null, sessionId: 'ses_owner' }, ['implementer', 'reviewer'], 'implementer')).toEqual([]);
    expect(assignable({ status: 'todo', agent: null, sessionId: 'ses_owner' }, ['implementer', 'reviewer'], 'implementer')).toEqual(['implementer']);
  });

  it('retry leaves a ticket that never had a session or an agent waiting in Todo', () => {
    const item = seedTicket(stack, { title: 'Plain', agent: null }, 'backlog');
    work.cancel(item.id, 'user');
    expect(work.retry(item.id)).toMatchObject({ status: 'todo', outcome: null, agent: null, sessionId: null });
    expect(steps(item.id)).toEqual([]);
  });

  it('assigns a ticket with no session to any agent, a new attempt each time, and can clear it', () => {
    const item = seedTicket(stack, { title: 'Plain', agent: null }, 'backlog');
    expect(work.assign(item.id, 'reviewer', 'user')).toMatchObject({ status: 'todo', agent: 'reviewer', sessionId: null });
    expect(work.assign(item.id, 'implementer', 'user')).toMatchObject({ status: 'todo', agent: 'implementer', sessionId: null });
    const all = stack.workflow.steps(item.id).filter((s) => s.kind === 'implement');
    expect(all.map((s) => [s.agent, s.state, s.result, s.attempt])).toEqual([
      ['reviewer', 'done', 'cancelled', 1],
      ['implementer', 'queued', null, 2],
    ]);
    expect(work.assign(item.id, null, 'user')).toMatchObject({ status: 'todo', agent: null, sessionId: null });
    expect(steps(item.id).map((s) => s.state)).toEqual(['done']);
    expect(() => work.assign(item.id, null, 'user')).toThrow('W-1 is not assigned.');
  });
});
