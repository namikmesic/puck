/**
 * Work items end to end: the operations clients and the orchestrator's
 * tools share (create, edit, reorder, assign, cancel, retry, accept,
 * follow up, delete), dispatch into a worktree and worker session, result
 * capture at every worker turn end, and worker questions.
 *
 * Every status change goes through the state machine in items.ts. The
 * scheduler picks what to dispatch; this module does the dispatching.
 *
 * Attempts. `attempts` counts the dispatches of the current request: the
 * first dispatch and each dispatch after an error add one, and an error
 * with `attempts >= maxAttempts` fails the item. A follow-up or a retry is
 * a new request and starts again at one. A daemon restart is not a failed
 * attempt: the item goes back to `queued` without a count, and its next
 * dispatch resumes the SAME worker session (the harness's saved
 * conversation) with a short continue message, so nothing starts over.
 * A worker session that never received its prompt (the restart came
 * between creating it and queueing the prompt) gets the full worker prompt.
 */

import type { AskQuestion } from '../harness/types';
import type { IssueSource, ItemPosition, WorkItem } from '../harness/daemon-protocol';
import type { DaemonDefinition, DaemonRepo } from '../harness/env-definition';
import type { EntryAuthor, NoticeKind, TranscriptEntry, TurnEntry } from '../harness/transcript';
import { capBytes, type Git, GitError, itemBranch, RESULT_LIMITS } from './git';
import { type Backlog, holdsSlot, itemLabel, ItemStateError } from './items';
import type { Logger } from './log';
import { continuePrompt, RESTART_REASON, workerPrompt } from './prompts';
import { PublishError, type Publisher, type PublishRequest } from './publish';
import type { ItemRecord } from './store/items';
import type { SessionRecord } from './store/sessions';
import { type TurnOutcome, type Turns, TurnsError } from './turns';

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

