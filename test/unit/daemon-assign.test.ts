import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDefinition } from '../../src/harness/env-definition';
import { Backlog } from '../../src/daemon/items';
import { nullLogger } from '../../src/daemon/log';
import { itemsStore } from '../../src/daemon/store/items';
import type { SessionRecord } from '../../src/daemon/store/sessions';
import { Work, type WorkDeps } from '../../src/daemon/work';
import { exampleDefinition } from './daemon-fakes';

/**
 * Assigning an item that already has a worker session. The session's own
 * agent is accepted when the item's agent was cleared; any other agent is
 * refused; an item with no session assigns as before.
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
  let backlog: Backlog;
  let work: Work;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-assign-'));
    const parsed = readDefinition(exampleDefinition());
    if (!parsed.ok) throw new Error(parsed.error);
    backlog = new Backlog({ store: itemsStore(dir), emit: () => undefined });
    const sessions = new Map<string, SessionRecord>([['ses_owner', worker('ses_owner', 'implementer')]]);
    const deps: WorkDeps = {
      backlog,
      turns: { get: (id: string) => sessions.get(id) ?? null } as WorkDeps['turns'],
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

  function strand(): ReturnType<Backlog['create']> {
    const item = backlog.create({ title: 'Stuck', body: '', agent: null, repo: null, createdBy: 'user' });
    backlog.patch(item, { sessionId: 'ses_owner' });
    return item;
  }

  it('accepts the session owner when the item agent was cleared', () => {
    const item = strand();
    const assigned = work.assign(item.id, 'implementer', 'user');
    expect(assigned).toMatchObject({ status: 'queued', agent: 'implementer', sessionId: 'ses_owner' });
  });

  it('refuses a different agent and leaves the item as it was', () => {
    const cleared = strand();
    const before = { status: cleared.status, agent: cleared.agent, sessionId: cleared.sessionId, updatedAt: cleared.updatedAt };
    expect(() => work.assign(cleared.id, 'reviewer', 'user')).toThrow(/keeps that agent/);
    expect(backlog.get(cleared.id)).toMatchObject(before);

    const named = backlog.create({ title: 'Named', body: '', agent: 'implementer', repo: null, createdBy: 'user' });
    backlog.patch(named, { sessionId: 'ses_owner' });
    expect(() => work.assign(named.id, 'reviewer', 'orchestrator')).toThrow(/keeps that agent/);
    expect(backlog.get(named.id)).toMatchObject({ status: 'queued', agent: 'implementer', sessionId: 'ses_owner' });
  });

  it('assigns an item with no session to any agent and can clear it', () => {
    const item = backlog.create({ title: 'Plain', body: '', agent: null, repo: null, createdBy: 'user' });
    expect(work.assign(item.id, 'reviewer', 'user')).toMatchObject({ status: 'queued', agent: 'reviewer', sessionId: null });
    expect(work.assign(item.id, 'implementer', 'user')).toMatchObject({ status: 'queued', agent: 'implementer', sessionId: null });
    expect(work.assign(item.id, null, 'user')).toMatchObject({ status: 'backlog', agent: null, sessionId: null });
  });
});
