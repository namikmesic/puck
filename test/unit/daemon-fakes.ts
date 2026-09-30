import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandRunner, RunOptions, RunResult } from '../../src/daemon/exec';
import { daemonPaths, type DaemonPaths } from '../../src/daemon/paths';
import type { DaemonEvent, ItemStatusV1, Reference } from '../../src/harness/daemon-protocol';
import { statusV1 } from '../../src/harness/workflow';
import type { Journal, JournalIO, Ledger } from '../../src/daemon/delivery/journal';
import type { TicketChange } from '../../src/daemon/delivery/derive';
import { actor, PIPELINE } from '../../src/daemon/delivery/derive';
import { Backlog } from '../../src/daemon/items';
import { nullLogger } from '../../src/daemon/log';
import { deliveryStore, type TablesFile } from '../../src/daemon/store/delivery';
import { itemsStore, type ItemRecord, type ItemsFile } from '../../src/daemon/store/items';
import type { JsonStore } from '../../src/daemon/store/store';
import {
  addManualMerge,
  askFields,
  endSteps,
  openFirstRound,
  openRound,
  publicItem,
  queueImplement,
  stepMove,
  ticketPatch,
  ticketStatus,
  activeImplementOf,
  bootDelivery,
  type DeliveryBoot,
  type Workflow,
} from '../../src/daemon/workflow';

export interface RecordedCommand {
  argv: string[];
  opts: RunOptions;
}

/**
 * A CommandRunner that records every command and answers from `respond`
 * (default: success with empty output).
 */
export function fakeRunner(respond: (argv: string[], opts: RunOptions) => Partial<RunResult> | undefined = () => undefined) {
  const calls: RecordedCommand[] = [];
  const run: CommandRunner = async (argv, opts = {}) => {
    calls.push({ argv, opts });
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...respond(argv, opts) };
  };
  return { run, calls };
}

