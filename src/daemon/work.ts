/**
 * Tickets end to end: the operations clients and the orchestrator's tools
 * share (create, edit, reorder, assign, cancel, retry, accept, follow up,
 * link, delete), dispatch of implement steps into a worktree and worker
 * session, result capture at every worker turn end, worker questions, and
 * merges observed on GitHub.
 *
 * Every change is one journal transaction (`src/daemon/workflow.ts`): a
 * ticket's transition through the ticket table
 * (`src/harness/item-transitions.ts`) and every step change it causes
 * (`src/harness/workflow.ts`) land together, before any side effect. The
 * scheduler picks which queued implement step starts; this module starts it.
 *
 * Without a delivery block, an implement step that ends cleanly (or that
 * the user stopped) leaves a manual merge step waiting: the ticket stays
 * In progress until the user accepts it or its pull request merges on
 * GitHub, and a message to its worker opens a new `changes` round.
 *
 * Attempts. `attempts` counts the dispatches of the current request: the
 * first dispatch and each dispatch after an error add one, and an error
 * with `attempts >= maxAttempts` fails the ticket. A follow-up or a retry is
 * a new request and starts again at one. A daemon restart is not a failed
 * attempt: the implement step goes back to `queued` without a count, and
 * its next dispatch resumes the SAME worker session (the harness's saved
 * conversation) with a short continue message, so nothing starts over.
 * A worker session that never received its prompt (the restart came
 * between creating it and queueing the prompt) gets the full worker prompt.
 */

import type { AskQuestion } from '../harness/types';
import type { GithubIssueReference, GithubPullReference, ItemPosition, MergeObserved, Reference, Step, TicketAsk, WorkItem } from '../harness/daemon-protocol';
import type { DaemonDefinition, DaemonRepo } from '../harness/env-definition';
import { allows, ticketPhrase } from '../harness/item-transitions';
import { deliveryPull, hasRoom, parseReference, referenceLabel, sameTarget } from '../harness/references';
import { newId } from '../harness/ulid';
import { latestAttempts, roundSteps, stepHoldsSlot, StepStateError } from '../harness/workflow';
import type { EntryAuthor, NoticeKind, TranscriptEntry, TurnEntry } from '../harness/transcript';
import { actor, PIPELINE, type JournalActor } from './delivery/derive';
import { JournalError } from './delivery/journal';
import { capBytes, type Git, GitError, itemBranch, RESULT_LIMITS } from './git';
import { type Backlog, itemLabel, ItemStateError } from './items';
import type { Logger } from './log';
import { continuePrompt, RESTART_REASON, workerPrompt } from './prompts';
import { PublishError, type Publisher, type PublishRequest } from './publish';
import type { ItemRecord } from './store/items';
import type { SessionRecord } from './store/sessions';
import { type TurnOutcome, type Turns, TurnsError } from './turns';
import {
  activeImplementOf,
  addManualMerge,
  askFields,
  endSteps,
  everStarted,
  openFirstRound,
  openRound,
  openRoundOf,
  queueImplement,
  stepMove,
  stepUpdate,
  ticketPatch,
  ticketStatus,
  type Tx,
  type Workflow,
} from './workflow';

export type Actor = 'user' | 'orchestrator';

/** A client-facing failure (`not-found`, `invalid-args`, `invalid-state`). */
export class WorkError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid-args' | 'invalid-state',
    message: string,
  ) {
    super(message);
  }
}

export interface WorkDeps {
  backlog: Backlog;
  workflow: Workflow;
  turns: Turns;
  git: Git;
  publisher: Publisher;
  definition(): DaemonDefinition | null;
  notify(kind: NoticeKind, text: string, itemId?: string): void;
  /** Slots may have changed: emit capacity and let the scheduler look. */
  slotsChanged(): void;
  /** New or changed queued work: let the scheduler look. */
  requestTick(): void;
  /** True while a definition reprovision is pending or running. */
  reprovisioning(): boolean;
  /** For an item from a GitHub issue: the worker prompt's issue section, read at first dispatch. */
  issueContext?(item: ItemRecord): Promise<string | null>;
  /** After a publish: the GitHub workflow watches the new head. */
  published?(itemId: string): Promise<void>;
  log: Logger;
  now?: () => number;
}

/** The last top-level assistant text of a turn: its text after the last tool call. */
export function lastAssistantText(entry: TurnEntry | null): string {
  if (!entry) return '';
  let text = '';
  for (const event of entry.events) {
    if (event.kind === 'tool-start' && !event.parentId) text = '';
    else if (event.kind === 'text-delta' && !event.parentId) text += event.text;
  }
  return capBytes(text.trim(), RESULT_LIMITS.summaryBytes);
}

