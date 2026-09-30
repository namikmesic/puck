import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandRunner, RunOptions, RunResult } from '../../src/daemon/exec';
import { daemonPaths, type DaemonPaths } from '../../src/daemon/paths';
import type { DaemonEvent, ItemStatusV1, Reference } from '../../src/harness/daemon-protocol';
import { statusV1 } from '../../src/harness/workflow';
import { openJournal, Ledger, type Journal, type JournalIO } from '../../src/daemon/delivery/journal';
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
  Workflow,
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
}

/** Items, tables, the journal and the ledger over a state directory, as the daemon builds them. */
export function deliveryStack(dir: string, opts: { now?: () => number; io?: JournalIO; emit?(ev: DaemonEvent): void; hooks?: ConstructorParameters<typeof Ledger>[0]['hooks'] } = {}): Stack {
  const now = opts.now ?? Date.now;
  const items = itemsStore(dir);
  const tables = deliveryStore(dir);
  const { journal } = openJournal(path.join(dir, 'delivery', 'journal.ndjson'), { io: opts.io });
  const events: DaemonEvent[] = [];
  const pub = (item: ItemRecord) => publicItem(item, tables.get().workflows[item.id] ?? null);
  const ledger = new Ledger({
    journal,
    items,
    tables,
    emit: (ev) => {
      events.push(ev);
      opts.emit?.(ev);
    },
    publicItem: pub,
    log: nullLogger,
    hooks: opts.hooks,
  });
  const workflow = new Workflow({ ledger, items, tables, now });
  return { dir, items, tables, journal, ledger, workflow, backlog: new Backlog({ store: items, now }), events, pub };
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
