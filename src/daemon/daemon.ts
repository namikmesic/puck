/**
 * The daemon itself: the boot sequence, the command handlers, shutdown and
 * upgrade. main.ts takes the lock and wires process signals; everything
 * else starts here.
 *
 * Boot: migrate the state format (a failure leaves the daemon `failed`,
 * answering only the handshake, snapshots and logs) → open the delivery
 * journal, repair a torn tail, and roll items.json and delivery/tables.json
 * forward from it (a damaged journal fails the boot the same way) →
 * journal the legacy workflows once after the format-2 migration → open
 * the socket so the app can watch → ingest the inbox → provision →
 * reconcile what a restart interrupted (an unfinished turn becomes
 * interrupted; a transcript that already finished is left idle and is not
 * resumed; running implement steps go back to queued without counting an
 * attempt, and any journaled input their session lacks is queued again) →
 * make sure the orchestrator session exists → resume those turns → ready →
 * start the scheduler, the orchestrator's wake loop, and the GitHub poll.
 *
 * Orchestration lives in its own modules: items.ts (the backlog; the ticket
 * table is `src/harness/item-transitions.ts`), workflow.ts (steps, rounds
 * and journal transactions; the step table is `src/harness/workflow.ts`),
 * delivery/journal.ts (the write-ahead log), scheduler.ts, work.ts
 * (dispatch, worktrees, results, worker questions, merges), publish.ts,
 * orchestrator.ts (notices and wake), tools.ts (the orchestrator's
 * in-process tools) and github-sync.ts (issues, pull requests, CI and
 * reviews on GitHub). This class wires them to the turn loop and to the
 * protocol's commands.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PROTOCOL_VERSION,
  PROVISION_STAGES,
  UPGRADE_EXIT,
  COMMAND_LIMITS,
  PAGE_LIMITS,
  type DaemonEvent,
  type InstanceState,
  type Op,
  type OpArgs,
  type OpResult,
  type Pin,
  type ProvisionStage,
  type Snapshot,
  type WorkItem,
} from '../harness/daemon-protocol';
import { latestAttempts, latestRound, roundSteps, StepStateError } from '../harness/workflow';
import { asLedgerEvents } from './delivery/derive';
import { CheckpointAheadError, JOURNAL_FAILING, JournalDamagedError, JournalError, type Journal, type JournalIO } from './delivery/journal';
import { deliveryStore, type TablesFile } from './store/delivery';
import type { ItemRecord, ItemsFile } from './store/items';
import { sameTokenPermissions, tokenPoliciesFrom } from '../harness/github-permissions';
import { harnessDescriptors } from '../harness/providers';
import { Credentials } from './credentials';
import {
  changeClasses,
  definitionChanges,
  readDefinition,
  referencedHarnesses,
  type DaemonAgent,
  type DaemonDefinition,
} from '../harness/env-definition';
import { EventLog } from './eventlog';
import { runCommand, type CommandRunner } from './exec';
import { createAdapters } from './harness';
import { harnessEnv } from './harness/spawn';
import type { HarnessAdapter, OrchestratorTool } from './harness/types';
import { testAdapters } from './harness/test-adapters';
import { GRANT_SYNC_TIMEOUT_MS, grantSyncConfigured, syncGrantPolicies } from './grant-sync';
import { Git } from './git';
import { GitHubApi } from './github-api';
import { GithubSync } from './github-sync';
import { Backlog, itemLabel, ItemStateError } from './items';
import { tailLog, type Logger } from './log';
import { dispatch, OpError, type Handlers } from './ops';
import { Orchestrator } from './orchestrator';
import { orchestratorPreamble } from './prompts';
import { projectSnapshot } from './protocol-v1';
import { Publisher } from './publish';
import { capacityOf, runningCounts, Scheduler, type SchedulerStep, type SchedulerView } from './scheduler';
import { githubStore } from './store/github';
import { itemsStore } from './store/items';
import type { SessionRecord } from './store/sessions';
import { orchestratorTools } from './tools';
import { Work, WorkError } from './work';
import { PUCK_GID, PUCK_UID, type DaemonPaths } from './paths';
import { provision, provisionFingerprint, ProvisionError } from './provision';
import { DaemonServer, SnapshotParts, type OpContext } from './server';
import { bootDelivery, bootstrapLegacy, publicItem, type DeliveryBoot, type Workflow } from './workflow';
import { flushJsonWrites, reportWriteErrors } from './store/jsonfile';
import { instanceStore, type InstanceRecord } from './store/instance';
import { migrateState } from './store/meta';
import { noticesStore } from './store/notices';
import { sessionsStore } from './store/sessions';
import type { JsonStore } from './store/store';
import { TranscriptBook } from './transcripts';
import { RESUME_PROMPT, Turns, TurnsError, type TurnOutcome } from './turns';
import type { DaemonIdentity } from './version';

/** How long SIGTERM waits for interrupted turns before persisting anyway. */
const SHUTDOWN_GRACE_MS = 20_000;

type DaemonPhase = 'serving' | 'upgrading' | 'shutting-down';

export interface DaemonOptions {
  paths: DaemonPaths;
  log: Logger;
  identity: DaemonIdentity;
  env: NodeJS.ProcessEnv;
  /** True in the container (root): drop privileges and chown. False in unit tests. */
  privileged: boolean;
  exit(code: number): void;
  run?: CommandRunner;
  adapters?: Record<string, HarnessAdapter>;
  now?: () => number;
  /** How long upgrade-now and shutdown wait for a turn that ignores interrupt. */
  shutdownGraceMs?: number;
  /** Deadline of one policies PUT to the server (`GRANT_SYNC_TIMEOUT_MS`). */
  grantSyncTimeoutMs?: number;
  /** The delivery journal's file operations (tests inject failures). */
  journalIO?: JournalIO;
}

