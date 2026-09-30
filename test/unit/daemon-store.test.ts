import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, isServingArgv, releaseLock } from '../../src/daemon/lock';
import { createLogger, tailLog } from '../../src/daemon/log';
import { flushJsonWrites, readJsonFile, writeJsonAtomic, writeJsonAtomicSync } from '../../src/daemon/store/jsonfile';
import { FORMAT_VERSION, migrateState, migrateToFormat2, type Migration } from '../../src/daemon/store/meta';
import { legacyIds } from '../../src/harness/workflow';
import { LEGACY, LEGACY_T, legacyState, writeLegacyState } from './daemon-fakes';
import { sessionsStore } from '../../src/daemon/store/sessions';
import { ulid, newId } from '../../src/harness/ulid';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-store-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('daemon stores', () => {
  it('writes atomically, serialized per file, root-only', async () => {
    const file = path.join(dir, 'x.json');
    await Promise.all([writeJsonAtomic(file, { n: 1 }), writeJsonAtomic(file, { n: 2 }), writeJsonAtomic(file, { n: 3 })]);
    expect(readJsonFile(file)).toEqual({ n: 3 });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['x.json']); // no temp files left behind
  });

  it('applies ?? defaults to sessions written by an older daemon', async () => {
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ ses_1: { agent: 'lead' }, bad: 3 }));
    const store = sessionsStore(dir);
    expect(store.get().ses_1).toMatchObject({ id: 'ses_1', kind: 'orchestrator', status: 'idle', turns: 0, cwd: '/workspace' });
    expect(store.get().bad).toBeUndefined();
    await flushJsonWrites();
  });

  it('a failed synchronous commit leaves the previous file and flush still finishes', async () => {
    const store = sessionsStore(dir);
    store.get().ses_1 = {
      id: 'ses_1',
      kind: 'orchestrator',
      agent: 'lead',
      harness: 'claude-code',
      cwd: '/workspace',
      status: 'idle',
      queue: [{ text: 'keep me', author: 'user' }],
      turns: 0,
      lastTurnTokens: 0,
      costUsd: 0,
      createdAt: 1,
      lastActiveAt: 1,
    };
    store.commit();
    const good = fs.readFileSync(store.file, 'utf8');
    fs.chmodSync(dir, 0o500);
    try {
      store.get().ses_1.queue = [];
      store.get().ses_1.status = 'running';
      expect(() => store.commit()).toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    await flushJsonWrites();
    expect(fs.readFileSync(store.file, 'utf8')).toBe(good);

    const parent = path.join(dir, 'not-a-directory');
    fs.writeFileSync(parent, 'x');
    expect(() => writeJsonAtomicSync(path.join(parent, 'child.json'), { n: 1 })).toThrow();
    await flushJsonWrites();
  });
});

describe('state format migrations', () => {
  const opts = { daemonVersion: '0.0.1+abc', now: 1000 };

  it('a fresh volume starts at the current format', () => {
    const r = migrateState(dir, opts);
    expect(r).toMatchObject({ ok: true, from: null, to: FORMAT_VERSION });
    expect(readJsonFile(path.join(dir, 'meta.json'))).toEqual({ formatVersion: FORMAT_VERSION, daemonVersion: '0.0.1+abc', createdAt: 1000, formatBoundary: 0 });
  });

  it('runs ordered migrations over the store files and records the new format', () => {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ formatVersion: 1, daemonVersion: 'old', createdAt: 5 }));
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ a: { agent: 'x' } }));
    const order: number[] = [];
    const migrations: Migration[] = [
      { to: 3, run: (s) => (order.push(3), { ...s, 'notices.json': { pending: [] } }) },
      { to: 2, run: (s) => (order.push(2), { ...s, 'sessions.json': { ...(s['sessions.json'] as object), b: { agent: 'y' } } }) },
    ];
    const r = migrateState(dir, { ...opts, target: 3, migrations });
    expect(r).toMatchObject({ ok: true, from: 1, to: 3 });
    expect(order).toEqual([2, 3]);
    expect(readJsonFile(path.join(dir, 'sessions.json'))).toEqual({ a: { agent: 'x' }, b: { agent: 'y' } });
    expect(readJsonFile(path.join(dir, 'notices.json'))).toEqual({ pending: [] });
    expect(readJsonFile(path.join(dir, 'meta.json'))).toMatchObject({ formatVersion: 3, createdAt: 5, daemonVersion: '0.0.1+abc' });
  });

  it('fails without touching state when a migration throws or is missing', () => {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ formatVersion: 1, daemonVersion: 'old', createdAt: 5 }));
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{"a":{"agent":"x"}}');
    const broken: Migration[] = [{ to: 2, run: () => { throw new Error('boom'); } }];
    expect(migrateState(dir, { ...opts, target: 2, migrations: broken })).toEqual({
      ok: false,
      error: 'State migration from format 1 failed: boom',
    });
    expect(migrateState(dir, { ...opts, target: 2, migrations: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/no migration to format 2/) });
    expect(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')).toBe('{"a":{"agent":"x"}}');
  });

  it('refuses state written by a newer daemon', () => {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ formatVersion: FORMAT_VERSION + 1, daemonVersion: 'new', createdAt: 5 }));
    expect(migrateState(dir, opts)).toMatchObject({ ok: false, error: expect.stringMatching(/newer daemon/) });
  });
});

