/**
 * Tickets' workflows in the daemon: rounds and steps, moved through the
 * closed step table in `src/harness/workflow.ts`, and every change to a
 * ticket written to the delivery journal first.
 *
 * A transaction (`Tx`) is one operation's events. While an operation
 * builds it, the Tx keeps a working copy of every ticket and workflow it
 * touches, applied through the same reducer as the live stores
 * (`delivery/derive.ts`), so later steps of the operation read what the
 * earlier ones changed. `Workflow.commit` then adds the stage (and the
 * workflow id) of every ticket the transaction touched, journals it, and
 * applies it to the live stores (`Ledger.commit`). Nothing is applied when
 * the journal refuses the write.
 *
 * Without a delivery block (every environment in this version) a round has
 * an implement step and then a manual merge step, which waits for the
 * user's Accept or for GitHub to report the pull request merged. Rounds
 * are unlimited: a message to a finished worker opens a `changes` round and
 * supersedes the waiting merge step (`openRound`).
 */

import type { DaemonEvent, ImplementPurpose, RoundInfo, Step, StepResult, StepState, TicketAsk, WorkItem, WorkflowSummary } from '../harness/daemon-protocol';
import { nextTicket, type TicketState, type TicketTrigger } from '../harness/item-transitions';
import { newId } from '../harness/ulid';
import { deliveryPull } from '../harness/references';
import { createStep, latestAttempts, latestRound, legacyIds, mapLegacy, moveStep, readyState, roundSteps, stageOf, summarize, type StepTrigger } from '../harness/workflow';
import { applyItemEvent, applyTableEvent, emptyDelta, PIPELINE, type ItemsDelta, type JournalActor, type LedgerEvent, type TicketChange } from './delivery/derive';
import { Ledger, openJournal, type Journal, type JournalIO, type LedgerDeps, type Transaction } from './delivery/journal';
import { rollForward } from './delivery/derive';
import type { Logger } from './log';
import { emptyTables, mergeKey, type TablesFile, type WorkflowRecord } from './store/delivery';
import type { ItemRecord, ItemsFile } from './store/items';
import type { JsonStore } from './store/store';

function itemIdOf(ev: LedgerEvent): string | null {
  if (ev.kind === 'ticket.created') return ev.item.id;
  if (ev.kind === 'journal.bootstrap') return null;
  return ev.itemId;
}

/** One operation's events, with a working copy of what they touch. */
export class Tx {
  readonly events: LedgerEvent[] = [];
  readonly delta: ItemsDelta = emptyDelta();
  /** Tickets whose steps or rounds changed. */
  readonly workflowsTouched = new Set<string>();
  private readonly items: ItemsFile;
  private readonly tables: TablesFile;
  private readonly gone = new Set<string>();

  constructor(
    readonly op: string,
    readonly at: number,
    private readonly real: { items: ItemsFile; tables: TablesFile },
  ) {
    this.items = {
      nextNumber: real.items.nextNumber,
      order: real.items.order.slice(),
      items: Object.create(null) as ItemsFile['items'],
      journalSeq: real.items.journalSeq,
    };
    this.tables = {
      ...emptyTables(),
      journalSeq: real.tables.journalSeq,
      merges: Object.create(real.tables.merges) as TablesFile['merges'],
      bootstrap: real.tables.bootstrap,
    };
  }

  private touch(itemId: string): void {
    if (this.gone.has(itemId)) return;
    const { items, tables } = this.real;
    if (!(itemId in this.items.items) && items.items[itemId]) this.items.items[itemId] = structuredClone(items.items[itemId]);
    if (!(itemId in this.tables.workflows) && tables.workflows[itemId]) this.tables.workflows[itemId] = structuredClone(tables.workflows[itemId]);
    if (!(itemId in this.tables.tickets) && tables.tickets[itemId]) this.tables.tickets[itemId] = structuredClone(tables.tickets[itemId]);
  }

  push(ev: LedgerEvent): void {
    const itemId = itemIdOf(ev);
    if (itemId) {
      if (ev.kind === 'ticket.created') this.gone.delete(itemId);
      this.touch(itemId);
    }
    applyItemEvent(this.items, ev, this.at, this.delta);
    applyTableEvent(this.tables, ev, this.at);
    if (itemId && (ev.kind === 'step.changed' || ev.kind === 'round.opened' || ev.kind === 'round.settled')) this.workflowsTouched.add(itemId);
    if (ev.kind === 'ticket.removed' && itemId) this.gone.add(itemId);
    this.events.push(ev);
  }