/** Ops a failed daemon still answers (fresh GitHub grants help the next boot). */
const FAILED_OPS: ReadonlySet<Op> = new Set<Op>(['snapshot.get', 'logs.tail', 'github.put']);
/** How often the GitHub credential state is re-read, so `expiring` and `missing` reach clients as time passes. */
const GITHUB_CHECK_MS = 60_000;
/** Ops that need a ready environment. */
const READY_OPS: ReadonlySet<Op> = new Set<Op>(['chat.send', 'credentials.get', 'daemon.upgrade']);
/**
 * Ops a daemon whose delivery journal is failing still answers (6.6): reads,
 * status and logs, and the daemon update, since the next boot is what checks
 * the journal again. Every other op mutates and is refused.
 */
const JOURNAL_FAILING_OPS: ReadonlySet<Op> = new Set<Op>([
  'snapshot.get',
  'snapshot.part',
  'session.history',
  'item.workflow',
  'item.records',
  'item.pr',
  'issue.search',
  'credentials.get',
  'logs.tail',
  'daemon.upgrade',
]);

export class Daemon {
  private state: InstanceState = { status: 'provisioning' };
  private definition: DaemonDefinition | null = null;
  private instance!: JsonStore<InstanceRecord | null>;
  private turns!: Turns;
  private transcripts!: TranscriptBook;
  private credentials!: Credentials;
  private events!: EventLog;
  private server!: DaemonServer;
  private backlog!: Backlog;
  private workflow!: Workflow;
  private journal: Journal | null = null;
  private itemsFile!: JsonStore<ItemsFile>;
  private tablesFile!: JsonStore<TablesFile>;
  /** Journaled worker inputs of implement steps not done, read once at boot. */
  private bootInputs = new Map<string, { at: number; sessionId: string; author: 'user' | 'orchestrator' | 'system'; text: string }[]>();
  private journalError: string | null = null;
  private formatBoundary = 0;
  private readonly parts: SnapshotParts;
  private work!: Work;
  private scheduler!: Scheduler;
  private orchestrator!: Orchestrator;
  private github!: GithubSync;
  private tools: OrchestratorTool[] = [];
  private git!: Git;
  /** True while a reprovision is waiting or provisioning. */
  private reprovisioning = false;
  /** True while definition.apply has not yet stored its definition or failed. */
  private applyingDefinition = false;
  private homeReady = false;
  private phase: DaemonPhase = 'serving';
  private exited = false;
  private githubShown = '';
  private githubTimer: ReturnType<typeof setInterval> | null = null;
  private readonly run: CommandRunner;
  private readonly now: () => number;
  private readonly shutdownGraceMs: number;
  private readonly grantSyncTimeoutMs: number;

  constructor(private readonly opts: DaemonOptions) {
    this.run = opts.run ?? runCommand;
    this.now = opts.now ?? Date.now;
    this.shutdownGraceMs = opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
    this.grantSyncTimeoutMs = opts.grantSyncTimeoutMs ?? GRANT_SYNC_TIMEOUT_MS;
    this.parts = new SnapshotParts({ now: this.now });
  }

  /* ---------- Boot ---------- */

