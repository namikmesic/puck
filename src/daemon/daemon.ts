/**
 * The daemon itself: the boot sequence, the command handlers, shutdown and
 * upgrade. main.ts takes the lock and wires process signals; everything
 * else starts here.
 *
 * Boot: migrate the state format (a failure leaves the daemon `failed`,
 * answering only the handshake, snapshots and logs) → open the socket so
 * the app can watch → ingest the inbox → provision → reconcile what a
 * restart interrupted (sessions become interrupted; running work items go
 * back to queued without counting an attempt) → make sure the orchestrator
 * session exists → resume those turns → ready → start the scheduler and
 * the orchestrator's wake loop.
 *
 * Orchestration lives in its own modules: items.ts (state machine and
 * backlog), scheduler.ts, work.ts (dispatch, worktrees, results, worker
 * questions), publish.ts, orchestrator.ts (notices and wake) and tools.ts
 * (the orchestrator's in-process tools). This class wires them to the turn
 * loop and to the protocol's commands.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PROTOCOL_VERSION,
  PROVISION_STAGES,
  UPGRADE_EXIT,
  COMMAND_LIMITS,
  type DaemonEvent,
  type InstanceState,
  type Op,
  type Pin,
  type ProvisionStage,
  type Snapshot,
} from '../harness/daemon-protocol';
import { harnessDescriptors } from '../harness/providers';
import { Credentials } from './credentials';
import {
  changeClasses,
  definitionChanges,
  readDefinition,
  referencedHarnesses,
  type DaemonAgent,
  type DaemonDefinition,
} from './definition';
import { EventLog } from './eventlog';
import { runCommand, type CommandRunner } from './exec';
import { createAdapters } from './harness';
import { harnessEnv } from './harness/spawn';
import type { HarnessAdapter, OrchestratorTool } from './harness/types';
import { testAdapters } from './harness/test-adapters';
import { Git } from './git';
import { Backlog, itemLabel, ItemStateError, publicItem } from './items';
import { tailLog, type Logger } from './log';
import { dispatch, OpError, type Handlers } from './ops';
import { Orchestrator } from './orchestrator';
import { orchestratorPreamble } from './prompts';
import { Publisher } from './publish';
import { capacityOf, runningCounts, Scheduler, type SchedulerView } from './scheduler';
import { itemsStore } from './store/items';
import type { SessionRecord } from './store/sessions';
import { orchestratorTools } from './tools';
import { Work, WorkError } from './work';
import { PUCK_GID, PUCK_UID, type DaemonPaths } from './paths';
import { provision, provisionFingerprint, ProvisionError } from './provision';
import { DaemonServer } from './server';
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
}

/** Ops a failed daemon still answers. */
const FAILED_OPS: ReadonlySet<Op> = new Set<Op>(['snapshot.get', 'logs.tail']);
/** Ops that need a ready environment. */
const READY_OPS: ReadonlySet<Op> = new Set<Op>(['chat.send', 'credentials.get', 'daemon.upgrade']);

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
  private work!: Work;
  private scheduler!: Scheduler;
  private orchestrator!: Orchestrator;
  private tools: OrchestratorTool[] = [];
  private git!: Git;
  /** True while a reprovision is waiting or provisioning. */
  private reprovisioning = false;
  private homeReady = false;
  private phase: DaemonPhase = 'serving';
  private exited = false;
  private readonly run: CommandRunner;
  private readonly now: () => number;
  private readonly shutdownGraceMs: number;

  constructor(private readonly opts: DaemonOptions) {
    this.run = opts.run ?? runCommand;
    this.now = opts.now ?? Date.now;
    this.shutdownGraceMs = opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  }

  /* ---------- Boot ---------- */

  async start(): Promise<void> {
    const { paths, log } = this.opts;
    for (const dir of [paths.state, paths.run]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(paths.state, 0o700);
    fs.chmodSync(paths.run, 0o755);
    reportWriteErrors((file, err) => log.error('store.write', err, { file }));

    const migrated = migrateState(paths.state, { daemonVersion: this.opts.identity.daemonVersion, now: this.now() });
    this.events = new EventLog(paths.events, { now: this.now, log });
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
      this.backlog = new Backlog({ store: itemsStore(paths.state), emit: (ev) => this.emit(ev), now: this.now });
      const asPuck = this.opts.privileged ? { uid: PUCK_UID, gid: PUCK_GID } : {};
      const git = (this.git = new Git({ paths, run: this.run, asPuck }));
      const test = testAdapters !== null;
      const publisher = new Publisher({
        git,
        tmpDir: path.join(paths.state, 'tmp'),
        grantFor: (owner) => this.credentials.grantFor(owner),
        definition: () => this.definition,
        envName: () => this.instance.get()?.name || this.definition?.name || '',
        apiBase: (test && this.opts.env.PUCK_TEST_GITHUB_API) || undefined,
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
        canWake: () => this.running(),
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
        log,
        agentFor: (s) => this.agentFor(s),
        envFor: () => this.harnessEnv(),
        peekNotices: () => this.orchestrator.pending(),
        commitNotices: (count) => this.orchestrator.commit(count),
        canStart: (s) => this.work.canStart(s),
        onTurnEnd: (s, outcome) => this.turnEnded(s, outcome),
        routeAsk: (s, askId, questions) => this.work.routeAsk(s, askId, questions),
        onAskClosed: (s, askId) => this.work.askClosed(s, askId),
        // A worker resumes when the scheduler dispatches it again, with its own continue input.
        resumeText: (s) => (s.kind === 'worker' ? null : RESUME_PROMPT),
        summaryExtra: (s) => (s.kind === 'orchestrator' ? { autoWakePaused: this.orchestrator.autoWakePaused() } : {}),
        now: this.now,
      });
      this.work = new Work({
        backlog: this.backlog,
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
        log,
        now: this.now,
      });
      this.scheduler = new Scheduler({
        view: () => this.schedulerView(),
        canRun: () => this.running() && !this.reprovisioning,
        dispatch: (itemId) => this.work.dispatch(itemId),
        log,
      });
      this.tools = orchestratorTools({
        work: this.work,
        backlog: this.backlog,
        definition: () => this.definition,
        instance: () => {
          const record = this.instance.get();
          return { name: record?.name ?? '', pin: record?.pin ?? null, sha: record?.sha ?? null };
        },
        running: () => {
          const view = this.schedulerView();
          return view ? runningCounts(view).perAgent : {};
        },
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
      dispatch: (op, args) => this.dispatch(op as Op, args),
    });
    await this.server.listen();
    log.info('daemon.listening', { version: this.opts.identity.daemonVersion, protocol: PROTOCOL_VERSION });

    if (!migrated.ok) return this.fail(migrated.error);
    this.setState({ status: 'provisioning', detail: 'reading the inbox' });
    this.credentials.ingestInbox((update) => this.applyInstance(update));
    this.emit({ kind: 'github.auth', ...this.credentials.githubAuth() });

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
    this.ensureOrchestrator(def.value);
    const resumed = this.turns.resumeInterrupted();
    this.restartNotice(resumed, requeued);
    this.turns.startRestored();
    this.setState({ status: 'ready' });
    this.emitCapacity();
    this.scheduler.start();
    this.orchestrator.schedule();
    log.info('daemon.ready', { envId: record.envId, interrupted: interrupted.length, requeued: requeued.length });
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
  private applyDefinition(raw: unknown, pin: Pin): { classes: string[] } {
    if (!this.running()) throw new OpError('not-ready', 'The environment is still starting.');
    if (this.reprovisioning) throw new OpError('invalid-state', 'An update is already being applied.');
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
    this.applyInstance({ envId: record.envId, name: record.name, pin, sha: pin.sha, definition: raw });
    this.definition = next;
    this.opts.log.info('definition.apply', { sha: pin.sha, classes, changes: changes.length });
    this.emit({ kind: 'instance.definition', sha: pin.sha, pin, classes });
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
    this.instance.set({ ...update, history, provisioned: current?.provisioned ?? null });
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
    this.state = next;
    this.emit({ kind: 'instance.status', ...next });
  }

  private emit(ev: DaemonEvent): void {
    if (!this.events.append(ev)) throw new Error('The event log could not record an event.');
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
    if (!def || !this.backlog) return null;
    return {
      items: this.backlog.list(),
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

  private dispatch(op: Op, args: unknown): Promise<unknown> {
    if (this.state.status === 'failed' && !FAILED_OPS.has(op)) {
      return Promise.reject(new OpError('not-ready', `The environment failed: ${this.state.error ?? 'unknown error'}`));
    }
    if (this.phase !== 'serving' && op !== 'snapshot.get' && op !== 'logs.tail') {
      return Promise.reject(new OpError('not-ready', 'The environment daemon is stopping.'));
    }
    if (READY_OPS.has(op) && !this.running()) {
      return Promise.reject(new OpError('not-ready', 'The environment is still starting.'));
    }
    return dispatch(this.handlers, op, args).catch((err: unknown) => {
      if (err instanceof TurnsError || err instanceof WorkError) throw new OpError(err.code, err.message);
      if (err instanceof ItemStateError) throw new OpError('invalid-state', err.message);
      throw err;
    });
  }

  /** Item ops need the backlog, which exists once state migrated. */
  private get items(): Work {
    if (!this.work || !this.definition) throw new OpError('not-ready', 'The environment is still starting.');
    return this.work;
  }

  private readonly handlers: Handlers = {
    'snapshot.get': () => this.snapshot(),
    'session.history': ({ sessionId, before, limit }) => {
      if (!this.turns?.get(sessionId)) throw new OpError('not-found', `No session ${sessionId}.`);
      return this.transcripts.page(sessionId, before, limit ?? COMMAND_LIMITS.historyDefault);
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
    'item.create': ({ title, body, agent, repo, position }) => publicItem(this.items.create({ title, body, agent, repo, position }, 'user')),
    'item.update': ({ itemId, title, body, repo }) =>
      publicItem(
        this.items.update(
          itemId,
          { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}), ...(repo !== undefined ? { repo } : {}) },
          'user',
        ),
      ),
    'item.move': ({ itemId, position }) => ({ order: this.items.move(itemId, position) }),
    'item.assign': ({ itemId, agent }) => publicItem(this.items.assign(itemId, agent, 'user')),
    'item.cancel': ({ itemId }) => publicItem(this.items.cancel(itemId, 'user')),
    'item.retry': ({ itemId }) => publicItem(this.items.retry(itemId)),
    'item.accept': ({ itemId }) => publicItem(this.items.accept(itemId)),
    'item.publish': ({ itemId }) => this.items.publish(itemId, {}, 'user'),
    'item.delete': async ({ itemId }) => {
      await this.items.remove(itemId);
      return {};
    },
    'definition.apply': ({ definition, pin }) => this.applyDefinition(definition, pin),
    'credentials.put': async ({ harness }) => {
      for (const { id, content } of harness) {
        try {
          await this.credentials.putHarness(id, content, this.homeReady);
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
      if (!this.credentials.putGithub({ grants })) throw new OpError('invalid-args', 'That is not a usable set of GitHub grants.');
      this.emit({ kind: 'github.auth', ...this.credentials.githubAuth() });
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
      items: this.backlog ? this.backlog.list().map(publicItem) : [],
      order: this.backlog ? this.backlog.order() : [],
      capacity: capacityOf(this.schedulerView(), this.scheduler?.isPaused() ?? false),
      inflight: this.turns ? this.turns.inflight() : [],
      asks: this.turns ? this.turns.openAsks() : [],
    };
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
    await this.transcripts?.flush();
    await flushJsonWrites();
  }
}