  item(itemId: string): ItemRecord | null {
    if (this.gone.has(itemId)) return null;
    return itemId in this.items.items ? this.items.items[itemId] : (this.real.items.items[itemId] ?? null);
  }

  workflow(itemId: string): WorkflowRecord | null {
    return itemId in this.tables.workflows ? this.tables.workflows[itemId] : (this.real.tables.workflows[itemId] ?? null);
  }

  steps(itemId: string): Step[] {
    return this.workflow(itemId)?.steps ?? [];
  }

  order(): string[] {
    return this.items.order;
  }

  nextNumber(): number {
    return this.items.nextNumber;
  }

  mergeRecorded(repo: string, number: number): boolean {
    return mergeKey(repo, number) in this.tables.merges;
  }

  hasTicketFacts(itemId: string): boolean {
    return itemId in this.tables.tickets || itemId in this.real.tables.tickets;
  }
}

export interface WorkflowDeps {
  ledger: Ledger;
  items: JsonStore<ItemsFile>;
  tables: JsonStore<TablesFile>;
  now: () => number;
}

export class Workflow {
  constructor(private readonly deps: WorkflowDeps) {}

  begin(op: string): Tx {
    return new Tx(op, this.deps.now(), { items: this.deps.items.get(), tables: this.deps.tables.get() });
  }

  /** Journal the transaction and apply it; a transaction with no events writes nothing. */
  commit(tx: Tx): ItemsDelta {
    finalize(tx);
    if (!tx.events.length) return tx.delta;
    return this.deps.ledger.commit(tx.op, tx.events, tx.at).delta;
  }

  /** True once a failed journal write could not be undone: every mutation is refused. */
  failing(): boolean {
    return this.deps.ledger.failing();
  }

  workflow(itemId: string): WorkflowRecord | null {
    return this.deps.tables.get().workflows[itemId] ?? null;
  }

  steps(itemId: string): Step[] {
    return this.workflow(itemId)?.steps ?? [];
  }

  step(itemId: string, stepId: string): Step | null {
    return this.steps(itemId).find((s) => s.id === stepId) ?? null;
  }

  /** The ticket's implement step that is not done, if any (one lane per ticket in this version). */
  activeImplement(itemId: string): Step | null {
    return activeImplementOf(this.steps(itemId));
  }

  mergeRecorded(repo: string, number: number): boolean {
    return mergeKey(repo, number) in this.deps.tables.get().merges;
  }

  summary(item: ItemRecord): WorkflowSummary | null {
    return summaryOf(item, this.workflow(item.id));
  }

  tables(): TablesFile {
    return this.deps.tables.get();
  }
}

/* ---------- Reading ---------- */

export function activeImplementOf(steps: readonly Step[]): Step | null {
  return latestAttempts(steps).find((s) => s.kind === 'implement' && s.state !== 'done') ?? null;
}

export function summaryOf(item: Pick<ItemRecord, 'status'>, wf: WorkflowRecord | null): WorkflowSummary | null {
  if (item.status === 'done' || !wf) return null;
  return summarize(wf.rounds, wf.steps, { roundsAllowed: wf.roundsAllowed });
}

/** The protocol shape: daemon-only fields dropped, the bounded workflow summary added. */
export function publicItem(item: ItemRecord, wf: WorkflowRecord | null): WorkItem {
  const { requeue: _r, pushedSha: _p, legacyStatus: _l, workflowId: _w, asks: _a, recordFormat: _f, ...rest } = item;
  void _r;
  void _p;
  void _l;
  void _w;
  void _a;
  void _f;
  return { ...rest, workflow: summaryOf(item, wf) };
}

/** True when some implement step of the ticket has ever started. */
export function everStarted(item: Pick<ItemRecord, 'sessionId'>, steps: readonly Step[]): boolean {
  return !!item.sessionId || steps.some((s) => s.kind === 'implement' && s.startedAt !== null);
}

export function openRoundOf(tx: Tx, itemId: string): RoundInfo | null {
  const round = latestRound(tx.workflow(itemId)?.rounds ?? []);
  return round && round.outcome === 'open' ? round : null;
}

/* ---------- Tickets ---------- */