  async start(): Promise<void> {
    const { paths, log } = this.opts;
    for (const dir of [paths.state, paths.run]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(paths.state, 0o700);
    fs.chmodSync(paths.run, 0o755);
    reportWriteErrors((file, err) => log.error('store.write', err, { file }));

    this.events = new EventLog(paths.events, { now: this.now, log });
    const migrated = migrateState(paths.state, { daemonVersion: this.opts.identity.daemonVersion, now: this.now(), eventHead: this.events.head() });
    if (migrated.ok) this.formatBoundary = migrated.meta.formatBoundary ?? 0;
    this.credentials = new Credentials({
      paths,
      log,
      run: this.run,
      asPuck: this.opts.privileged ? { uid: PUCK_UID, gid: PUCK_GID } : {},
      now: this.now,
    });
    if (migrated.ok) {
      this.instance = instanceStore(paths.state);
      this.transcripts = new TranscriptBook(paths.transcripts, this.now);
      this.itemsFile = itemsStore(paths.state);
      this.tablesFile = deliveryStore(paths.state);
      this.backlog = new Backlog({ store: this.itemsFile, now: this.now });
      this.openLedger();
      const asPuck = this.opts.privileged ? { uid: PUCK_UID, gid: PUCK_GID } : {};
      const git = (this.git = new Git({ paths, run: this.run, asPuck }));
      const test = testAdapters !== null;
      const apiBase = (test && this.opts.env.PUCK_TEST_GITHUB_API) || undefined;
      const publisher = new Publisher({
        git,
        tmpDir: path.join(paths.state, 'tmp'),
        grantFor: (owner) => this.credentials.grantFor(owner),
        definition: () => this.definition,
        envName: () => this.instance.get()?.name || this.definition?.name || '',
        apiBase,
        log,
        now: this.now,
      });
      this.orchestrator = new Orchestrator({
        notices: noticesStore(paths.state),
        turns: {
          orchestrator: () => this.turns.orchestrator(),
          isRunning: (id) => this.turns.isRunning(id),
          kick: (id) => this.turns.kick(id),
          upsert: (session) => this.turns.upsert(session),
        },
        settings: () => this.definition?.orchestrator ?? null,
        canWake: () => this.running() && !this.journalFailing(),
        log,
        now: this.now,
      });
      this.turns = new Turns({
        adapters:
          this.opts.adapters ??
          createAdapters({ log, daemonVersion: this.opts.identity.daemonVersion, orchestratorTools: () => this.tools }),
        sessions: sessionsStore(paths.state),
        transcripts: this.transcripts,
        emit: (ev) => this.emit(ev),
        retained: () => (this.events.since(this.events.oldest() - 1) ?? []).map((e) => e.ev),
        log,
        agentFor: (s) => this.agentFor(s),
        envFor: () => this.harnessEnv(),
        peekNotices: () => this.orchestrator.pending(),
        commitNotices: (count) => this.orchestrator.commit(count),
        canStart: (s) => this.work.canStart(s),
        onTurnEnd: (s, outcome) => this.turnEnded(s, outcome),
        routeAsk: (s, askId, questions) => this.work.routeAsk(s, askId, questions),
        onAskClosed: (s, askId) => this.work.askClosed(s, askId),
        // A worker is not resumed here. Its next dispatch (work.ts) queues the input.
        resumeText: (s) => (s.kind === 'worker' ? null : RESUME_PROMPT),
        summaryExtra: (s) => (s.kind === 'orchestrator' ? { autoWakePaused: this.orchestrator.autoWakePaused() } : {}),
        now: this.now,
      });
      this.work = new Work({
        backlog: this.backlog,
        workflow: this.workflow,
        turns: this.turns,
        git,
        publisher,
        definition: () => this.definition,
        notify: (kind, text, itemId) => {
          this.orchestrator.push(kind, text, itemId);
        },
        slotsChanged: () => {
          this.emitCapacity();
          this.scheduler.request();
        },
        requestTick: () => this.scheduler.request(),
        reprovisioning: () => this.reprovisioning,
        issueContext: (item) => this.github.issueContext(item),
        published: (itemId) => this.github.published(itemId),
        log,
        now: this.now,
      });
      this.github = new GithubSync({
        api: new GitHubApi({ grantFor: (owner) => this.credentials.grantFor(owner), apiBase, now: this.now }),
        backlog: this.backlog,
        work: this.work,
        store: githubStore(paths.state),
        definition: () => this.definition,
        envId: () => this.instance.get()?.envId ?? '',
        notify: (kind, text, itemId) => {
          this.orchestrator.push(kind, text, itemId);
        },
        canRun: () => this.running() && !this.journalFailing(),
        mergeParents: (item, sha) => {
          const repo = this.definition?.repos.find((r) => r.dir === item.repo);
          if (!repo) return Promise.resolve([]);
          return git.serial(repo.dir, () => git.commitParents(repo.dir, repo.github, sha));
        },
        log,
        now: this.now,
      });
      this.scheduler = new Scheduler({
        view: () => this.schedulerView(),
        canRun: () => this.running() && !this.reprovisioning && !this.journalFailing(),
        start: (stepId) => this.work.dispatch(stepId),
        log,
      });
      this.tools = orchestratorTools({
        work: this.work,
        backlog: this.backlog,
        workflow: { workflow: (itemId) => this.workflow.workflow(itemId) },
        definition: () => this.definition,
        instance: () => {
          const record = this.instance.get();
          return { name: record?.name ?? '', pin: record?.pin ?? null, sha: record?.sha ?? null };
        },
        running: () => {
          const view = this.schedulerView();
          return view ? runningCounts(view).perAgent : {};
        },
        github: this.github,
        journalFailing: () => this.journalFailing(),
      });
    }
    this.server = new DaemonServer({
      socketPath: paths.socket,
      log,
      events: this.events,
      identity: () => ({
        envId: this.instance?.get()?.envId ?? '',
        version: this.opts.identity.daemonVersion,
        build: this.opts.identity.build,
      }),
      dispatch: (op, args, ctx) => this.dispatch(op as Op, args, ctx),
      snapshotV1: () => projectSnapshot(this.snapshot()),
      projection: () => ({
        item: (itemId) => {
          const item = this.backlog?.get(itemId);
          return item ? this.pub(item) : null;
        },
        capacity: () => capacityOf(this.schedulerView(), this.scheduler?.isPaused() ?? false),
        formatBoundary: this.formatBoundary,
      }),
    });
    await this.server.listen();
    log.info('daemon.listening', { version: this.opts.identity.daemonVersion, protocol: PROTOCOL_VERSION });

    if (!migrated.ok) return this.fail(migrated.error);
    if (this.journalError) return this.fail(this.journalError);
    this.setState({ status: 'provisioning', detail: 'reading the inbox' });
    this.credentials.ingestInbox((update) => this.applyInstance(update));
    this.emitGithubAuth(true);
    this.githubTimer = setInterval(() => this.emitGithubAuth(false), GITHUB_CHECK_MS);
    this.githubTimer.unref?.();

    const record = this.instance.get();
    if (!record) return this.fail('No environment definition has been delivered to this container.');
    const def = readDefinition(record.definition);
    if (!def.ok) return this.fail(`The environment definition is invalid: ${def.error}`);
    this.definition = def.value;

    try {
      await this.provisionNow(record, def.value);
    } catch (err) {
      const stage = err instanceof ProvisionError ? err.stage : this.state.stage;
      return this.fail((err as Error).message, stage);
    }
    this.homeReady = true;

    const interrupted = this.turns.reconcile();
    const requeued = this.work.reconcile();
    const requeuedInputs = this.work.requeueInputs(this.bootInputs);
    this.bootInputs = new Map();
    this.ensureOrchestrator(def.value);
    const resumed = this.turns.resumeInterrupted();
    this.restartNotice(resumed, requeued);
    this.turns.startRestored();
    this.setState({ status: 'ready' });
    this.emitCapacity();
    this.scheduler.start();
    this.orchestrator.schedule();
    this.github.start();
    log.info('daemon.ready', { envId: record.envId, interrupted: interrupted.length, requeued: requeued.length, requeuedInputs });
  }

  /**
   * Open the delivery journal and bring both checkpoints up to it: repair
   * a torn tail, roll items.json and delivery/tables.json forward, journal
   * the legacy workflows once after the format-2 migration, and keep the
   * inputs of implement steps that are not done for the boot's re-queue.
   * A damaged journal leaves the daemon failed.
   */
  private openLedger(): void {
    const { paths, log } = this.opts;
    let boot: DeliveryBoot;
    try {
      boot = bootDelivery({
        file: path.join(paths.state, 'delivery', 'journal.ndjson'),
        items: this.itemsFile,
        tables: this.tablesFile,
        emit: (ev) => this.emit(ev),
        log,
        now: this.now,
        io: this.opts.journalIO,
      });
    } catch (err) {
      if (err instanceof CheckpointAheadError) {
        this.journalError = err.message;
        log.error('journal.checkpoint-ahead', undefined, { journalSeq: err.journalSeq, head: err.head });
        return;
      }
      if (!(err instanceof JournalDamagedError)) throw err;
      this.journalError = err.message;
      log.error('journal.damaged', undefined, { line: err.line });
      return;
    }
    this.journal = boot.journal;
    this.workflow = boot.workflow;
    boot.journal.onFailing(() => this.journalFailed());
    const transactions = boot.transactions;
    const bootstrapped = bootstrapLegacy(this.workflow, this.backlog.list(), this.itemsFile.get().nextNumber);
    if (bootstrapped || !transactions.length) log.info('journal.bootstrap', { tickets: bootstrapped });
    const active = new Set<string>();
    for (const wf of Object.values(this.tablesFile.get().workflows)) {
      for (const step of latestAttempts(wf.steps)) if (step.kind === 'implement' && step.state !== 'done') active.add(step.id);
    }
    for (const tx of transactions) {
      for (const ev of asLedgerEvents(tx)) {
        if (ev.kind !== 'step.input' || !active.has(ev.stepId)) continue;
        const list = this.bootInputs.get(ev.stepId) ?? [];
        list.push({ at: tx.at, sessionId: ev.sessionId, author: ev.author, text: ev.text });
        this.bootInputs.set(ev.stepId, list);
      }
    }
  }

  private pub(item: ItemRecord): WorkItem {
    return publicItem(item, this.workflow?.workflow(item.id) ?? null);
  }

  /** Tell the orchestrator what a restart interrupted and how it resumes. */
  private restartNotice(resumed: SessionRecord[], requeued: ReturnType<Work['reconcile']>): void {
    const parts: string[] = [];
    const turns = resumed.filter((s) => s.kind === 'orchestrator');
    if (turns.length) parts.push(`interrupted turns were resumed (${turns.map(() => 'the orchestrator').join(', ')})`);
    if (requeued.length) {
      const list = requeued.map((i) => `${itemLabel(i)} "${i.title}"`).join(', ');
      parts.push(`requeued without counting an attempt, each continuing its existing worker session: ${list}`);
    }
    if (parts.length) this.orchestrator.push('environment.restarted', `The environment restarted; ${parts.join('; ')}.`);
  }

  /** The environment takes work: ready (or degraded after a failed update) and not stopping. */
  private running(): boolean {
    return (this.state.status === 'ready' || this.state.status === 'degraded') && this.phase === 'serving';
  }

  /** Run the provisioning stages for a definition and record their fingerprints. */
  private async provisionNow(record: InstanceRecord, def: DaemonDefinition): Promise<void> {
    const test = testAdapters !== null;
    const stages = await provision({
      paths: this.opts.paths,
      log: this.opts.log,
      run: this.run,
      credentials: this.credentials,
      definition: def,
      sha: record.sha,
      skipPackages: test && this.opts.env.PUCK_SKIP_PACKAGES === '1',
      gitBase: (test && this.opts.env.PUCK_TEST_GIT_BASE) || 'https://github.com/',
      prior: record.provisioned?.stages ?? {},
      privileged: this.opts.privileged,
      onStage: (stage, detail) => this.onStage(stage, detail),
    });
    record.provisioned = { fingerprint: provisionFingerprint(record.sha, stages), at: this.now(), stages };
    this.instance.save();
  }

  /* ---------- Definition updates ---------- */

  /**
   * Apply a new resolution of this environment's definition (`UpdateClass`
   * in src/harness/definitions/types.ts). Hot changes take effect with the
   * next turn and dispatch. While a reprovision runs, the scheduler does
   * not start work. A change that needs a rebuild is refused: the app
   * recreates the container itself.
   */
  private async applyDefinition(raw: unknown, pin: Pin): Promise<{ classes: string[] }> {
    if (!this.running()) throw new OpError('not-ready', 'The environment is still starting.');
    if (this.reprovisioning || this.applyingDefinition) throw new OpError('invalid-state', 'An update is already being applied.');
    this.applyingDefinition = true;
    try {
      const record = this.instance.get();
      const prev = this.definition;
      if (!record || !prev) throw new OpError('not-ready', 'The environment is still starting.');
      const parsed = readDefinition(raw);
      if (!parsed.ok) throw new OpError('invalid-args', `The definition is invalid: ${parsed.error}`);
      const next = parsed.value;
      if (next.name !== prev.name) throw new OpError('invalid-args', `This environment runs "${prev.name}", not "${next.name}".`);
      const changes = definitionChanges(record.definition, prev, raw, next);
      const classes = changeClasses(changes);
      if (classes.includes('rebuild')) {
        const fields = changes.filter((c) => c.class === 'rebuild').map((c) => c.field);
        throw new OpError('invalid-state', `This update needs the environment rebuilt (${fields.join(', ')}).`);
      }
      await this.syncGrant(record, prev, next);
      this.applyInstance({ envId: record.envId, name: record.name, pin, sha: pin.sha, definition: raw });
      this.definition = next;
      this.opts.log.info('definition.apply', { sha: pin.sha, classes, changes: changes.length });
      this.emit({
        kind: 'instance.definition',
        sha: pin.sha,
        pin,
        classes,
        repos: next.repos.map((r) => ({ github: r.github, dir: r.dir })),
      });
      if (changes.length) {
        const shown = changes.slice(0, 8).map((c) => c.summary);
        const more = changes.length > shown.length ? `; and ${changes.length - shown.length} more` : '';
        this.orchestrator.push(
          'definition.applied',
          `The environment definition was updated to ${pin.name} (${pin.sha.slice(0, 7)}): ${shown.join('; ')}${more}.`,
        );
      }
      this.ensureOrchestrator(next);
      this.emitCapacity();
      this.scheduler.request();
      if (classes.includes('reprovision')) {
        this.reprovisioning = true;
        void this.reprovision();
      }
      return { classes };
    } finally {
      this.applyingDefinition = false;
    }
  }

  /**
   * Store the next definition's token permissions on the server before the
   * definition is applied. The instance is marked unsure first, so a reply
   * lost after the server committed (or a crash) makes the next apply sync
   * even when its permissions look unchanged. A failed sync puts the
   * previous permissions back, best effort, and refuses the apply.
   */
  private async syncGrant(record: InstanceRecord, prev: DaemonDefinition, next: DaemonDefinition): Promise<void> {
    const prevPolicies = tokenPoliciesFrom(prev.policies.github);
    const nextPolicies = tokenPoliciesFrom(next.policies.github);
    if (!record.grantUnsure && sameTokenPermissions(prevPolicies, nextPolicies)) return;
    const { env } = this.opts;
    if (!grantSyncConfigured(env)) return syncGrantPolicies(env, record.envId, nextPolicies);
    if (!record.grantUnsure) {
      this.instance.set({ ...record, grantUnsure: true });
      this.instance.commit();
    }
    try {
      await syncGrantPolicies(env, record.envId, nextPolicies, this.grantSyncTimeoutMs);
    } catch (err) {
      try {
        await syncGrantPolicies(env, record.envId, prevPolicies, this.grantSyncTimeoutMs);
        const current = this.instance.get();
        if (current) {
          this.instance.set({ ...current, grantUnsure: false });
          this.instance.commit();
        }
      } catch {
        this.opts.log.warn('definition.grant-unsure', { envId: record.envId });
      }
      throw err;
    }
  }

  private async reprovision(): Promise<void> {
    const { log } = this.opts;
    try {
      await this.turns.idle();
      await this.work.idlePrepares();
      const record = this.instance.get();
      const def = this.definition;
      if (this.phase !== 'serving' || !record || !def) return;
      // Hold every repository's git chain: the mirror fetch (--prune) must not
      // race a publish that has fetched a branch from its bundle but not pushed it.
      const locked = def.repos.reduce<() => Promise<void>>(
        (inner, repo) => () => this.git.serial(repo.dir, inner),
        () => this.provisionNow(record, def),
      );
      await locked();
      this.setState({ status: 'ready' });
    } catch (err) {
      log.error('definition.reprovision-failed', err);
      const stage = err instanceof ProvisionError ? err.stage : undefined;
      if (this.phase === 'serving') {
        this.setState({ status: 'degraded', ...(stage ? { stage } : {}), error: `The update could not be provisioned: ${(err as Error).message}` });
      }
    } finally {
      this.reprovisioning = false;
      if (this.phase === 'serving') this.turns.startRestored();
      this.emitCapacity();
      this.scheduler.request();
      this.orchestrator.schedule();
    }
  }

  private onStage(stage: ProvisionStage, detail?: string): void {
    if (PROVISION_STAGES.indexOf(stage) > PROVISION_STAGES.indexOf('creating-user')) this.homeReady = true;
    this.setState({ status: 'provisioning', stage, ...(detail ? { detail } : {}) });
  }

  private applyInstance(update: Pick<InstanceRecord, 'envId' | 'name' | 'pin' | 'sha' | 'definition'>): void {
    const current = this.instance.get();
    if (current && current.envId !== update.envId) {
      throw new Error(`this container belongs to ${current.envId}, not ${update.envId}`);
    }
    const history = current?.history ?? [];
    if (!current || current.sha !== update.sha) history.push({ sha: update.sha, pin: update.pin, appliedAt: this.now() });
    this.instance.set({ ...update, history, provisioned: current?.provisioned ?? null, grantUnsure: false });
    this.instance.commit();
  }

  private ensureOrchestrator(def: DaemonDefinition): void {
    const open = this.turns.orchestrator();
    if (open && open.agent === def.orchestrator.agent) return;
    if (open) this.turns.close(open.id); // stays readable; a new orchestrator takes over
    this.turns.create({
      kind: 'orchestrator',
      agent: def.orchestrator.agent,
      harness: def.agentDefs[def.orchestrator.agent].harness,
      cwd: this.opts.paths.workspace,
    });
  }

  private fail(error: string, stage?: ProvisionStage): void {
    this.opts.log.error('daemon.failed', undefined, { stage, error });
    this.setState({ status: 'failed', ...(stage ? { stage } : {}), error });
  }

  private setState(next: InstanceState): void {
    // A failing journal keeps the environment degraded: it serves reads but refuses every change.
    this.state = next.status === 'ready' && this.journalFailing() ? { status: 'degraded', error: JOURNAL_FAILING } : next;
    this.emit({ kind: 'instance.status', ...this.state });
  }

  /** True once the delivery journal could not undo a failed write (6.6). */
  private journalFailing(): boolean {
    return this.workflow?.failing() ?? false;
  }

  private journalFailed(): void {
    if (this.state.status === 'ready' || this.state.status === 'degraded') this.setState({ status: 'degraded', error: JOURNAL_FAILING });
  }

  /** Emits `github.auth` when the state changed since the last one (or always, when forced). */
  private emitGithubAuth(force: boolean): void {
    const auth = this.credentials.githubAuth();
    const shown = JSON.stringify(auth);
    if (!force && shown === this.githubShown) return;
    this.githubShown = shown;
    this.emit({ kind: 'github.auth', ...auth });
  }

  private emit(ev: DaemonEvent): void {
    if (!this.events.append(ev)) throw new Error('The event log could not record an event.');
    if (ev.kind === 'item.upsert') this.github?.itemChanged(ev.item);
  }

  /* ---------- Agents, env, notices ---------- */

  /**
   * The effective agent of a session: a worker's agent plus its assignment's
   * instructions; the orchestrator's agent plus the orchestration preamble.
   */
  private agentFor(session: SessionRecord): DaemonAgent | null {
    const def = this.definition;
    const agent = def?.agentDefs[session.agent];
    if (!def || !agent) return null;
    const extra =
      session.kind === 'worker' ? def.agents.find((a) => a.agent === session.agent)?.instructions ?? '' : orchestratorPreamble(def);
    return { ...agent, instructions: [agent.instructions, extra].filter(Boolean).join('\n\n') };
  }

  private harnessEnv(): Record<string, string> {
    const def = this.definition;
    const stored = this.credentials.envSecrets();
    const secrets: Record<string, string> = {};
    for (const name of def?.secrets ?? []) if (name in stored) secrets[name] = stored[name];
    return harnessEnv({ home: this.opts.paths.home, lang: this.opts.env.LANG, definitionEnv: def?.env, secrets });
  }

  private schedulerView(): SchedulerView | null {
    const def = this.definition;
    if (!def || !this.backlog || !this.workflow) return null;
    const steps: SchedulerStep[] = [];
    this.backlog.list().forEach((item, order) => {
      for (const step of latestAttempts(this.workflow.steps(item.id))) {
        if (step.state === 'done' || (step.kind !== 'implement' && step.kind !== 'checks' && step.kind !== 'review')) continue;
        const verification = step.kind !== 'implement';
        steps.push({
          id: step.id,
          itemId: item.id,
          kind: step.kind,
          state: step.state,
          agent: step.agent,
          tier: verification ? 0 : item.status === 'in-progress' ? 1 : 2,
          order: verification ? (step.queuedAt ?? 0) : order,
        });
      }
    });
    return {
      steps,
      assignments: Object.fromEntries(def.agents.map((a) => [a.agent, a.maxParallel])),
      maxWorkers: def.limits.maxWorkers,
    };
  }

  private emitCapacity(): void {
    this.emit({ kind: 'capacity', ...capacityOf(this.schedulerView(), this.scheduler?.isPaused() ?? false) });
  }

  private async turnEnded(session: SessionRecord, outcome: TurnOutcome): Promise<void> {
    if (session.kind === 'worker') {
      await this.work.workerTurnEnded(session, outcome);
      return;
    }
    this.work.orchestratorTurnEnded(outcome);
    this.orchestrator.turnEnded();
  }

  /* ---------- Commands ---------- */

  private dispatch(op: Op, args: unknown, ctx: OpContext = { protocol: PROTOCOL_VERSION }): Promise<unknown> {
    if (this.state.status === 'failed' && !FAILED_OPS.has(op)) {
      return Promise.reject(new OpError('not-ready', `The environment failed: ${this.state.error ?? 'unknown error'}`));
    }
    if (this.phase !== 'serving' && op !== 'snapshot.get' && op !== 'logs.tail') {
      return Promise.reject(new OpError('not-ready', 'The environment daemon is stopping.'));
    }
    if (READY_OPS.has(op) && !this.running()) {
      return Promise.reject(new OpError('not-ready', 'The environment is still starting.'));
    }
    if (this.journalFailing() && !JOURNAL_FAILING_OPS.has(op)) return Promise.reject(new OpError('not-ready', JOURNAL_FAILING));
    return dispatch(this.handlers, op, args, ctx).catch((err: unknown) => {
      if (err instanceof TurnsError || err instanceof WorkError || err instanceof JournalError) throw new OpError(err.code, err.message);
      if (err instanceof ItemStateError || err instanceof StepStateError) throw new OpError('invalid-state', err.message);
      throw err;
    });
  }

  /** Item ops need the backlog, which exists once state migrated. */
  private get items(): Work {
    if (!this.work || !this.definition) throw new OpError('not-ready', 'The environment is still starting.');
    return this.work;
  }

  private readonly handlers: Handlers = {
    'snapshot.get': () => this.parts.freeze(this.snapshot()),
    'snapshot.part': ({ cursor }) => this.parts.next(cursor),
    'session.history': ({ sessionId, before, limit }) => {
      if (!this.turns?.get(sessionId)) throw new OpError('not-found', `No session ${sessionId}.`);
      // Held text-deltas get their seq first, so the page holds exactly the events up to head.
      this.events.flush();
      return { ...this.transcripts.page(sessionId, before, limit ?? COMMAND_LIMITS.historyDefault), head: this.events.head() };
    },
    'chat.send': ({ sessionId, text }) => {
      const target = sessionId ?? this.turns.orchestrator()?.id;
      if (!target) throw new OpError('not-ready', 'This environment has no orchestrator session yet.');
      const session = this.turns.get(target);
      if (session?.kind === 'worker') {
        const item = session.itemId ? this.backlog.get(session.itemId) : null;
        if (!item || item.sessionId !== session.id) throw new OpError('invalid-state', 'This worker session no longer belongs to a work item.');
        return this.items.followUp(item.id, text, 'user');
      }
      if (session?.kind === 'orchestrator') this.orchestrator.userMessage();
      return this.turns.send(target, text, 'user');
    },
    'session.interrupt': ({ sessionId }) => {
      if (!this.turns?.get(sessionId)) throw new OpError('not-found', `No session ${sessionId}.`);
      this.turns.interrupt(sessionId);
      return {};
    },
    'ask.answer': ({ sessionId, askId, answers }) => {
      if (!this.turns?.answer(sessionId, askId, answers)) throw new OpError('not-found', 'That question is no longer open.');
      return {};
    },
    'item.create': ({ title, body, agent, repo, position, links }) => this.pub(this.items.create({ title, body, agent, repo, position, links }, 'user')),
    'item.update': ({ itemId, title, body, repo }) =>
      this.pub(
        this.items.update(
          itemId,
          { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}), ...(repo !== undefined ? { repo } : {}) },
          'user',
        ),
      ),
    'item.move': ({ itemId, position }) => ({ order: this.items.move(itemId, position) }),
    'item.assign': ({ itemId, agent }) => this.pub(this.items.assign(itemId, agent, 'user')),
    'item.cancel': ({ itemId }) => this.pub(this.items.cancel(itemId, 'user')),
    'item.retry': ({ itemId }) => this.pub(this.items.retry(itemId, 'user')),
    'item.accept': ({ itemId, reason }) => this.pub(this.items.accept(itemId, undefined, 'user', reason)),
    'item.link': ({ itemId, ref }) => this.pub(this.items.link(itemId, ref)),
    'item.unlink': ({ itemId, referenceId }) => this.pub(this.items.unlink(itemId, referenceId)),
    'item.workflow': ({ itemId, round }) => this.itemWorkflow(itemId, round),
    'item.records': (args) => this.itemRecords(args),
    'item.publish': ({ itemId }) => this.items.publish(itemId, {}, 'user'),
    'issue.import': async ({ repo, number, agent, position }) => {
      if (!this.work || !this.definition) throw new OpError('not-ready', 'The environment is still starting.');
      return this.pub(await this.github.importIssue(repo, number, { agent, position }, 'user'));
    },
    'issue.search': async ({ query, repo, state }) => {
      if (!this.work || !this.definition) throw new OpError('not-ready', 'The environment is still starting.');
      return this.github.searchIssues(query, { ...(repo ? { repo } : {}), ...(state ? { state } : {}) });
    },
    'item.pr': ({ itemId }) => this.github.prView(this.items.item(itemId)),
    'github.nudge': ({ repo, kind, number }) => {
      this.github?.nudge(repo, kind, number);
      return {};
    },
    'item.delete': async ({ itemId }) => {
      await this.items.remove(itemId);
      return {};
    },
    'definition.apply': ({ definition, pin }) => this.applyDefinition(definition, pin),
    'credentials.put': async ({ harness }) => {
      for (const { id, content } of harness) {
        try {
          if (content === null) await this.credentials.removeHarness(id);
          else await this.credentials.putHarness(id, content, this.homeReady);
        } catch (err) {
          throw new OpError('invalid-args', (err as Error).message);
        }
      }
      return {};
    },
    'credentials.get': async () => {
      const ids = this.definition ? referencedHarnesses(this.definition) : harnessDescriptors.map((d) => d.id);
      return { harness: await this.credentials.getHarness(ids) };
    },
    'github.put': ({ grants }) => {
      if (!this.credentials.putGithub(grants)) throw new OpError('invalid-args', 'Those are not usable GitHub installation token grants.');
      this.emitGithubAuth(true);
      this.github?.grantsArrived();
      return {};
    },
    'secrets.put': ({ values }) => {
      if (!this.credentials.putSecrets(values)) throw new OpError('invalid-args', 'Secret names or values are invalid.');
      return {};
    },
    'scheduler.pause': () => {
      this.scheduler?.pause();
      this.emitCapacity();
      return {};
    },
    'scheduler.resume': () => {
      this.scheduler?.resume();
      this.emitCapacity();
      return {};
    },
    'daemon.upgrade': ({ mode }) => this.upgrade(mode),
    'logs.tail': ({ lines }) => ({ text: tailLog(this.opts.log, lines) }),
  };

  snapshot(): Snapshot {
    this.events.flush(); // held text-deltas get their seq before head is read
    const record = this.instance?.get() ?? null;
    const sessions = this.turns ? this.turns.list() : [];
    return {
      envId: record?.envId ?? '',
      name: record?.name ?? '',
      daemon: { version: this.opts.identity.daemonVersion, build: this.opts.identity.build, protocol: PROTOCOL_VERSION },
      head: this.events.head(),
      instance: { ...this.state, pin: record?.pin ?? null, sha: record?.sha ?? null },
      github: this.credentials.githubAuth(),
      sessions: sessions.map((s) => this.turns.summary(s)),
      orchestratorSessionId: this.turns?.orchestrator()?.id ?? null,
      items: this.backlog && this.workflow ? this.backlog.list().map((i) => this.pub(i)) : [],
      order: this.backlog ? this.backlog.order() : [],
      capacity: capacityOf(this.schedulerView(), this.scheduler?.isPaused() ?? false),
      inflight: this.turns ? this.turns.inflight() : [],
      asks: this.turns ? this.turns.openAsks() : [],
      decisions: [],
      repos: this.definition ? this.definition.repos.map((r) => ({ github: r.github, dir: r.dir })) : [],
    };
  }

  /** One round of a ticket's workflow (the newest by default) with the latest attempt of each step. */
  private itemWorkflow(itemId: string, round?: number): OpResult<'item.workflow'> {
    const item = this.items.item(itemId);
    const wf = this.workflow.workflow(item.id);
    const empty = { reviews: [], decisions: [], findingsTotal: 0 };
    if (!wf || !wf.rounds.length) return { roundsTotal: 0, round: null, steps: [], stepsCursor: null, ...empty };
    const info = round === undefined ? latestRound(wf.rounds) : wf.rounds.find((r) => r.round === round);
    if (!info) throw new OpError('not-found', `${itemLabel(item)} has no round ${round ?? ''}.`);
    const steps = roundSteps(wf.steps, info.round);
    const shown = steps.slice(0, PAGE_LIMITS.workflowSteps);
    return {
      roundsTotal: wf.rounds.length,
      round: info,
      steps: shown,
      stepsCursor: steps.length > shown.length ? String(shown.length) : null,
      ...empty,
    };
  }

  /**
   * A ticket's growing collections, paged at a stable boundary: records are
   * append-only in journal order, so the cursor (the next record's
   * position) never shows one twice. Pages stay below 512 KiB and hold at
   * least one record. Reviews, findings, decisions, trails and audits
   * arrive with later phases and are empty.
   */
  private itemRecords(args: OpArgs<'item.records'>): OpResult<'item.records'> {
    const item = this.items.item(args.itemId);
    const wf = this.workflow.workflow(item.id);
    let all: unknown[] = [];
    if (wf && args.kind === 'rounds') all = wf.rounds;
    if (wf && args.kind === 'steps') {
      all = args.round === undefined ? wf.steps : wf.steps.filter((s) => s.round === args.round);
    }
    const start = args.cursor === undefined ? 0 : Number.parseInt(args.cursor, 10);
    if (!Number.isInteger(start) || start < 0) throw new OpError('invalid-args', 'cursor is not a cursor this op returned.');
    const limit = args.limit ?? PAGE_LIMITS.recordsLimit;
    const records: unknown[] = [];
    let bytes = 0;
    let at = start;
    for (; at < all.length && records.length < limit; at++) {
      const size = Buffer.byteLength(JSON.stringify(all[at]), 'utf8') + 1;
      if (records.length && bytes + size > PAGE_LIMITS.pageBytes - 1024) break;
      records.push(all[at]);
      bytes += size;
    }
    return { records, nextCursor: at < all.length ? String(at) : null };
  }

  /* ---------- Upgrade and shutdown ---------- */

  /**
   * Swap in the bundle staged at puckd.next.js. Refused unless the daemon
   * is serving and ready (or degraded after a failed update). Stops taking input, waits for running turns
   * (drain) or interrupts them within the shutdown grace (now), then
   * persists, renames the bundle into place, and exits 75. The response
   * goes out before that work. If the grace runs out, or persist or the
   * rename fails, the cause is logged and the process exits nonzero: the
   * container restarts on the current bundle, and restart recovery keeps
   * queued input. The staged bundle is used only when the rename completed.
   */
  private upgrade(mode: 'drain' | 'now'): Record<string, never> {
    if (this.phase !== 'serving') throw new OpError('invalid-state', 'An upgrade or shutdown is already in progress.');
    if (!this.running()) throw new OpError('not-ready', 'The environment is still starting.');
    const { paths, log } = this.opts;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(paths.nextBundle);
    } catch {
      throw new OpError('invalid-state', 'No new daemon bundle is staged.');
    }
    if (!st.isFile() || st.size === 0) throw new OpError('invalid-state', 'The staged daemon bundle is not a file.');
    this.phase = 'upgrading';
    try {
      this.emit({ kind: 'daemon.upgrading', mode });
      log.info('daemon.upgrade', { mode });
      this.turns?.stopAccepting();
      this.scheduler?.stop();
      this.orchestrator?.stop();
      this.github?.stop();
    } catch (err) {
      log.error('daemon.upgrade-failed', err);
      void this.finishExit(1);
      throw err;
    }
    setImmediate(() => {
      void this.completeUpgrade(mode);
    });
    return {};
  }

  private async completeUpgrade(mode: 'drain' | 'now'): Promise<void> {
    const { paths, log } = this.opts;
    let code = 1;
    try {
      if (mode === 'now') {
        if (!(await this.interruptWithinGrace())) {
          throw new Error('A running turn did not finish before the upgrade grace deadline.');
        }
      } else {
        await this.turns?.idle();
      }
      this.setState({ status: 'stopping', detail: 'upgrading' });
      await this.persist();
      fs.renameSync(paths.nextBundle, paths.bundle);
      code = UPGRADE_EXIT;
    } catch (err) {
      log.error('daemon.upgrade-failed', err);
      try {
        await this.persist();
      } catch (persistErr) {
        log.error('daemon.upgrade-failed', persistErr);
      }
    }
    await this.finishExit(code);
  }

  /**
   * SIGTERM or SIGINT. An upgrade already in progress owns the exit.
   * A repeat signal is ignored once shutdown has started; persist failure
   * still exits, with a nonzero code.
   */
  async shutdown(): Promise<void> {
    if (this.exited || this.phase === 'shutting-down' || this.phase === 'upgrading') return;
    await this.beginShutdown();
  }

  private async beginShutdown(): Promise<void> {
    if (this.exited || this.phase === 'shutting-down') return;
    this.phase = 'shutting-down';
    this.server?.stopAccepting();
    this.turns?.stopAccepting();
    this.scheduler?.stop();
    this.orchestrator?.stop();
    this.github?.stop();
    this.opts.log.info('daemon.shutdown');
    let code = 0;
    try {
      this.setState({ status: 'stopping' });
      await this.interruptWithinGrace();
      await this.persist();
    } catch (err) {
      this.opts.log.error('daemon.shutdown-failed', err);
      code = 1;
    }
    await this.finishExit(code);
  }

  /** True when every interrupted turn finished before the grace elapsed. */
  private interruptWithinGrace(): Promise<boolean> {
    const pending = this.turns?.interruptAll() ?? Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.shutdownGraceMs);
      timer.unref?.();
    });
    return Promise.race([pending.then(() => true), timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private async finishExit(code: number): Promise<void> {
    if (this.exited) return;
    if (this.githubTimer) clearInterval(this.githubTimer);
    this.journal?.close();
    try {
      await this.server?.close();
    } catch (err) {
      this.opts.log.error('daemon.shutdown-failed', err);
    }
    if (this.exited) return;
    this.exited = true;
    this.opts.log.info('daemon.exit', { code });
    this.opts.exit(code);
  }

  private async persist(): Promise<void> {
    this.events?.flush();
    this.instance?.save();
    this.tablesFile?.save();
    await this.transcripts?.flush();
    await flushJsonWrites();
  }
}