function describeChanges(item: WorkItem): string {
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

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ItemStateError) throw new WorkError('invalid-state', err.message);
      throw err;
    }
  }

  /* ---------- Backlog operations ---------- */

  create(
    init: { title: string; body?: string; agent?: string | null; repo?: string | null; position?: ItemPosition; source?: IssueSource | null },
    actor: Actor,
    opts: { silent?: boolean } = {},
  ): ItemRecord {
    const def = this.def();
    const agent = init.agent ?? null;
    const repo = init.repo ?? null;
    if (agent) this.checkAgent(def, agent);
    this.checkRepo(def, repo, agent);
    const source = init.source ?? null;
    if (source) {
      // One open item per issue.
      const open = this.deps.backlog.byIssue(source.repo, source.number).find((i) => i.status !== 'done' && i.status !== 'cancelled');
      if (open) throw new WorkError('invalid-state', `Issue ${source.repo}#${source.number} is already ${itemLabel(open)} (${open.status}).`);
    }
    const item = this.guard(() =>
      this.deps.backlog.create({
        title: init.title.trim(),
        body: init.body ?? '',
        agent,
        repo,
        createdBy: actor,
        position: init.position,
        source,
      }),
    );
    if (actor === 'user' && !opts.silent) {
      this.deps.notify('item.created', `The user created ${this.label(item)}${agent ? `, assigned to ${agent}` : ' in the backlog'}.`, item.id);
    }
    this.deps.requestTick();
    return item;
  }

  update(ref: string, change: { title?: string; body?: string; repo?: string }, actor: Actor): ItemRecord {
    const item = this.item(ref);
    if (holdsSlot(item.status)) throw new WorkError('invalid-state', `${itemLabel(item)} is running; edit it once it stops.`);
    const def = this.def();
    if (change.repo !== undefined && change.repo !== item.repo) {
      if (item.worktree) throw new WorkError('invalid-state', `${itemLabel(item)} already has a worktree in ${item.repo ?? 'its repository'}.`);
      this.checkRepo(def, change.repo, null);
    }
    const patch: Partial<ItemRecord> = {};
    if (change.title !== undefined) patch.title = change.title.trim();
    if (change.body !== undefined) patch.body = change.body;
    if (change.repo !== undefined) patch.repo = change.repo;
    this.deps.backlog.patch(item, patch);
    if (actor === 'user') this.deps.notify('item.updated', `The user edited ${this.label(item)}.`, item.id);
    return item;
  }

  move(ref: string, position: ItemPosition): string[] {
    const item = this.item(ref);
    const order = this.guard(() => this.deps.backlog.move(item, position));
    this.deps.requestTick();
    return order;
  }

  assign(ref: string, agent: string | null, actor: Actor): ItemRecord {
    const item = this.item(ref);
    const def = this.def();
    if (agent === null) {
      this.guard(() => this.deps.backlog.transition(item, 'unassign', { agent: null }));
    } else {
      this.checkAgent(def, agent);
      this.checkRepo(def, item.repo, agent);
      if (item.sessionId) {
        const owner = item.agent ?? this.deps.turns.get(item.sessionId)?.agent ?? null;
        if (agent !== owner) {
          throw new WorkError('invalid-state', `${itemLabel(item)} already has a ${owner ?? 'worker'} session; it keeps that agent.`);
        }
      }
      this.guard(() => this.deps.backlog.transition(item, 'assign', { agent }));
    }
    if (actor === 'user') {
      this.deps.notify(
        'item.updated',
        agent ? `The user assigned ${this.label(item)} to ${agent}.` : `The user moved ${this.label(item)} back to the backlog.`,
        item.id,
      );
    }
    this.deps.requestTick();
    return item;
  }

  cancel(ref: string, actor: Actor, reason?: string): ItemRecord {
    const item = this.item(ref);
    const held = holdsSlot(item.status);
    const cancelReason = reason?.trim() ? reason.trim() : null;
    this.guard(() =>
      this.deps.backlog.transition(item, 'cancel', { pendingAsk: null, requeue: null, ...(cancelReason ? { cancelReason } : {}) }),
    );
    if (item.sessionId) {
      this.deps.turns.clearQueue(item.sessionId);
      this.deps.turns.interrupt(item.sessionId, 'user');
    }
    if (actor === 'user') this.deps.notify('item.updated', `The user cancelled ${this.label(item)}.`, item.id);
    this.deps.log.info('item.cancel', { itemId: item.id, actor });
    if (held) this.deps.slotsChanged();
    return item;
  }

  retry(ref: string): ItemRecord {
    const item = this.item(ref);
    this.guard(() => this.deps.backlog.transition(item, 'retry', { attempts: 0, requeue: item.sessionId ? 'retry' : null }));
    this.deps.requestTick();
    return item;
  }

  accept(ref: string, note?: string): ItemRecord {
    const item = this.item(ref);
    const acceptNote = note?.trim() ? note.trim() : null;
    const held = holdsSlot(item.status);
    const sessionId = item.sessionId;
    const stop = !!sessionId && (item.status === 'queued' || held);
    const updated = this.guard(() =>
      this.deps.backlog.transition(item, 'accept', {
        lastError: null,
        requeue: null,
        pendingAsk: null,
        ...(acceptNote ? { acceptNote } : {}),
      }),
    );
    if (stop && sessionId) {
      this.deps.turns.clearQueue(sessionId);
      this.deps.turns.interrupt(sessionId, 'user');
    }
    if (held) this.deps.slotsChanged();
    return updated;
  }

  /**
   * A follow-up for an item's worker. In review it queues the item again
   * (the text waits in the worker's session until a slot is free); while it
   * waits or runs the text joins the session's queue.
   */
  followUp(ref: string, text: string, author: EntryAuthor): Promise<{ queued: boolean; turnId?: string }> {
    const item = this.item(ref);
    return this.exclusive(item.id, () => {
      if (!item.sessionId) throw new WorkError('invalid-state', `${itemLabel(item)} has not started yet.`);
      if (item.status === 'review') {
        // The text is stored first; it waits in the session until a slot is free.
        const sent = this.deps.turns.send(item.sessionId, text, author);
        this.guard(() => this.deps.backlog.transition(item, 'follow-up', { requeue: 'follow-up' }));
        this.deps.requestTick();
        return sent;
      }
      if (item.status === 'queued' || holdsSlot(item.status)) return this.deps.turns.send(item.sessionId, text, author);
      throw new WorkError('invalid-state', `${itemLabel(item)} is ${item.status}; retry it or create a new item instead.`);
    });
  }

  /** Push the item's branch and open or update its pull request. Status does not change. */
  async publish(ref: string, req: PublishRequest, actor: Actor): Promise<{ prUrl: string }> {
    const item = this.item(ref);
    return this.exclusive(item.id, async () => {
      if (!this.deps.backlog.get(item.id)) throw new WorkError('not-found', `No work item ${ref}.`);
      if (actor === 'orchestrator' && this.def().policies.publish !== 'orchestrator') {
        throw new WorkError('invalid-state', 'Publishing is manual in this environment: the user publishes from the work view.');
      }
      let published;
      try {
        published = await this.deps.publisher.publish(item, req, (sha) => this.deps.backlog.patch(item, { pushedSha: sha }));
      } catch (err) {
        if (err instanceof PublishError || err instanceof GitError) throw new WorkError('invalid-state', err.message);
        throw err;
      }
      this.deps.backlog.patch(item, { pr: published.pr });
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

  /** Delete an item. Its worktree goes; its branch stays. */
  async remove(ref: string): Promise<void> {
    const item = this.item(ref);
    const def = this.deps.definition();
    await this.exclusive(item.id, async () => {
      if (!this.deps.backlog.get(item.id)) return;
      this.guard(() => this.deps.backlog.transition(item, 'delete'));
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

  /**
   * Start a queued item: it takes a slot now (synchronously, so the
   * scheduler's count holds), then its worktree and session are prepared
   * and its input starts.
   */
  dispatch(itemId: string): void {
    const item = this.deps.backlog.get(itemId);
    if (!item || item.status !== 'queued') return;
    if (this.busy(item.id)) return;
    const reason = item.requeue;
    const attempts = reason === 'restart' ? item.attempts : reason === 'follow-up' || reason === 'retry' ? 1 : item.attempts + 1;
    this.deps.backlog.transition(item, 'dispatch', { attempts, requeue: null, pendingAsk: null });
    this.deps.log.info('item.dispatch', { itemId: item.id, agent: item.agent, attempts, reason });
    this.deps.slotsChanged();
    const job = this.exclusive(item.id, () => this.prepare(item, reason));
    void this.trackPrepare(job).catch((err: unknown) => this.dispatchFailed(item, err));
  }

  private async prepare(item: ItemRecord, reason: ItemRecord['requeue']): Promise<void> {
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
        if (item.status !== 'running') return; // cancelled while preparing; finally drops the unrecorded worktree
        const issue = this.deps.issueContext ? await this.deps.issueContext(item) : null;
        if (item.status !== 'running') return;
        const session = this.deps.turns.create({ kind: 'worker', agent: agent.name, harness: agent.harness, cwd: worktree, itemId: item.id });
        this.deps.backlog.patch(item, { repo: repo.dir, branch, worktree, base, sessionId: session.id });
        this.deps.turns.send(
          session.id,
          workerPrompt({ number: item.number, title: item.title, body: item.body, github: repo.github, cwd: worktree, branch, base, issue }),
          'system',
        );
      } finally {
        if (!item.worktree) await this.dropUnrecordedWorktree(item, repo.dir, worktree);
      }
      return;
    }
    // Later dispatches reuse the worktree and the session.
    if (item.status !== 'running') return;
    const session = this.deps.turns.get(item.sessionId);
    if (session && session.turns === 0 && this.deps.turns.queueLength(item.sessionId) === 0) {
      // A session that started no turn and has nothing queued never saw the
      // item, e.g. a shutdown or upgrade caught the first prepare between
      // creating the session and queueing its prompt.
      const repo = this.repoOf(def, item);
      if (!item.worktree || !item.branch || !item.base) throw new Error(`${itemLabel(item)} has a worker session but no worktree.`);
      this.deps.turns.send(
        item.sessionId,
        workerPrompt({ number: item.number, title: item.title, body: item.body, github: repo.github, cwd: item.worktree, branch: item.branch, base: item.base }),
        'system',
      );
    } else if (this.deps.turns.queueLength(item.sessionId) === 0) {
      const why =
        reason === 'restart'
          ? RESTART_REASON
          : reason === 'retry'
            ? item.lastError
              ? `it failed: ${oneLine(item.lastError, 300)}`
              : 'it was cancelled'
            : oneLine(item.lastError ?? 'an error', 300);
      this.deps.turns.send(item.sessionId, continuePrompt(item.number, why), 'system');
    } else {
      this.deps.turns.kick(item.sessionId);
    }
  }

  private dropUnrecordedWorktree(item: ItemRecord, dir: string, worktree: string): Promise<void> {
    return this.deps.git.serial(dir, () => this.deps.git.removeWorktree(dir, worktree)).catch((err: unknown) => {
      this.deps.log.warn('item.worktree-remove-failed', { itemId: item.id, detail: (err as Error).message });
    });
  }

  /** Preparing a dispatch failed: count it like a failed turn. */
  private dispatchFailed(item: ItemRecord, err: unknown): void {
    const message = oneLine(err instanceof Error ? err.message : String(err), 500);
    this.deps.log.error('item.dispatch-failed', err, { itemId: item.id });
    if (item.status !== 'running') return;
    // Shutting down: the item stays running on disk and boot requeues it.
    if (err instanceof TurnsError && err.code === 'not-ready') return;
    this.failAttempt(item, message);
    this.deps.slotsChanged();
  }

  private failAttempt(item: ItemRecord, message: string): void {
    const max = this.deps.definition()?.limits.maxAttempts ?? 1;
    if (item.attempts >= max) {
      this.deps.backlog.transition(item, 'error-final', { lastError: message, pendingAsk: null });
      this.deps.notify(
        'item.failed',
        `${this.label(item)} (${item.agent ?? 'unassigned'}) failed after ${item.attempts} attempt${item.attempts === 1 ? '' : 's'}: ${oneLine(message, 400)}`,
        item.id,
      );
    } else {
      this.deps.backlog.transition(item, 'error', { lastError: message, pendingAsk: null, requeue: 'error' });
      this.deps.notify(
        'item.requeued',
        `${this.label(item)} (${item.agent ?? 'unassigned'}) was requeued after attempt ${item.attempts} of ${max}: ${oneLine(message, 400)}`,
        item.id,
      );
    }
  }

  /* ---------- Turn ends ---------- */

  /** Worker sessions start only while their item holds a slot and no reprovision is in progress. */
  canStart(session: SessionRecord): boolean {
    if (session.kind !== 'worker') return true;
    if (this.deps.reprovisioning()) return false;
    const item = session.itemId ? this.deps.backlog.get(session.itemId) : null;
    return !!item && holdsSlot(item.status) && item.sessionId === session.id;
  }

  async workerTurnEnded(session: SessionRecord, outcome: TurnOutcome): Promise<void> {
    const item = session.itemId ? this.deps.backlog.get(session.itemId) : null;
    if (!item || item.sessionId !== session.id) return;
    // Shutdown or upgrade: the item stays running on disk; boot requeues it.
    if (outcome.interrupted === 'restart') return;
    if (!holdsSlot(item.status)) return; // cancelled meanwhile
    const result = await this.capture(item, outcome);
    if (!holdsSlot(item.status)) return;
    if (outcome.interrupted === 'user') {
      this.deps.backlog.transition(item, 'interrupt', { result: { ...result, interrupted: true }, pendingAsk: null });
      if (this.deps.turns.queueLength(session.id) > 0) {
        // A follow-up already queued runs next, the same as one sent in review.
        this.deps.backlog.transition(item, 'follow-up', { requeue: 'follow-up' });
      } else {
        this.deps.notify(
          'item.review',
          `${this.label(item)} (${item.agent ?? ''}) was interrupted by the user and is ready for review: ${describeChanges(item)}.`,
          item.id,
        );
      }
    } else if (outcome.error) {
      this.deps.backlog.patch(item, { result });
      this.failAttempt(item, outcome.error);
    } else if (this.deps.turns.queueLength(session.id) > 0) {
      // A follow-up arrived during the turn: it runs next, in the same slot.
      this.deps.backlog.patch(item, { result });
      return;
    } else {
      this.deps.backlog.transition(item, 'finish', { result, lastError: null, pendingAsk: null });
      const summary = result.summary ? ` Summary: ${oneLine(result.summary, 600)}` : '';
      this.deps.notify('item.review', `${this.label(item)} (${item.agent ?? ''}) is ready for review: ${describeChanges(item)}.${summary}`, item.id);
    }
    this.deps.slotsChanged();
  }

  private async capture(item: ItemRecord, outcome: TurnOutcome): Promise<NonNullable<WorkItem['result']>> {
    const summary = lastAssistantText(outcome.entry);
    const empty = {
      summary,
      commits: [],
      diffStat: { files: 0, insertions: 0, deletions: 0, text: '' },
      uncommitted: [],
      interrupted: false,
      endedAt: this.now(),
    };
    const def = this.deps.definition();
    if (!item.worktree || !item.base || !def) return empty;
    const repo = def.repos.find((r) => r.dir === item.repo);
    if (!repo) return empty;
    const worktree = item.worktree;
    const baseSha = item.base.sha;
    try {
      const captured = await this.deps.git.serial(repo.dir, () => this.deps.git.capture(worktree, baseSha));
      return { ...empty, commits: captured.commits, diffStat: captured.diffStat, uncommitted: captured.uncommitted };
    } catch (err) {
      this.deps.log.warn('item.capture-failed', { itemId: item.id, detail: (err as Error).message });
      return item.result ? { ...item.result, summary: summary || item.result.summary, endedAt: this.now() } : empty;
    }
  }

  /* ---------- Restart ---------- */

  /**
   * Boot: items a restart caught running (or waiting on a question) go back
   * to `queued` without counting an attempt; their next dispatch resumes
   * the same session. Returns them.
   */
  reconcile(): ItemRecord[] {
    const requeued: ItemRecord[] = [];
    for (const item of this.deps.backlog.list()) {
      if (!holdsSlot(item.status)) continue;
      this.deps.backlog.transition(item, 'restart', { requeue: 'restart', pendingAsk: null });
      requeued.push(item);
    }
    return requeued;
  }

  /* ---------- Worker questions ---------- */

  /** A worker asked: its item waits in needs-input, and the question goes where the policy says. */
  routeAsk(session: SessionRecord, askId: string, questions: AskQuestion[]): 'user' | 'orchestrator' {
    if (session.kind !== 'worker') return 'user';
    const item = session.itemId ? this.deps.backlog.get(session.itemId) : null;
    if (!item || item.status !== 'running') return 'user';
    const routedTo = this.deps.definition()?.policies.asks === 'user' ? 'user' : 'orchestrator';
    this.deps.backlog.transition(item, 'ask', { pendingAsk: { askId, routedTo } });
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
    if (!item || item.pendingAsk?.askId !== askId || item.status !== 'needs-input') return;
    this.deps.backlog.transition(item, 'answer', { pendingAsk: null });
  }

  answerWorker(ref: string, answers: Record<string, string>): void {
    const item = this.item(ref);
    const ask = item.pendingAsk;
    if (item.status !== 'needs-input' || !ask || !item.sessionId) throw new WorkError('invalid-state', `${itemLabel(item)} has no open question.`);
    if (!this.deps.turns.answer(item.sessionId, ask.askId, answers, 'orchestrator')) {
      throw new WorkError('invalid-state', `The question from ${itemLabel(item)} is no longer open.`);
    }
  }

  escalate(ref: string, note: string): void {
    const item = this.item(ref);
    const ask = item.pendingAsk;
    if (item.status !== 'needs-input' || !ask) throw new WorkError('invalid-state', `${itemLabel(item)} has no open question.`);
    this.deps.turns.annotateAsk(ask.askId, note);
    this.routeToUser(item);
    this.deps.log.info('item.escalated', { itemId: item.id });
  }

  private routeToUser(item: ItemRecord): void {
    const ask = item.pendingAsk;
    if (!ask || ask.routedTo === 'user') return;
    this.deps.turns.routeAsk(ask.askId, 'user');
    this.deps.backlog.patch(item, { pendingAsk: { askId: ask.askId, routedTo: 'user' } });
  }

  /**
   * An orchestrator turn ended: a question it was told about and neither
   * answered nor escalated goes to the user.
   */
  orchestratorTurnEnded(outcome: TurnOutcome): void {
    for (const notice of outcome.notices) {
      if (notice.kind !== 'item.needs-input' || !notice.itemId) continue;
      const item = this.deps.backlog.get(notice.itemId);
      if (item?.status === 'needs-input' && item.pendingAsk?.routedTo === 'orchestrator') this.routeToUser(item);
    }
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