/** Apply a ticket transition (throws ItemStateError when the ticket table refuses it). */
export function ticketStatus(
  tx: Tx,
  item: ItemRecord,
  trigger: TicketTrigger,
  opts: { change?: TicketChange; by: JournalActor; reason?: string | null; started?: boolean },
): TicketState {
  const from: TicketState = { status: item.status, outcome: item.outcome };
  const to = nextTicket(from, trigger, opts.started ?? false);
  if (to === 'removed') throw new Error('Deleting goes through ticketRemove.');
  const change: TicketChange = { ...opts.change };
  if (to.status !== 'in-progress') change.stage = null;
  tx.push({
    kind: 'ticket.status',
    itemId: item.id,
    number: item.number,
    title: change.title ?? item.title,
    agent: change.agent !== undefined ? change.agent : item.agent,
    from,
    to,
    closedAt: to.status !== 'done' ? null : from.status === 'done' ? item.closedAt : tx.at,
    trigger,
    change,
    by: opts.by,
    reason: opts.reason ?? null,
  });
  return to;
}

export function ticketPatch(tx: Tx, item: Pick<ItemRecord, 'id'>, change: TicketChange, position?: number): void {
  tx.push({ kind: 'ticket.patch', itemId: item.id, change, ...(position !== undefined ? { position } : {}) });
}

/** The public ask fields that derive from a ticket's open asks. */
export function askFields(asks: TicketAsk[]): Pick<ItemRecord, 'asks' | 'needsInput' | 'oldestUserAsk' | 'openAsks' | 'userAsks'> {
  const sorted = [...asks].sort((a, b) => a.since - b.since);
  const user = sorted.find((a) => a.routedTo === 'user') ?? null;
  return {
    asks: sorted,
    needsInput: sorted[0] ?? null,
    oldestUserAsk: user ? { askId: user.askId, kind: user.kind, roundId: user.roundId, stepId: user.stepId, since: user.since } : null,
    openAsks: sorted.length,
    userAsks: sorted.filter((a) => a.routedTo === 'user').length,
  };
}

/* ---------- Steps and rounds ---------- */

type StepPatch = Partial<Omit<Step, 'id' | 'kind' | 'state' | 'result' | 'logicalId'>>;

function pushStep(tx: Tx, itemId: string, step: Step, from: StepState | null, trigger: string): Step {
  tx.push({ kind: 'step.changed', itemId, step, from, trigger });
  return step;
}

/** Move a step through the step table (throws StepStateError when it refuses). */
export function stepMove(
  tx: Tx,
  itemId: string,
  step: Step,
  trigger: StepTrigger,
  to: StepState,
  opts: { result?: StepResult | null; patch?: StepPatch } = {},
): Step {
  return pushStep(tx, itemId, moveStep(step, trigger, to, tx.at, opts), step.state, trigger);
}

/** Change a step's fields without moving it (its session, its detail). */
export function stepUpdate(tx: Tx, itemId: string, step: Step, patch: Partial<Pick<Step, 'sessionId' | 'agent' | 'detail' | 'work'>>): Step {
  return pushStep(tx, itemId, { ...step, ...patch }, step.state, 'update');
}

/** A new step, pending. */
export function stepCreate(
  tx: Tx,
  itemId: string,
  init: { kind: Step['kind']; round: number; agent?: string | null; sessionId?: string | null; purpose?: ImplementPurpose | null; retryOf?: Step | null; detail?: string },
): Step {
  return pushStep(tx, itemId, createStep({ id: newId('stp', tx.at), at: tx.at, ...init }), null, 'create');
}

/** A new implement step, queued for a slot: created, then ready. */
export function queueImplement(
  tx: Tx,
  itemId: string,
  round: number,
  init: { agent: string | null; sessionId: string | null; purpose: ImplementPurpose; retryOf?: Step | null },
): Step {
  const step = stepCreate(tx, itemId, { kind: 'implement', round, ...init });
  return stepMove(tx, itemId, step, 'ready', 'queued');
}

/** Without delivery: the round's merge step, waiting for the user's Accept or a merge on GitHub. */
export function addManualMerge(tx: Tx, itemId: string, round: number): Step {
  const step = stepCreate(tx, itemId, { kind: 'merge', round });
  return stepMove(tx, itemId, step, 'ready', readyState('merge', { manual: true }));
}

/** Round 1, for a ticket that gets its first implement step: the decompose step is recorded as skipped (assigned directly). */
export function openFirstRound(tx: Tx, itemId: string, reason: string): RoundInfo {
  const round = openRoundRecord(tx, itemId, 1, 'task', reason);
  const decompose = stepCreate(tx, itemId, { kind: 'decompose', round: 1 });
  stepMove(tx, itemId, decompose, 'skip', 'done', { result: 'skipped' });
  return round;
}