/** A daemon filesystem layout under a fresh temporary root. */
export function tempRoot(prefix = 'puckd-'): { root: string; paths: DaemonPaths; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, paths: daemonPaths(root), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A resolved definition as the app delivers it. */
export function exampleDefinition(over: Record<string, unknown> = {}): Record<string, unknown> {
  const lead = { harness: 'claude-code', model: 'auto', effort: 'high', instructions: 'Lead the work.' };
  return {
    name: 'example',
    repos: [{ github: 'octo/app', dir: 'app', branch: 'main' }],
    orchestrator: { agent: 'lead', autoWake: true, maxAutoTurnsPerHour: 30 },
    agents: [
      { agent: 'implementer', maxParallel: 2, instructions: 'Stay in scope.' },
      { agent: 'reviewer', maxParallel: 1 },
    ],
    agentDefinitions: {
      lead,
      implementer: { harness: 'claude-code', instructions: 'Implement.' },
      reviewer: { harness: 'codex', instructions: 'Review.' },
    },
    git: { userName: 'Puck Agent', userEmail: 'puck-agent@users.noreply.github.com' },
    env: { NODE_ENV: 'development' },
    secrets: ['NPM_TOKEN'],
    ...over,
  };
}

/** The value, or a failed test when it is missing. */
export function defined<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

/* ---------- The journaled ticket stack ---------- */

export interface Stack {
  dir: string;
  items: JsonStore<ItemsFile>;
  tables: JsonStore<TablesFile>;
  journal: Journal;
  ledger: Ledger;
  workflow: Workflow;
  backlog: Backlog;
  /** Every event the ledger emitted. */
  events: DaemonEvent[];
  /** The protocol shape of a ticket, with its workflow summary. */
  pub(item: ItemRecord): ReturnType<typeof publicItem>;
  boot: DeliveryBoot;
}

/** Items, tables, the journal and the ledger over a state directory, as the daemon boots them (rolled forward). */
export function deliveryStack(dir: string, opts: { now?: () => number; io?: JournalIO; emit?(ev: DaemonEvent): void; hooks?: ConstructorParameters<typeof Ledger>[0]['hooks'] } = {}): Stack {
  const now = opts.now ?? Date.now;
  const items = itemsStore(dir);
  const tables = deliveryStore(dir);
  const events: DaemonEvent[] = [];
  const boot = bootDelivery({
    file: path.join(dir, 'delivery', 'journal.ndjson'),
    items,
    tables,
    emit: (ev) => {
      events.push(ev);
      opts.emit?.(ev);
    },
    log: nullLogger,
    now,
    io: opts.io,
    hooks: opts.hooks,
  });
  const pub = (item: ItemRecord) => publicItem(item, tables.get().workflows[item.id] ?? null);
  return { dir, items, tables, journal: boot.journal, ledger: boot.ledger, workflow: boot.workflow, backlog: new Backlog({ store: items, now }), events, pub, boot };
}

/** Where a ticket is, in protocol 1's words (the projection's mapping): what the older suites assert. */
export function placeOf(stack: Stack, item: ItemRecord | null | undefined): ItemStatusV1 | null {
  if (!item) return null;
  return statusV1(stack.pub(item));
}

export type Place = ItemStatusV1;

/**
 * A ticket seeded the way the daemon leaves it after the usual steps, for
 * tests: `backlog` (no agent), `queued` (Todo; with `over.sessionId`, In
 * progress after a restart or follow-up), `running`, `needs-input` (a
 * question routed to `askTo`), `review` (the worker finished; the merge
 * step waits), `done` (accepted), `failed`, `cancelled`.
 */
export function seedTicket(
  stack: Stack,
  init: { title: string; body?: string; agent?: string | null; repo?: string | null; createdBy?: ItemRecord['createdBy']; references?: Reference[] },
  place: Place,
  over: TicketChange & { askTo?: 'user' | 'orchestrator' } = {},
): ItemRecord {
  const { askTo, ...change } = over;
  const agent = init.agent === undefined ? (place === 'backlog' ? null : 'implementer') : init.agent;
  const session = change.sessionId ?? (place === 'backlog' || (place === 'queued' && !change.sessionId) || place === 'cancelled' ? null : 'ses_01J0000000000000000000000A');
  const tx = stack.workflow.begin('seed');
  const item = stack.backlog.create(tx, {
    title: init.title,
    body: init.body ?? '',
    agent,
    repo: init.repo ?? null,
    createdBy: init.createdBy ?? 'user',
    references: init.references ?? [],
  });
  const id = item.id;
  const step = (): ReturnType<typeof activeImplementOf> => activeImplementOf(tx.steps(id));
  const start = (): void => {
    ticketStatus(tx, tx.item(id) as ItemRecord, 'start', { change: { sessionId: session, attempts: 1 }, by: PIPELINE });
    stepMove(tx, id, step() as NonNullable<ReturnType<typeof step>>, 'start', 'running');
  };
  if (agent && place !== 'backlog') {
    openFirstRound(tx, id, 'assigned');
    queueImplement(tx, id, 1, { agent, sessionId: session, purpose: 'task' });
  }
  switch (place) {
    case 'queued':
      if (change.sessionId) {
        start();
        stepMove(tx, id, step() as NonNullable<ReturnType<typeof step>>, 'restart', 'queued');
        ticketPatch(tx, tx.item(id) as ItemRecord, { requeue: 'restart' });
      }
      break;
    case 'running':
      start();
      break;
    case 'needs-input': {
      start();
      const s = step() as NonNullable<ReturnType<typeof step>>;
      stepMove(tx, id, s, 'ask', 'needs-input');
      const round = tx.workflow(id)?.rounds[0];
      ticketPatch(tx, tx.item(id) as ItemRecord, askFields([{ askId: 'ask_01J0000000000000000000000A', kind: 'question', roundId: round?.roundId ?? '', stepId: s.id, routedTo: askTo ?? 'orchestrator', since: tx.at }]));
      break;
    }
    case 'review':
    case 'done':
      start();
      stepMove(tx, id, step() as NonNullable<ReturnType<typeof step>>, 'finish', 'done', { result: 'passed' });
      addManualMerge(tx, id, 1);
      if (place === 'done') {
        ticketStatus(tx, tx.item(id) as ItemRecord, 'accept', { by: actor('user') });
        endSteps(tx, id, 'accept');
      }
      break;
    case 'failed':
      start();
      stepMove(tx, id, step() as NonNullable<ReturnType<typeof step>>, 'error-final', 'done', { result: 'failed' });
      ticketStatus(tx, tx.item(id) as ItemRecord, 'fail', { change: { lastError: 'It broke.' }, by: PIPELINE });
      endSteps(tx, id, 'fail');
      break;
    case 'cancelled':
      ticketStatus(tx, tx.item(id) as ItemRecord, 'cancel', { by: actor('user') });
      endSteps(tx, id, 'cancel');
      break;
    default:
      break;
  }
  if (Object.keys(change).length) ticketPatch(tx, tx.item(id) as ItemRecord, change);
  stack.workflow.commit(tx);
  return stack.backlog.get(id) as ItemRecord;
}

/** Open a new round for a finished ticket, the way a message to its worker does. */
export function seedChanges(stack: Stack, item: ItemRecord): ItemRecord {
  const tx = stack.workflow.begin('seed.changes');
  const round = openRound(tx, item.id, 'changes', 'test');
  queueImplement(tx, item.id, round.round, { agent: item.agent, sessionId: item.sessionId, purpose: 'changes' });
  ticketPatch(tx, item, { requeue: 'follow-up' });
  stack.workflow.commit(tx);
  return stack.backlog.get(item.id) as ItemRecord;
}

/* ---------- A format-1 state, for the format-2 migration ---------- */

export const LEGACY_T = 1_700_000_000_000;

/** Ticket ids of the legacy fixture, by what they were. */
export const LEGACY = {
  backlog: 'itm_01J0000000000000000000BACK',
  queued: 'itm_01J00000000000000000QUEUED',
  requeued: 'itm_01J000000000000000REQUEUED',
  running: 'itm_01J0000000000000000RUNNING',
  askOrch: 'itm_01J000000000000000ASKORCHE',
  askUser: 'itm_01J000000000000000ASKUSERX',
  review: 'itm_01J00000000000000000REVIEW',
  accepted: 'itm_01J000000000000000ACCEPTED',
  merged: 'itm_01J00000000000000000MERGED',
  failed: 'itm_01J00000000000000000FAILED',
  cancelled: 'itm_01J00000000000000CANCELLED',
} as const;

/**
 * items.json and sessions.json as a format-1 daemon wrote them: one ticket
 * in each of the eight old statuses, a queued one with and one without a
 * session, two done ones (one accepted, one with a merged pull request), a
 * question routed to the orchestrator and one to the user, an active worker
 * session with a queued input, a source issue and an open pull request.
 */
export function legacyState(): { items: Record<string, unknown>; sessions: Record<string, unknown> } {
  let n = 0;
  const base = { branch: 'main', sha: 'a'.repeat(40) };
  const result = (interrupted = false) => ({ summary: 'Did it.', commits: [{ sha: 'c'.repeat(40), subject: 'Do it' }], diffStat: { files: 1, insertions: 2, deletions: 0, text: '' }, uncommitted: [], interrupted, endedAt: LEGACY_T + 50 });
  const rec = (id: string, over: Record<string, unknown>) => {
    n += 1;
    return {
      id,
      number: n,
      title: `Ticket ${n}`,
      body: '',
      status: 'backlog',
      agent: 'implementer',
      repo: 'app',
      createdBy: 'user',
      createdAt: LEGACY_T + n,
      updatedAt: LEGACY_T + 100 + n,
      attempts: 1,
      sessionId: `ses_01J00000000000000000000${String(n).padStart(3, '0')}`,
      branch: `puck/W-${n}`,
      worktree: `/workspace/.puck/worktrees/W-${n}`,
      base,
      result: null,
      pr: null,
      source: null,
      lastError: null,
      cancelReason: null,
      acceptNote: null,
      pendingAsk: null,
      requeue: null,
      pushedSha: null,
      ...over,
    };
  };
  const list = [
    rec(LEGACY.backlog, { status: 'backlog', agent: null, sessionId: null, attempts: 0, branch: null, worktree: null, base: null }),
    rec(LEGACY.queued, { status: 'queued', sessionId: null, attempts: 0, branch: null, worktree: null, base: null }),
    rec(LEGACY.requeued, { status: 'queued', requeue: 'restart' }),
    rec(LEGACY.running, { status: 'running' }),
    rec(LEGACY.askOrch, { status: 'needs-input', pendingAsk: { askId: 'ask_01J0000000000000000000ORCH', routedTo: 'orchestrator' } }),
    rec(LEGACY.askUser, { status: 'needs-input', pendingAsk: { askId: 'ask_01J0000000000000000000USER', routedTo: 'user' } }),
    rec(LEGACY.review, {
      status: 'review',
      result: result(),
      source: { kind: 'github-issue', repo: 'octo/app', number: 12, url: 'https://github.com/octo/app/issues/12', updatedAt: LEGACY_T },
      pr: { number: 40, url: 'https://github.com/octo/app/pull/40', draft: true, lastPushedSha: 'c'.repeat(40), state: 'open' },
    }),
    rec(LEGACY.accepted, { status: 'done', result: result(), acceptNote: 'Accepted by the user.' }),
    rec(LEGACY.merged, { status: 'done', result: result(), pr: { number: 41, url: 'https://github.com/octo/app/pull/41', draft: false, lastPushedSha: 'd'.repeat(40), state: 'merged' } }),
    rec(LEGACY.failed, { status: 'failed', attempts: 3, lastError: 'Tests failed.' }),
    rec(LEGACY.cancelled, { status: 'cancelled', agent: null, sessionId: null, attempts: 0, cancelReason: 'Not needed.' }),
  ];
  const items = { nextNumber: n + 1, order: list.map((i) => i.id), items: Object.fromEntries(list.map((i) => [i.id, i])) };
  const sessions: Record<string, unknown> = {};
  for (const item of list) {
    if (!item.sessionId) continue;
    sessions[item.sessionId] = {
      id: item.sessionId,
      kind: 'worker',
      agent: 'implementer',
      harness: 'claude-code',
      itemId: item.id,
      cwd: item.worktree,
      status: item.status === 'running' || item.status === 'needs-input' ? 'running' : 'idle',
      queue: item.id === LEGACY.running ? [{ text: 'Also update the docs.', author: 'user' }] : [],
      turns: 1,
      lastTurnTokens: 10,
      costUsd: 0,
      createdAt: LEGACY_T,
      lastActiveAt: LEGACY_T + 60,
    };
  }
  sessions.ses_01J0000000000000000000ORCH = { id: 'ses_01J0000000000000000000ORCH', kind: 'orchestrator', agent: 'lead', harness: 'claude-code', cwd: '/workspace', status: 'idle', queue: [], turns: 0, lastTurnTokens: 0, costUsd: 0, createdAt: LEGACY_T, lastActiveAt: LEGACY_T };
  return { items, sessions };
}

/** Write the legacy fixture as a format-1 state directory. */
export function writeLegacyState(stateDir: string): ReturnType<typeof legacyState> {
  const state = legacyState();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'meta.json'), JSON.stringify({ formatVersion: 1, daemonVersion: '0.0.9', createdAt: LEGACY_T }));
  fs.writeFileSync(path.join(stateDir, 'items.json'), JSON.stringify(state.items));
  fs.writeFileSync(path.join(stateDir, 'sessions.json'), JSON.stringify(state.sessions));
  return state;
}