function describeChanges(item: WorkItem | ItemRecord): string {
  const r = item.result;
  if (!r) return 'no result';
  const commits = `${r.commits.length} commit${r.commits.length === 1 ? '' : 's'}`;
  const files = `${r.diffStat.files} file${r.diffStat.files === 1 ? '' : 's'} changed (+${r.diffStat.insertions} −${r.diffStat.deletions})`;
  return `${commits}, ${files}`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function by(who: Actor | 'pipeline'): JournalActor {
  return who === 'pipeline' ? PIPELINE : actor(who);
}

/** The issue rule counts a ticket as open until it is accepted, merged or cancelled (a failed one can be retried). */
export function closedForIssue(item: Pick<ItemRecord, 'status' | 'outcome'>): boolean {
  return item.status === 'done' && item.outcome !== 'failed';
}

type ResultOf = NonNullable<ItemRecord['result']>;

export class Work {
  private readonly now: () => number;
  private readonly gates = new Map<string, Promise<unknown>>();
  private readonly holds = new Map<string, number>();
  private readonly prepares = new Set<Promise<void>>();

  constructor(private readonly deps: WorkDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Resolves once every in-flight worktree prepare has finished. */
  async idlePrepares(): Promise<void> {
    while (this.prepares.size) await Promise.allSettled([...this.prepares]);
  }

  private busy(itemId: string): boolean {
    return this.holds.has(itemId);
  }

  private exclusive<T>(itemId: string, fn: () => Promise<T> | T): Promise<T> {
    this.holds.set(itemId, (this.holds.get(itemId) ?? 0) + 1);
    const prev = this.gates.get(itemId) ?? Promise.resolve();
    const run = prev.then(() => fn());
    const release = (): void => {
      const left = (this.holds.get(itemId) ?? 1) - 1;
      if (left <= 0) this.holds.delete(itemId);
      else this.holds.set(itemId, left);
      this.deps.requestTick();
    };
    this.gates.set(
      itemId,
      run.then(
        () => release(),
        () => release(),
      ),
    );
    return run;
  }

  private trackPrepare(work: Promise<void>): Promise<void> {
    this.prepares.add(work);
    return work.finally(() => {
      this.prepares.delete(work);
    });
  }

  /* ---------- Lookups ---------- */

  item(ref: string): ItemRecord {
    const item = this.deps.backlog.find(ref);
    if (!item) throw new WorkError('not-found', `No work item ${ref}.`);
    return item;
  }

  private def(): DaemonDefinition {
    const def = this.deps.definition();
    if (!def) throw new WorkError('invalid-state', 'This environment has no definition yet.');
    return def;
  }

  private checkAgent(def: DaemonDefinition, agent: string): void {
    if (!def.agents.some((a) => a.agent === agent)) {
      throw new WorkError('invalid-args', `"${agent}" is not assigned in this environment (${def.agents.map((a) => a.agent).join(', ')}).`);
    }
  }

  private checkRepo(def: DaemonDefinition, repo: string | null, agent: string | null): void {
    if (repo !== null && !def.repos.some((r) => r.dir === repo)) {
      throw new WorkError('invalid-args', `"${repo}" is not a repository of this environment (${def.repos.map((r) => r.dir).join(', ')}).`);
    }
    if (agent && repo === null && def.repos.length > 1) {
      throw new WorkError('invalid-args', 'This environment has more than one repository: choose the repo before assigning.');
    }
  }

  private repoOf(def: DaemonDefinition, item: ItemRecord): DaemonRepo {
    const dir = item.repo ?? (def.repos.length === 1 ? def.repos[0].dir : null);
    const repo = def.repos.find((r) => r.dir === dir);
    if (!repo) throw new WorkError('invalid-state', `${itemLabel(item)} has no repository.`);
    return repo;
  }

  private label(item: ItemRecord): string {
    return `${itemLabel(item)} "${item.title}"`;
  }

  private phrase(item: ItemRecord): string {
    return ticketPhrase({ status: item.status, outcome: item.outcome });
  }

  /** The ticket's implement step that is not done, if any. */
  activeStep(item: ItemRecord): Step | null {
    return this.deps.workflow.activeImplement(item.id);
  }

  /** True while the ticket's implement step holds a slot (running, or waiting on its worker's question). */
  isRunning(item: ItemRecord): boolean {
    const step = this.activeStep(item);
    return !!step && stepHoldsSlot(step);
  }

  /** True when the journal already holds a merge of this pull request. */
  mergeRecorded(repo: string, number: number): boolean {
    return this.deps.workflow.mergeRecorded(repo, number);
  }

  private begin(op: string): Tx {
    if (this.deps.workflow.failing()) throw new JournalError('not-ready', 'The delivery journal is failing; see the environment log.');
    return this.deps.workflow.begin(op);
  }

  /** Commit a transaction; a refused transition surfaces as `invalid-state`. */
  private commit(tx: Tx): void {
    this.deps.workflow.commit(tx);
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ItemStateError || err instanceof StepStateError) throw new WorkError('invalid-state', err.message);
      throw err;
    }
  }

  /* ---------- Backlog operations ---------- */

  /** The related references a list of links adds (each one validated). */
  private linksFrom(links: readonly string[], existing: Reference[]): Reference[] {
    const out: Reference[] = [];
    for (const text of links) {
      const parsed = parseReference(text);
      if (!parsed || parsed.kind === 'ticket') throw new WorkError('invalid-args', `Puck cannot read "${oneLine(text, 80)}" as a GitHub issue, pull request or https URL.`);
      if ([...existing, ...out].some((r) => r.role === 'related' && sameTarget(r, parsed))) continue;
      if (!hasRoom({ references: [...existing, ...out] }, 'related')) throw new WorkError('invalid-args', 'A ticket has at most 20 related links.');
      out.push({ ...parsed, id: newId('ref', this.now()), role: 'related' } as Reference);
    }
    return out;
  }

  create(
    init: {
      title: string;
      body?: string;
      agent?: string | null;
      repo?: string | null;
      position?: ItemPosition;
      source?: Omit<GithubIssueReference, 'id' | 'role'> | null;
      links?: string[];
    },
    who: Actor,
    opts: { silent?: boolean } = {},
  ): ItemRecord {
    const def = this.def();
    const agent = init.agent ?? null;
    const repo = init.repo ?? null;
    if (agent) this.checkAgent(def, agent);
    this.checkRepo(def, repo, agent);
    const references: Reference[] = [];
    if (init.source) {
      // One open ticket per issue.
      const open = this.deps.backlog.byIssue(init.source.repo, init.source.number).find((i) => !closedForIssue(i));
      if (open) throw new WorkError('invalid-state', `Issue ${init.source.repo}#${init.source.number} is already ${itemLabel(open)} (${this.phrase(open)}).`);
      references.push({ ...init.source, id: newId('ref', this.now()), role: 'source' });
    }
    references.push(...this.linksFrom(init.links ?? [], references));
    const item = this.guard(() => {
      const tx = this.begin('item.create');
      const made = this.deps.backlog.create(tx, {
        title: init.title.trim(),
        body: init.body ?? '',
        agent,
        repo,
        createdBy: who,
        position: init.position,
        references,
      });
      if (agent) {
        openFirstRound(tx, made.id, 'assigned');
        queueImplement(tx, made.id, 1, { agent, sessionId: null, purpose: 'task' });
      }
      this.commit(tx);
      return this.item(made.id);
    });
    if (who === 'user' && !opts.silent) {
      this.deps.notify('item.created', `The user created ${this.label(item)}${agent ? `, assigned to ${agent}` : ' in the backlog'}.`, item.id);
    }
    this.deps.requestTick();
    return item;
  }

  update(ref: string, change: { title?: string; body?: string; repo?: string }, who: Actor): ItemRecord {
    const item = this.item(ref);
    if (this.isRunning(item)) throw new WorkError('invalid-state', `${itemLabel(item)} is running; edit it once it stops.`);
    const def = this.def();
    if (change.repo !== undefined && change.repo !== item.repo) {
      if (item.worktree) throw new WorkError('invalid-state', `${itemLabel(item)} already has a worktree in ${item.repo ?? 'its repository'}.`);
      this.checkRepo(def, change.repo, null);
    }
    const patch: Partial<ItemRecord> = {};
    if (change.title !== undefined) patch.title = change.title.trim();
    if (change.body !== undefined) patch.body = change.body;
    if (change.repo !== undefined) patch.repo = change.repo;
    const tx = this.begin('item.update');
    ticketPatch(tx, item, patch);
    this.commit(tx);
    if (who === 'user') this.deps.notify('item.updated', `The user edited ${this.label(item)}.`, item.id);
    return item;
  }

  move(ref: string, position: ItemPosition): string[] {
    const item = this.item(ref);
    this.guard(() => {
      const tx = this.begin('item.move');
      this.deps.backlog.move(tx, item, position);
      this.commit(tx);
    });
    this.deps.requestTick();
    return this.deps.backlog.order();
  }

  /** Assign or unassign a Todo ticket: its queued implement step changes, never its status. */
  assign(ref: string, agent: string | null, who: Actor): ItemRecord {
    const item = this.item(ref);
    const def = this.def();
    if (item.status !== 'todo') throw new WorkError('invalid-state', `${itemLabel(item)} is ${this.phrase(item)}; only a ticket in Todo is assigned.`);
    this.guard(() => {
      const tx = this.begin('item.assign');
      const active = activeImplementOf(tx.steps(item.id));
      if (agent === null) {
        if (!item.agent && !active) throw new ItemStateError(`${itemLabel(item)} is not assigned.`);
        if (active) stepMove(tx, item.id, active, 'cancel', 'done', { result: 'cancelled', patch: { detail: 'Unassigned' } });
        ticketPatch(tx, item, { agent: null });
      } else {
        this.checkAgent(def, agent);
        this.checkRepo(def, item.repo, agent);
        if (item.sessionId) {
          const owner = item.agent ?? this.deps.turns.get(item.sessionId)?.agent ?? null;
          if (agent !== owner) {
            throw new WorkError('invalid-state', `${itemLabel(item)} already has a ${owner ?? 'worker'} session; it keeps that agent.`);
          }
        }
        if (!active || active.agent !== agent) {
          if (active) stepMove(tx, item.id, active, 'cancel', 'done', { result: 'cancelled', patch: { detail: `Reassigned to ${agent}` } });
          const round = openRoundOf(tx, item.id) ?? (tx.workflow(item.id)?.rounds.length ? openRound(tx, item.id, 'task', 'assigned') : openFirstRound(tx, item.id, 'assigned'));
          const previous = roundSteps(tx.steps(item.id), round.round).find((s) => s.kind === 'implement') ?? null;
          queueImplement(tx, item.id, round.round, { agent, sessionId: item.sessionId, purpose: 'task', retryOf: previous });
        }
        ticketPatch(tx, item, { agent });
      }
      this.commit(tx);
    });
    if (who === 'user') {
      this.deps.notify(
        'item.updated',
        agent ? `The user assigned ${this.label(item)} to ${agent}.` : `The user moved ${this.label(item)} back to the backlog.`,
        item.id,
      );
    }
    this.deps.requestTick();
    return item;
  }

  cancel(ref: string, who: Actor, reason?: string): ItemRecord {
    const item = this.item(ref);
    const held = this.isRunning(item);
    const cancelReason = reason?.trim() ? reason.trim() : null;
    this.guard(() => {
      const tx = this.begin('item.cancel');
      ticketStatus(tx, item, 'cancel', {
        change: { ...askFields([]), requeue: null, ...(cancelReason ? { cancelReason } : {}) },
        by: by(who),
        reason: cancelReason,
      });
      endSteps(tx, item.id, 'cancel');
      this.commit(tx);
    });
    if (item.sessionId) {
      this.deps.turns.clearQueue(item.sessionId);
      this.deps.turns.interrupt(item.sessionId, 'user');
    }
    if (who === 'user') this.deps.notify('item.updated', `The user cancelled ${this.label(item)}.`, item.id);
    this.deps.log.info('item.cancel', { itemId: item.id, actor: who });
    if (held) this.deps.slotsChanged();
    return item;
  }

  /**
   * A failed or cancelled ticket again: a new round with a queued implement
   * step. A ticket that had started keeps its session and worktree and goes
   * back to In progress; one that never started goes back to Todo.
   */
  retry(ref: string, who: Actor = 'user'): ItemRecord {
    const item = this.item(ref);
    // A ticket unassigned before it was cancelled keeps its session but no
    // agent; the session's owner takes it back so the scheduler can dispatch
    // it (an owner no longer assigned in the definition just waits there).
    const agent = item.agent ?? (item.sessionId ? (this.deps.turns.get(item.sessionId)?.agent ?? null) : null);
    this.guard(() => {
      const tx = this.begin('item.retry');
      const started = everStarted(item, tx.steps(item.id));
      ticketStatus(tx, item, 'retry', {
        change: { attempts: 0, agent, requeue: item.sessionId ? 'retry' : null, ...askFields([]) },
        by: by(who),
        started,
      });
      if (agent) {
        const round = tx.workflow(item.id)?.rounds.length ? openRound(tx, item.id, 'task', 'retry') : openFirstRound(tx, item.id, 'retry');
        queueImplement(tx, item.id, round.round, { agent, sessionId: item.sessionId, purpose: 'task' });
      }
      this.commit(tx);
    });
    this.deps.requestTick();
    return item;
  }

  /** Accept a ticket as finished: Done (accepted). Without delivery it needs no reason. */
  accept(ref: string, note?: string, who: Actor = 'user', reason?: string): ItemRecord {
    const item = this.item(ref);
    const acceptNote = note?.trim() ? note.trim() : null;
    const held = this.isRunning(item);
    const sessionId = item.sessionId;
    const stop = !!sessionId && !!this.activeStep(item);
    this.guard(() => {
      const tx = this.begin('item.accept');
      ticketStatus(tx, item, 'accept', {
        change: { lastError: null, requeue: null, ...askFields([]), ...(acceptNote ? { acceptNote } : {}) },
        by: by(who),
        reason: reason?.trim() || null,
      });
      endSteps(tx, item.id, 'accept');
      this.commit(tx);
    });
    if (stop && sessionId) {
      this.deps.turns.clearQueue(sessionId);
      this.deps.turns.interrupt(sessionId, 'user');
    }
    if (held) this.deps.slotsChanged();
    return item;
  }

  /**
   * GitHub reports the ticket's delivery pull request merged and the journal
   * has no merge of it yet: journal `merge.observed` and move the ticket to
   * Done (merged) from any status the ticket table allows, in one
   * transaction. Returns false when the merge was already recorded.
   */
  merged(ref: string, observed: MergeObserved, note: string): boolean {
    const item = this.item(ref);
    if (this.mergeRecorded(observed.repo, observed.prNumber)) return false;
    const held = this.isRunning(item);
    const sessionId = item.sessionId;
    const stop = !!sessionId && !!this.activeStep(item);
    this.guard(() => {
      const tx = this.begin('merge.observed');
      tx.push({ kind: 'merge.observed', ...observed });
      const pr = deliveryPull(item);
      if (pr && pr.number === observed.prNumber) {
        this.deps.backlog.reference(tx, item, 'update', { ...pr, state: 'merged', mergeCommitSha: observed.mergeCommitSha });
      }
      if (allows({ status: item.status, outcome: item.outcome }, 'merged')) {
        ticketStatus(tx, item, 'merged', {
          change: { lastError: null, requeue: null, ...askFields([]), ...(item.status === 'done' ? {} : { acceptNote: note }) },
          by: PIPELINE,
          reason: note,
        });
        endSteps(tx, item.id, 'merged');
      }
      this.commit(tx);
    });
    if (stop && sessionId) {
      this.deps.turns.clearQueue(sessionId);
      this.deps.turns.interrupt(sessionId, 'user');
    }
    if (held) this.deps.slotsChanged();
    this.deps.log.info('item.merged', { itemId: item.id, prNumber: observed.prNumber, initiatedBy: observed.initiatedBy });
    return true;
  }

  /**
   * A message for a ticket's worker. While its implement step waits or
   * runs, the text joins the session's queue. Once the step is done and
   * the merge step waits, it opens a `changes` round (7.6: unlimited
   * without delivery) whose implement step continues the same session.
   */
  followUp(ref: string, text: string, author: EntryAuthor): Promise<{ queued: boolean; turnId?: string }> {
    const item = this.item(ref);
    return this.exclusive(item.id, () => {
      if (!item.sessionId) throw new WorkError('invalid-state', `${itemLabel(item)} has not started yet.`);
      const sessionId = item.sessionId;
      const active = this.activeStep(item);
      if (active) {
        const tx = this.begin('item.follow-up');
        tx.push({ kind: 'step.input', itemId: item.id, stepId: active.id, sessionId, author, text, attachment: null });
        this.commit(tx);
        return this.deps.turns.send(sessionId, text, author);
      }
      if (item.status !== 'in-progress') {
        throw new WorkError('invalid-state', `${itemLabel(item)} is ${this.phrase(item)}; retry it or create a new item instead.`);
      }
      this.guard(() => {
        const tx = this.begin('item.follow-up');
        const round = openRound(tx, item.id, 'changes', `A message from the ${author}`);
        const agent = item.agent ?? this.deps.turns.get(sessionId)?.agent ?? null;
        const step = queueImplement(tx, item.id, round.round, { agent, sessionId, purpose: 'changes' });
        ticketPatch(tx, item, { requeue: 'follow-up', agent });
        tx.push({ kind: 'step.input', itemId: item.id, stepId: step.id, sessionId, author, text, attachment: null });
        this.commit(tx);
      });
      // The text is journaled first; it waits in the session until a slot is free.
      const sent = this.deps.turns.send(sessionId, text, author);
      this.deps.requestTick();
      return sent;
    });
  }

  /** Add a `related` link (4.6). A link the ticket already has adds nothing. */
  link(ref: string, text: string): ItemRecord {
    const item = this.item(ref);
    const [added] = this.linksFrom([text], item.references);
    if (added) {
      const tx = this.begin('item.link');
      this.deps.backlog.reference(tx, item, 'add', added);
      this.commit(tx);
    }
    return item;
  }

  /** A synced reference changed on GitHub (the source issue's `updated_at`, the pull request's state and CI). */
  updateReference(ref: string, reference: Reference): void {
    const item = this.item(ref);
    if (!item.references.some((r) => r.id === reference.id)) return;
    const tx = this.begin('item.reference');
    this.deps.backlog.reference(tx, item, 'update', reference);
    this.commit(tx);
  }

  /** Remove a `related` link; the synced ones are not the user's to remove. */
  unlink(ref: string, referenceId: string): ItemRecord {
    const item = this.item(ref);
    const found = item.references.find((r) => r.id === referenceId);
    if (!found) throw new WorkError('not-found', `${itemLabel(item)} has no link ${referenceId}.`);
    if (found.role !== 'related') throw new WorkError('invalid-state', `${referenceLabel(found)} is ${itemLabel(item)}'s ${found.role} link; only related links are removed by hand.`);
    const tx = this.begin('item.unlink');
    this.deps.backlog.reference(tx, item, 'remove', found);
    this.commit(tx);
    return item;
  }

  /** Push the ticket's branch and open or update its pull request. Status does not change. */
  async publish(ref: string, req: PublishRequest, who: Actor): Promise<{ prUrl: string }> {
    const item = this.item(ref);
    return this.exclusive(item.id, async () => {
      if (!this.deps.backlog.get(item.id)) throw new WorkError('not-found', `No work item ${ref}.`);
      if (who === 'orchestrator' && this.def().policies.publish !== 'orchestrator') {
        throw new WorkError('invalid-state', 'Publishing is manual in this environment: the user publishes from the work view.');
      }
      if (item.status === 'todo' || (item.status === 'in-progress' && this.activeStep(item))) {
        throw new WorkError('invalid-state', `${itemLabel(item)} is ${this.phrase(item)}; publish it once its worker finishes.`);
      }
      let published;
      try {
        published = await this.deps.publisher.publish(item, req, (sha) => {
          const tx = this.begin('item.pushed');
          ticketPatch(tx, item, { pushedSha: sha });
          this.commit(tx);
        });
      } catch (err) {
        if (err instanceof PublishError || err instanceof GitError) throw new WorkError('invalid-state', err.message);
        throw err;
      }
      const previous = deliveryPull(item);
      const reference: GithubPullReference = { ...published.pr, id: previous?.id ?? newId('ref', this.now()), role: 'delivery', kind: 'github-pr' };
      const tx = this.begin('item.publish');
      this.deps.backlog.reference(tx, item, previous ? 'update' : 'add', reference);
      this.commit(tx);
      this.deps.notify(
        'pr.published',
        `${this.label(item)} was published: ${published.created ? 'opened' : 'updated'} ${published.pr.draft ? 'draft ' : ''}pull request ${published.pr.url}${published.link ? ` (${published.link})` : ''}`,
        item.id,
      );
      this.deps.published?.(item.id).catch((err: unknown) => {
        this.deps.log.warn('github.published-hook-failed', { itemId: item.id, detail: (err as Error).message });
      });
      return { prUrl: published.pr.url };
    });
  }

  /** Delete a ticket (Todo or Done). Its worktree goes; its branch and its journal record stay. */
  async remove(ref: string): Promise<void> {
    const item = this.item(ref);
    const def = this.deps.definition();
    await this.exclusive(item.id, async () => {
      if (!this.deps.backlog.get(item.id)) return;
      this.guard(() => {
        if (!allows({ status: item.status, outcome: item.outcome }, 'delete')) {
          throw new ItemStateError(`Cannot delete a ticket that is ${this.phrase(item)}.`);
        }
        const tx = this.begin('item.delete');
        endSteps(tx, item.id, 'cancel');
        this.deps.backlog.remove(tx, item);
        this.commit(tx);
      });
      if (item.sessionId) this.deps.turns.close(item.sessionId);
      if (item.worktree && def) {
        const repo = def.repos.find((r) => r.dir === item.repo);
        if (repo) {
          const worktree = item.worktree;
          await this.deps.git.serial(repo.dir, () => this.deps.git.removeWorktree(repo.dir, worktree)).catch((err: unknown) => {
            this.deps.log.warn('item.worktree-remove-failed', { itemId: item.id, detail: (err as Error).message });
          });
        }
      }
    });
  }

  /* ---------- Dispatch ---------- */

  private findStep(stepId: string): { item: ItemRecord; step: Step } | null {
    for (const item of this.deps.backlog.list()) {
      const step = this.activeStep(item);
      if (step?.id === stepId) return { item, step };
    }
    return null;
  }

  private stepRunning(item: ItemRecord, stepId: string): boolean {
    return this.deps.workflow.step(item.id, stepId)?.state === 'running';
  }

  /**
   * Start a queued implement step: it takes a slot now (synchronously, so
   * the scheduler's count holds, and a Todo ticket moves to In progress in
   * the same transaction), then its worktree and session are prepared and
   * its input starts.
   */
  dispatch(stepId: string): void {
    const found = this.findStep(stepId);
    if (!found) return;
    const { item, step } = found;
    if (step.kind !== 'implement' || step.state !== 'queued') return;
    if (this.busy(item.id)) return;
    const reason = item.requeue;
    const attempts = reason === 'restart' ? item.attempts : reason === 'follow-up' || reason === 'retry' ? 1 : item.attempts + 1;
    const tx = this.begin('step.start');
    const change = { attempts, requeue: null, ...askFields([]), agent: step.agent ?? item.agent };
    if (item.status === 'todo') ticketStatus(tx, item, 'start', { change, by: PIPELINE });
    else ticketPatch(tx, item, change);
    stepMove(tx, item.id, step, 'start', 'running');
    this.commit(tx);
    this.deps.log.info('item.dispatch', { itemId: item.id, stepId, agent: step.agent, attempts, reason });
    this.deps.slotsChanged();
    const job = this.exclusive(item.id, () => this.prepare(item, stepId, reason));
    void this.trackPrepare(job).catch((err: unknown) => this.dispatchFailed(item, stepId, err));
  }

  private async prepare(item: ItemRecord, stepId: string, reason: ItemRecord['requeue']): Promise<void> {
    const def = this.def();
    if (!item.sessionId) {
      const repo = this.repoOf(def, item);
      const assignment = def.agents.find((a) => a.agent === item.agent);
      const agent = item.agent ? def.agentDefs[item.agent] : undefined;
      if (!assignment || !agent) throw new Error(`"${item.agent ?? ''}" is no longer assigned in this environment.`);
      const git = this.deps.git;
      const worktree = git.worktreeDir(item.number);
      const branch = item.branch ?? itemBranch(item.number, item.title);
      try {
        const base = await git.serial(repo.dir, async () => {
          await git.fetchMirror(repo.dir, repo.github);
          await git.fetchWorkspace(repo.dir);
          const baseBranch = repo.branch ?? (await git.defaultBranch(repo.dir));
          const sha = await git.addWorktree(repo.dir, worktree, branch, baseBranch);
          return { branch: baseBranch, sha };
        });
        if (!this.stepRunning(item, stepId)) return; // cancelled while preparing; finally drops the unrecorded worktree
        const issue = this.deps.issueContext ? await this.deps.issueContext(item) : null;
        const step = this.deps.workflow.step(item.id, stepId);
        if (!step || step.state !== 'running') return;
        const session = this.deps.turns.create({ kind: 'worker', agent: agent.name, harness: agent.harness, cwd: worktree, itemId: item.id, stepId });
        const prompt = workerPrompt({ number: item.number, title: item.title, body: item.body, github: repo.github, cwd: worktree, branch, base, issue });
        const tx = this.begin('step.session');
        ticketPatch(tx, item, { repo: repo.dir, branch, worktree, base, sessionId: session.id });
        stepUpdate(tx, item.id, step, { sessionId: session.id });
        tx.push({ kind: 'step.input', itemId: item.id, stepId, sessionId: session.id, author: 'system', text: prompt, attachment: null });
        this.commit(tx);
        this.deps.turns.send(session.id, prompt, 'system');
      } finally {
        if (!item.worktree) await this.dropUnrecordedWorktree(item, repo.dir, worktree);
      }
      return;
    }
    // Later dispatches reuse the worktree and the session.
    const step = this.deps.workflow.step(item.id, stepId);
    if (!step || step.state !== 'running') return;
    const sessionId = item.sessionId;
    this.deps.turns.bindStep(sessionId, stepId);
    if (step.sessionId !== sessionId) {
      const tx = this.begin('step.session');
      stepUpdate(tx, item.id, step, { sessionId });
      this.commit(tx);
    }
    const session = this.deps.turns.get(sessionId);
    if (session && session.turns === 0 && this.deps.turns.queueLength(sessionId) === 0) {
      // A session that started no turn and has nothing queued never saw the
      // item, e.g. a shutdown or upgrade caught the first prepare between
      // creating the session and queueing its prompt.
      const repo = this.repoOf(def, item);
      if (!item.worktree || !item.branch || !item.base) throw new Error(`${itemLabel(item)} has a worker session but no worktree.`);
      this.deps.turns.send(
        sessionId,
        workerPrompt({ number: item.number, title: item.title, body: item.body, github: repo.github, cwd: item.worktree, branch: item.branch, base: item.base }),
        'system',
      );
    } else if (this.deps.turns.queueLength(sessionId) === 0) {
      const why =
        reason === 'restart'
          ? RESTART_REASON
          : reason === 'retry'
            ? item.lastError
              ? `it failed: ${oneLine(item.lastError, 300)}`
              : 'it was cancelled'
            : oneLine(item.lastError ?? 'an error', 300);
      this.deps.turns.send(sessionId, continuePrompt(item.number, why), 'system');
    } else {
      this.deps.turns.kick(sessionId);
    }
  }

  private dropUnrecordedWorktree(item: ItemRecord, dir: string, worktree: string): Promise<void> {
    return this.deps.git.serial(dir, () => this.deps.git.removeWorktree(dir, worktree)).catch((err: unknown) => {
      this.deps.log.warn('item.worktree-remove-failed', { itemId: item.id, detail: (err as Error).message });
    });
  }

  /** Preparing a dispatch failed: count it like a failed turn. */
  private dispatchFailed(item: ItemRecord, stepId: string, err: unknown): void {
    const message = oneLine(err instanceof Error ? err.message : String(err), 500);
    this.deps.log.error('item.dispatch-failed', err, { itemId: item.id });
    const step = this.deps.workflow.step(item.id, stepId);
    if (!step || step.state !== 'running') return;
    // Shutting down: the step stays running on disk and boot requeues it.
    if (err instanceof TurnsError && err.code === 'not-ready') return;
    if (err instanceof JournalError) return;
    this.failAttempt(item, step, message);
    this.deps.slotsChanged();
  }

  private failAttempt(item: ItemRecord, step: Step, message: string, tx: Tx = this.begin('step.error')): void {
    const max = this.deps.definition()?.limits.maxAttempts ?? 1;
    const final = item.attempts >= max;
    if (final) {
      stepMove(tx, item.id, step, 'error-final', 'done', { result: 'failed', patch: { detail: oneLine(message, 150) } });
      ticketStatus(tx, item, 'fail', { change: { lastError: message, ...askFields([]) }, by: PIPELINE, reason: message });
      endSteps(tx, item.id, 'fail');
    } else {
      stepMove(tx, item.id, step, 'error', 'queued');
      ticketPatch(tx, item, { lastError: message, ...askFields([]), requeue: 'error' });
    }
    this.commit(tx);
    if (final) {
      this.deps.notify(
        'item.failed',
        `${this.label(item)} (${item.agent ?? 'unassigned'}) failed after ${item.attempts} attempt${item.attempts === 1 ? '' : 's'}: ${oneLine(message, 400)}`,
        item.id,
      );
    } else {
      this.deps.notify(
        'item.requeued',
        `${this.label(item)} (${item.agent ?? 'unassigned'}) was requeued after attempt ${item.attempts} of ${max}: ${oneLine(message, 400)}`,
        item.id,
      );
    }
  }

  /* ---------- Turn ends ---------- */

  /** Worker sessions start only while their implement step holds a slot and no reprovision is in progress. */
  canStart(session: SessionRecord): boolean {
    if (session.kind !== 'worker') return true;
    if (this.deps.reprovisioning()) return false;
    const item = session.itemId ? this.deps.backlog.get(session.itemId) : null;
    if (!item || item.sessionId !== session.id) return false;
    const step = this.activeStep(item);
    return !!step && stepHoldsSlot(step) && step.sessionId === session.id;
  }

  async workerTurnEnded(session: SessionRecord, outcome: TurnOutcome): Promise<void> {
    const item = session.itemId ? this.deps.backlog.get(session.itemId) : null;
    if (!item || item.sessionId !== session.id) return;
    // Shutdown or upgrade: the step stays running on disk; boot requeues it.
    if (outcome.interrupted === 'restart') return;
    if (!this.isRunning(item)) return; // cancelled meanwhile
    const result = await this.capture(item, outcome);
    const step = this.activeStep(item);
    if (!step || !stepHoldsSlot(step)) return;
    const work = { head: result.head, commits: result.commits.length, summary: capBytes(result.summary, 2048) };
    const queued = this.deps.turns.queueLength(session.id) > 0;
    const tx = this.begin('step.end');
    if (outcome.interrupted === 'user') {
      stepMove(tx, item.id, step, 'cancel', 'done', { result: 'cancelled', patch: { detail: 'Stopped by the user', work } });
      ticketPatch(tx, item, { result: { ...result, interrupted: true }, ...askFields([]) });
      if (queued) {
        // A follow-up already queued runs next, the same as one sent after the stop.
        const round = openRound(tx, item.id, 'changes', 'A message queued before the stop');
        queueImplement(tx, item.id, round.round, { agent: step.agent, sessionId: session.id, purpose: 'changes' });
        ticketPatch(tx, item, { requeue: 'follow-up' });
      } else {
        addManualMerge(tx, item.id, step.round);
      }
      this.commit(tx);
      if (!queued) {
        this.deps.notify(
          'item.review',
          `${this.label(item)} (${item.agent ?? ''}) was interrupted by the user and is ready for review: ${describeChanges(item)}.`,
          item.id,
        );
      }
    } else if (outcome.error) {
      ticketPatch(tx, item, { result });
      this.failAttempt(item, step, outcome.error, tx);
    } else if (queued) {
      // A follow-up arrived during the turn: it runs next, in the same slot.
      ticketPatch(tx, item, { result });
      this.commit(tx);
      return;
    } else {
      stepMove(tx, item.id, step, 'finish', 'done', { result: 'passed', patch: { work } });
      ticketPatch(tx, item, { result, lastError: null, ...askFields([]) });
      addManualMerge(tx, item.id, step.round);
      this.commit(tx);
      const summary = result.summary ? ` Summary: ${oneLine(result.summary, 600)}` : '';
      this.deps.notify('item.review', `${this.label(item)} (${item.agent ?? ''}) is ready for review: ${describeChanges(item)}.${summary}`, item.id);
    }
    this.deps.slotsChanged();
  }

  private async capture(item: ItemRecord, outcome: TurnOutcome): Promise<ResultOf> {
    const summary = lastAssistantText(outcome.entry);
    const empty: ResultOf = {
      summary,
      commits: [],
      diffStat: { files: 0, insertions: 0, deletions: 0, text: '' },
      uncommitted: [],
      interrupted: false,
      endedAt: this.now(),
      head: '',
    };
    const def = this.deps.definition();
    if (!item.worktree || !item.base || !def) return empty;
    const repo = def.repos.find((r) => r.dir === item.repo);
    if (!repo) return empty;
    const worktree = item.worktree;
    const baseSha = item.base.sha;
    try {
      const captured = await this.deps.git.serial(repo.dir, () => this.deps.git.capture(worktree, baseSha));
      return { ...empty, commits: captured.commits, diffStat: captured.diffStat, uncommitted: captured.uncommitted, head: captured.head };
    } catch (err) {
      this.deps.log.warn('item.capture-failed', { itemId: item.id, detail: (err as Error).message });
      return item.result ? { ...item.result, summary: summary || item.result.summary, endedAt: this.now() } : empty;
    }
  }

  /* ---------- Restart ---------- */

  /**
   * Boot: implement steps a restart caught running (or waiting on a
   * question) go back to `queued` without counting an attempt; their next
   * dispatch resumes the same session. Returns their tickets.
   */
  reconcile(): ItemRecord[] {
    const requeued: ItemRecord[] = [];
    for (const item of this.deps.backlog.list()) {
      const step = this.activeStep(item);
      if (!step || !stepHoldsSlot(step)) continue;
      const tx = this.begin('boot.restart');
      stepMove(tx, item.id, step, 'restart', 'queued');
      ticketPatch(tx, item, { requeue: 'restart', ...askFields([]) });
      this.commit(tx);
      requeued.push(item);
    }
    return requeued;
  }

  /* ---------- Worker questions ---------- */

  /** A worker asked: its implement step waits in needs-input, and the question goes where the policy says. */
  routeAsk(session: SessionRecord, askId: string, questions: AskQuestion[]): 'user' | 'orchestrator' {
    if (session.kind !== 'worker') return 'user';
    const item = session.itemId ? this.deps.backlog.get(session.itemId) : null;
    const step = item ? this.activeStep(item) : null;
    if (!item || !step || (step.state !== 'running' && step.state !== 'needs-input')) return 'user';
    const routedTo = this.deps.definition()?.policies.asks === 'user' ? 'user' : 'orchestrator';
    const tx = this.begin('step.ask');
    const round = tx.workflow(item.id)?.rounds.find((r) => r.round === step.round);
    if (step.state === 'running') stepMove(tx, item.id, step, 'ask', 'needs-input');
    const ask: TicketAsk = { askId, kind: 'question', roundId: round?.roundId ?? '', stepId: step.id, routedTo, since: tx.at };
    ticketPatch(tx, item, askFields([...item.asks, ask]));
    this.commit(tx);
    if (routedTo === 'orchestrator') {
      const asked = questions
        .map((q) => {
          const labels = q.options.map((o) => o.label).filter(Boolean);
          return `"${oneLine(q.question, 300)}"${labels.length ? ` Options: ${labels.join(', ')}.` : ''}`;
        })
        .join(' ');
      this.deps.notify(
        'item.needs-input',
        `${this.label(item)} (${item.agent ?? ''}) asks: ${asked} Answer with answer_worker or hand it to the user with escalate_to_user.`,
        item.id,
      );
    }
    return routedTo;
  }

  askClosed(session: SessionRecord, askId: string): void {
    const item = session.itemId ? this.deps.backlog.get(session.itemId) : null;
    if (!item || !item.asks.some((a) => a.askId === askId)) return;
    const asks = item.asks.filter((a) => a.askId !== askId);
    const tx = this.begin('step.answer');
    const step = activeImplementOf(tx.steps(item.id));
    if (step?.state === 'needs-input' && !asks.some((a) => a.stepId === step.id)) stepMove(tx, item.id, step, 'answer', 'running');
    ticketPatch(tx, item, askFields(asks));
    this.commit(tx);
  }

  private oldestQuestion(item: ItemRecord, routedTo?: 'user' | 'orchestrator'): TicketAsk | null {
    return item.asks.find((a) => a.kind === 'question' && (!routedTo || a.routedTo === routedTo)) ?? null;
  }

  answerWorker(ref: string, answers: Record<string, string>): void {
    const item = this.item(ref);
    const ask = this.oldestQuestion(item);
    if (!ask || !item.sessionId) throw new WorkError('invalid-state', `${itemLabel(item)} has no open question.`);
    if (!this.deps.turns.answer(item.sessionId, ask.askId, answers, 'orchestrator')) {
      throw new WorkError('invalid-state', `The question from ${itemLabel(item)} is no longer open.`);
    }
  }

  escalate(ref: string, note: string): void {
    const item = this.item(ref);
    const ask = this.oldestQuestion(item, 'orchestrator') ?? this.oldestQuestion(item);
    if (!ask) throw new WorkError('invalid-state', `${itemLabel(item)} has no open question.`);
    this.deps.turns.annotateAsk(ask.askId, note);
    this.routeToUser(item, ask.askId);
    this.deps.log.info('item.escalated', { itemId: item.id });
  }

  private routeToUser(item: ItemRecord, askId: string): void {
    const ask = item.asks.find((a) => a.askId === askId);
    if (!ask || ask.routedTo === 'user') return;
    this.deps.turns.routeAsk(askId, 'user');
    const tx = this.begin('ask.routed');
    ticketPatch(tx, item, askFields(item.asks.map((a) => (a.askId === askId ? { ...a, routedTo: 'user' as const } : a))));
    this.commit(tx);
  }

  /**
   * An orchestrator turn ended: a question it was told about and neither
   * answered nor escalated goes to the user.
   */
  orchestratorTurnEnded(outcome: TurnOutcome): void {
    for (const notice of outcome.notices) {
      if (notice.kind !== 'item.needs-input' || !notice.itemId) continue;
      const item = this.deps.backlog.get(notice.itemId);
      if (!item) continue;
      for (const ask of item.asks.filter((a) => a.routedTo === 'orchestrator')) this.routeToUser(item, ask.askId);
    }
  }

  /* ---------- Boot recovery ---------- */

  /**
   * Boot, after the journal is rolled forward: every implement step that is
   * not done gets back any `step.input` its session lacks (a crash between
   * the journal and the session store). `inputs` are the journaled inputs
   * per step, oldest first.
   */
  requeueInputs(inputs: ReadonlyMap<string, { at: number; sessionId: string; author: EntryAuthor; text: string }[]>): number {
    let sent = 0;
    const have = new Map<string, string[]>();
    for (const item of this.deps.backlog.list()) {
      for (const step of latestAttempts(this.deps.workflow.steps(item.id))) {
        if (step.kind !== 'implement' || step.state === 'done') continue;
        const wanted = inputs.get(step.id) ?? [];
        for (const input of wanted) {
          if (!this.deps.turns.get(input.sessionId)) continue;
          let texts = have.get(input.sessionId);
          if (!texts) {
            texts = this.deps.turns.inputTexts(input.sessionId, wanted[0]?.at ?? input.at);
            have.set(input.sessionId, texts);
          }
          const at = texts.indexOf(input.text);
          if (at >= 0) {
            texts.splice(at, 1);
            continue;
          }
          this.deps.turns.send(input.sessionId, input.text, input.author);
          sent += 1;
          this.deps.log.info('journal.input-requeued', { itemId: item.id, stepId: step.id });
        }
      }
    }
    return sent;
  }

  /* ---------- Reading a worker ---------- */

  /** A worker's last entries, condensed to assistant text and tool summaries. */
  read(ref: string, last: number, maxBytes = 16 * 1024): string {
    const item = this.item(ref);
    if (!item.sessionId) return `${itemLabel(item)} has not started yet.`;
    const page = this.deps.turns.transcriptPage(item.sessionId, last);
    const lines: string[] = [];
    for (const entry of page) lines.push(...condense(entry));
    let out = lines.join('\n');
    if (Buffer.byteLength(out, 'utf8') > maxBytes) out = `…${out.slice(-maxBytes)}`;
    return out || `${itemLabel(item)} has no transcript yet.`;
  }
}

function condense(entry: TranscriptEntry): string[] {
  if (entry.kind === 'user') return [`[${entry.author}] ${oneLine(entry.text, 500)}`];
  if (entry.kind === 'notice') return [];
  const out: string[] = [];
  let text = '';
  const flush = (): void => {
    if (text.trim()) out.push(`[assistant] ${text.trim()}`);
    text = '';
  };
  for (const event of entry.events) {
    if (event.kind === 'text-delta' && !event.parentId) text += event.text;
    else if (event.kind === 'tool-start' && !event.parentId) {
      flush();
      out.push(`[tool] ${event.tool}: ${oneLine(event.summary, 200)}`);
    } else if (event.kind === 'error') {
      flush();
      out.push(`[error] ${oneLine(event.message, 300)}`);
    }
  }
  flush();
  return out;
}