function openRoundRecord(tx: Tx, itemId: string, round: number, purpose: ImplementPurpose, reason: string): RoundInfo {
  const roundId = newId('rnd', tx.at);
  tx.push({ kind: 'round.opened', itemId, roundId, round, purpose, reason });
  const opened = tx.workflow(itemId)?.rounds.find((r) => r.roundId === roundId);
  if (!opened) throw new Error('round.opened did not open the round');
  return opened;
}

/** Settle the ticket's open round: every step of it is done, or it was superseded or cancelled. */
export function settleRound(tx: Tx, itemId: string, outcome: 'settled' | 'superseded' | 'cancelled'): void {
  const round = openRoundOf(tx, itemId);
  if (!round) return;
  tx.push({ kind: 'round.settled', itemId, roundId: round.roundId, round: round.round, gate: round.gate, outcome, obligations: [] });
}

/**
 * The only way to open a round after the first (7.6). Without delivery the
 * budget is unlimited. Every step of the current round that is not done
 * ends superseded (a waiting merge step, and in later phases publish and
 * CI); the round settles, and the new one opens.
 */
export function openRound(tx: Tx, itemId: string, purpose: ImplementPurpose, reason: string): RoundInfo {
  const wf = tx.workflow(itemId);
  const current = latestRound(wf?.rounds ?? []);
  if (!current) return openRoundRecord(tx, itemId, 1, purpose, reason);
  let superseded = false;
  for (const step of roundSteps(wf?.steps ?? [], current.round)) {
    if (step.state === 'done') continue;
    if (step.kind !== 'publish' && step.kind !== 'ci' && step.kind !== 'merge') superseded = true;
    stepMove(tx, itemId, step, 'supersede', 'done', { result: 'superseded' });
  }
  if (current.outcome === 'open') settleRound(tx, itemId, superseded ? 'superseded' : 'settled');
  return openRoundRecord(tx, itemId, current.round + 1, purpose, reason);
}

/**
 * End every step of the ticket that is not done, as the ticket leaves In
 * progress: a waiting merge step finishes `passed` when the work is
 * accepted or merged (it waited for exactly that); anything else ends
 * cancelled. The open round settles.
 */
export function endSteps(tx: Tx, itemId: string, how: 'cancel' | 'accept' | 'merged' | 'fail'): void {
  for (const step of latestAttempts(tx.steps(itemId))) {
    if (step.state === 'done') continue;
    if (step.kind === 'merge' && step.state === 'waiting' && (how === 'accept' || how === 'merged')) {
      stepMove(tx, itemId, step, 'finish', 'done', { result: 'passed', patch: { detail: how === 'merged' ? 'Merged on GitHub' : 'Accepted' } });
    } else {
      stepMove(tx, itemId, step, 'cancel', 'done', { result: 'cancelled' });
    }
  }
  settleRound(tx, itemId, how === 'cancel' ? 'cancelled' : 'settled');
}

/** Before journaling: every touched ticket's stage (and its workflow id) follows its steps. */
export function finalize(tx: Tx): void {
  for (const itemId of new Set([...tx.delta.changed, ...tx.workflowsTouched])) {
    const item = tx.item(itemId);
    if (!item) continue;
    const wf = tx.workflow(itemId);
    const change: TicketChange = {};
    const stage = stageOf(item.status, wf?.steps ?? []);
    if (item.stage !== stage) change.stage = stage;
    if (wf && wf.rounds.length && item.workflowId !== wf.id) change.workflowId = wf.id;
    if (Object.keys(change).length) ticketPatch(tx, item, change);
  }
}

/* ---------- Boot ---------- */

export interface DeliveryBoot {
  journal: Journal;
  ledger: Ledger;
  workflow: Workflow;
  /** Every committed transaction, as boot read it (for the input re-queue). */
  transactions: Transaction[];
  /** Transactions each checkpoint had to roll forward over. */
  rolled: { items: number; tables: number };
  tornBytes: number;
}

/**
 * Boot recovery, steps 1 to 3 (6.6): open the journal (repairing a torn
 * tail; a damaged one throws JournalDamagedError), roll items.json and
 * delivery/tables.json forward over every transaction they do not hold,
 * commit both, and build the write path over them.
 */