describe('daemon lock', () => {
  it('treats a bare puckd.js as serve and does not treat attach or version as the holder', () => {
    expect(isServingArgv(['node', '/opt/puck/puckd.js'])).toBe(true);
    expect(isServingArgv(['node', '/opt/puck/puckd.js', ''])).toBe(true);
    expect(isServingArgv(['node', '/opt/puck/puckd.js', 'serve'])).toBe(true);
    expect(isServingArgv(['node', '/opt/puck/puckd.js', 'attach'])).toBe(false);
    expect(isServingArgv(['node', '/opt/puck/puckd.js', 'version'])).toBe(false);
    expect(isServingArgv(['node', '/usr/bin/node', 'serve'])).toBe(false);
  });

  it('holds against a running daemon and takes over a stale or foreign pid', () => {
    const file = path.join(dir, 'puckd.lock');
    expect(acquireLock(file, { pid: 100, isDaemon: () => true })).toBe(true);
    expect(acquireLock(file, { pid: 200, isDaemon: (pid) => pid === 100 })).toBe(false);
    expect(acquireLock(file, { pid: 200, isDaemon: () => false })).toBe(true); // 100 is gone or an attach
    expect(fs.readFileSync(file, 'utf8')).toBe('200');
    releaseLock(file, 100); // not ours: kept
    expect(fs.existsSync(file)).toBe(true);
    releaseLock(file, 200);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('daemon log', () => {
  it('rotates at the size limit, keeps three files, redacts, and tails across files', () => {
    const log = createLogger({ dir, maxBytes: 200, keep: 3, now: () => new Date(0) });
    for (let i = 0; i < 20; i++) log.info(`event ${i}`, { token: 'sk-ant-abcdefghijklmnopqrstuvwxyz' });
    expect(log.files().map((f) => path.basename(f))).toEqual(['puckd.log', 'puckd.log.1', 'puckd.log.2']);
    const text = tailLog(log, 3);
    expect(text.split('\n')).toHaveLength(3);
    expect(text).toContain('event 19');
    expect(text).not.toContain('sk-ant');
  });
});

describe('ulid', () => {
  it('sorts by time and stays monotonic within a millisecond', () => {
    const ids = [ulid(1000), ulid(1000), ulid(1000), ulid(2000)];
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true);
    expect(newId('ses')).toMatch(/^ses_[0-9A-Z]{26}$/);
  });
});

describe('the format-2 migration', () => {
  // 4.1's mapping, applied to one ticket in each old status (12.1).
  const WANT: Record<keyof typeof LEGACY, { status: string; outcome: string | null; stage: string | null; closedAt: 'updated' | null; workflow: boolean }> = {
    backlog: { status: 'todo', outcome: null, stage: null, closedAt: null, workflow: false },
    queued: { status: 'todo', outcome: null, stage: null, closedAt: null, workflow: true },
    requeued: { status: 'in-progress', outcome: null, stage: 'implement', closedAt: null, workflow: true },
    running: { status: 'in-progress', outcome: null, stage: 'implement', closedAt: null, workflow: true },
    askOrch: { status: 'in-progress', outcome: null, stage: 'implement', closedAt: null, workflow: true },
    askUser: { status: 'in-progress', outcome: null, stage: 'implement', closedAt: null, workflow: true },
    review: { status: 'in-progress', outcome: null, stage: 'merge', closedAt: null, workflow: true },
    accepted: { status: 'done', outcome: 'accepted', stage: null, closedAt: 'updated', workflow: true },
    merged: { status: 'done', outcome: 'merged', stage: null, closedAt: 'updated', workflow: true },
    failed: { status: 'done', outcome: 'failed', stage: null, closedAt: 'updated', workflow: true },
    cancelled: { status: 'done', outcome: 'cancelled', stage: null, closedAt: 'updated', workflow: true },
  };

  it('maps every old status to status, stage and outcome, keeping everything else', () => {
    const { items, sessions } = legacyState();
    const out = migrateToFormat2({ 'items.json': items, 'sessions.json': sessions });
    const migrated = (out['items.json'] as { items: Record<string, Record<string, unknown>> }).items;
    const old = (items as { items: Record<string, Record<string, unknown>> }).items;
    for (const [name, id] of Object.entries(LEGACY) as [keyof typeof LEGACY, string][]) {
      const rec = migrated[id] as Record<string, unknown>;
      const was = old[id] as Record<string, unknown>;
      const want = WANT[name];
      expect({ status: rec.status, outcome: rec.outcome, stage: rec.stage }, name).toEqual({ status: want.status, outcome: want.outcome, stage: want.stage });
      expect(rec.closedAt, name).toBe(want.closedAt ? was.updatedAt : null);
      expect(rec.legacyStatus, name).toBe(was.status);
      expect(rec.workflowId, name).toBe(want.workflow ? legacyIds(id).workflowId : null);
      expect(rec.recordFormat, name).toBe(2);
      for (const key of ['agent', 'attempts', 'sessionId', 'branch', 'worktree', 'base', 'lastError', 'cancelReason', 'acceptNote', 'requeue', 'pushedSha', 'createdBy', 'createdAt', 'updatedAt']) {
        expect(rec[key], `${name}.${key}`).toEqual(was[key]);
      }
      for (const key of ['source', 'pr', 'pendingAsk']) expect(rec, `${name} drops ${key}`).not.toHaveProperty(key);
      expect(rec.delivery, name).toBeNull();
    }
    // The question routed to the orchestrator and the one routed to the user.
    const ids = (id: string) => legacyIds(id);
    expect(migrated[LEGACY.askOrch]).toMatchObject({
      needsInput: { askId: 'ask_01J0000000000000000000ORCH', kind: 'question', roundId: ids(LEGACY.askOrch).roundId, stepId: ids(LEGACY.askOrch).implementId, routedTo: 'orchestrator', since: old[LEGACY.askOrch]?.updatedAt },
      oldestUserAsk: null,
      openAsks: 1,
      userAsks: 0,
    });
    expect(migrated[LEGACY.askUser]).toMatchObject({ needsInput: { routedTo: 'user' }, oldestUserAsk: { askId: 'ask_01J0000000000000000000USER' }, openAsks: 1, userAsks: 1 });
    // Source and pull request become references.
    expect((migrated[LEGACY.review] as { references: unknown[] }).references).toEqual([
      { id: `ref_${LEGACY.review.slice(4)}_s`, role: 'source', kind: 'github-issue', repo: 'octo/app', number: 12, url: 'https://github.com/octo/app/issues/12', updatedAt: LEGACY_T },
      { id: `ref_${LEGACY.review.slice(4)}_d`, role: 'delivery', kind: 'github-pr', repo: 'octo/app', number: 40, url: 'https://github.com/octo/app/pull/40', draft: true, lastPushedSha: 'c'.repeat(40), state: 'open' },
    ]);
    expect((migrated[LEGACY.merged] as { references: Array<{ state?: string }> }).references[0]?.state).toBe('merged');
    // Each worker session gains its ticket's implement step; the orchestrator's does not.
    const migratedSessions = out['sessions.json'] as Record<string, Record<string, unknown>>;
    for (const s of Object.values(migratedSessions)) {
      if (s.kind === 'worker') expect(s.stepId, String(s.itemId)).toBe(legacyIds(String(s.itemId)).implementId);
      else expect(s).not.toHaveProperty('stepId');
    }
    expect(migratedSessions[String(old[LEGACY.running]?.sessionId)]?.queue).toEqual([{ text: 'Also update the docs.', author: 'user' }]);
    // A second run leaves every record exactly as it is.
    expect(migrateToFormat2(out)).toEqual(out);
  });

  it('ends in the same state after a crash after any store file, and records the event log boundary', () => {
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-mig-'));
    try {
      writeLegacyState(clean);
      expect(migrateState(clean, { daemonVersion: 'new', now: 5, eventHead: 42 })).toMatchObject({ ok: true, from: 1, to: 2 });
      const want = (d: string) => Object.fromEntries(['items.json', 'sessions.json', 'meta.json'].map((f) => [f, readJsonFile(path.join(d, f))]));
      const expected = want(clean);
      expect(expected['meta.json']).toMatchObject({ formatVersion: 2, formatBoundary: 42 });
      // A crash before each file is written: the store files one by one, meta.json last.
      const files: string[] = [];
      const counted = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-mig-'));
      writeLegacyState(counted);
      migrateState(counted, { daemonVersion: 'new', now: 5, eventHead: 42, write: (file, text) => (files.push(path.basename(file)), fs.writeFileSync(file, text)) });
      fs.rmSync(counted, { recursive: true, force: true });
      expect(files).toEqual(['sessions.json', 'items.json', 'meta.json']);
      for (let crashAt = 1; crashAt <= files.length; crashAt++) {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-mig-'));
        try {
          writeLegacyState(d);
          let writes = 0;
          const crashing = (file: string, text: string): void => {
            writes += 1;
            if (writes === crashAt) throw new Error('crash');
            fs.writeFileSync(file, text);
          };
          expect(() => migrateState(d, { daemonVersion: 'new', now: 5, eventHead: 42, write: crashing })).toThrow('crash');
          expect(migrateState(d, { daemonVersion: 'new', now: 5, eventHead: 42 })).toMatchObject({ ok: true, to: 2 });
          expect(want(d), `crash at write ${crashAt}`).toEqual(expected);
        } finally {
          fs.rmSync(d, { recursive: true, force: true });
        }
      }
    } finally {
      fs.rmSync(clean, { recursive: true, force: true });
    }
  });
});