export function bootDelivery(opts: {
  file: string;
  items: JsonStore<ItemsFile>;
  tables: JsonStore<TablesFile>;
  emit(ev: DaemonEvent): void;
  log: Logger;
  now: () => number;
  io?: JournalIO;
  hooks?: LedgerDeps['hooks'];
}): DeliveryBoot {
  const opened = openJournal(opts.file, { io: opts.io, log: opts.log });
  const rolled = rollForward(opts.items.get(), opts.tables.get(), opened.transactions);
  if (rolled.items) opts.items.commit();
  if (rolled.tables) opts.tables.commit();
  if (rolled.items || rolled.tables) opts.log.info('journal.rolled-forward', rolled);
  const ledger = new Ledger({
    journal: opened.journal,
    items: opts.items,
    tables: opts.tables,
    emit: opts.emit,
    publicItem: (item) => publicItem(item, opts.tables.get().workflows[item.id] ?? null),
    log: opts.log,
    hooks: opts.hooks,
  });
  const workflow = new Workflow({ ledger, items: opts.items, tables: opts.tables, now: opts.now });
  return { journal: opened.journal, ledger, workflow, transactions: opened.transactions, rolled, tornBytes: opened.tornBytes };
}

/* ---------- The format-2 bootstrap ---------- */

/**
 * After the format-2 migration and before the daemon serves anything:
 * journal every ticket that has no `ticket.created` yet with its legacy
 * workflow (12.1), one transaction per ticket, then `journal.bootstrap`.
 * Steps are synthesized only from the old status (`mapLegacy`): no checks
 * or review step is ever made up, so no old ticket appears to have passed
 * a panel. A crash midway resumes: tickets already journaled are skipped.
 * Returns the tickets journaled now.
 */
export function bootstrapLegacy(wf: Workflow, items: readonly ItemRecord[], nextNumber: number, hooks: { afterTicket?(itemId: string): void } = {}): number {
  if (wf.tables().bootstrap) return 0;
  let journaled = 0;
  items.forEach((item, index) => {
    const tx = wf.begin('journal.bootstrap');
    if (tx.hasTicketFacts(item.id)) return;
    tx.push({ kind: 'ticket.created', item: structuredClone(item), position: index, nextNumber, legacy: true });
    const legacy = item.legacyStatus;
    const mapping = legacy
      ? mapLegacy({ status: legacy, sessionId: item.sessionId, prState: deliveryPull(item)?.state, interrupted: !!item.result?.interrupted })
      : null;
    const ids = legacyIds(item.id);
    if (mapping?.implement) {
      tx.push({ kind: 'round.opened', itemId: item.id, roundId: ids.roundId, round: 1, purpose: 'task', reason: 'legacy' });
      const done = mapping.implement.state === 'done';
      const implement: Step = {
        ...createStep({ id: ids.implementId, kind: 'implement', round: 1, at: tx.at, agent: item.agent, sessionId: item.sessionId, purpose: 'task' }),
        state: mapping.implement.state,
        result: mapping.implement.result,
        attempt: Math.max(1, item.attempts),
        queuedAt: item.createdAt,
        startedAt: item.sessionId ? item.createdAt : null,
        finishedAt: done ? (item.result?.endedAt ?? item.updatedAt) : null,
        detail: mapping.implement.result === 'cancelled' && legacy === 'review' ? 'Stopped by the user' : '',
        legacy: true,
      };
      tx.push({ kind: 'step.changed', itemId: item.id, step: implement, from: null, trigger: 'legacy' });
      if (mapping.merge) {
        const merge: Step = {
          ...createStep({ id: ids.mergeId, kind: 'merge', round: 1, at: tx.at }),
          state: mapping.merge.state,
          queuedAt: item.updatedAt,
          legacy: true,
        };
        tx.push({ kind: 'step.changed', itemId: item.id, step: merge, from: null, trigger: 'legacy' });
      }
    }
    if (item.status === 'done' && item.outcome) {
      const trigger = item.outcome === 'merged' ? 'merged' : item.outcome === 'accepted' ? 'accept' : item.outcome === 'failed' ? 'fail' : 'cancel';
      tx.push({
        kind: 'ticket.status',
        itemId: item.id,
        number: item.number,
        title: item.title,
        agent: item.agent,
        from: { status: 'in-progress', outcome: null },
        to: { status: 'done', outcome: item.outcome },
        closedAt: item.closedAt,
        trigger,
        change: {},
        by: PIPELINE,
        reason: 'legacy',
        legacy: true,
      });
      if (mapping?.implement) settleRound(tx, item.id, item.outcome === 'cancelled' ? 'cancelled' : 'settled');
    }
    wf.commit(tx);
    journaled += 1;
    hooks.afterTicket?.(item.id);
  });
  // The marker counts every ticket the bootstrap journaled, across a crash and its resumption.
  const tx = wf.begin('journal.bootstrap');
  tx.push({ kind: 'journal.bootstrap', format: 2, tickets: items.length });
  wf.commit(tx);
  return journaled;
}
