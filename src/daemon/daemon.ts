/**
 * The daemon itself: the boot sequence, the command handlers, shutdown and
 * upgrade. main.ts takes the lock and wires process signals; everything
 * else starts here.
 *
 * Boot: migrate the state format (a failure leaves the daemon `failed`,
 * answering only the handshake, snapshots and logs) → open the socket so
 * the app can watch → ingest the inbox → provision → reconcile what a
 * restart interrupted → make sure the orchestrator session exists → ready.
 */

import * as fs from 'node:fs';
import {
  PROTOCOL_VERSION,
  PROVISION_STAGES,
  UPGRADE_EXIT,
  COMMAND_LIMITS,
  type Capacity,
  type DaemonEvent,
  type InstanceState,
  type Op,
  type ProvisionStage,
  type Snapshot,
} from '../harness/daemon-protocol';
import { harnessDescriptors } from '../harness/providers';
import type { Notice } from '../harness/transcript';
import { newId } from '../harness/ulid';
import { Credentials } from './credentials';
import { readDefinition, referencedHarnesses, type DaemonAgent, type DaemonDefinition } from './definition';
import { EventLog } from './eventlog';
import { runCommand, type CommandRunner } from './exec';
import { createAdapters } from './harness';
import { harnessEnv } from './harness/spawn';
import type { HarnessAdapter } from './harness/types';
import { testAdapters } from './harness/test-adapters';
import { tailLog, type Logger } from './log';
import { dispatch, OpError, type Handlers } from './ops';
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
import { Turns, TurnsError } from './turns';
import type { DaemonIdentity } from './version';

/** How long SIGTERM waits for interrupted turns before persisting anyway. */
const SHUTDOWN_GRACE_MS = 20_000;

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
const READY_OPS: ReadonlySet<Op> = new Set<Op>(['chat.send', 'credentials.get']);

export class Daemon {
  private state: InstanceState = { status: 'provisioning' };
  private definition: DaemonDefinition | null = null;
  private instance!: JsonStore<InstanceRecord | null>;
  private turns!: Turns;
  private transcripts!: TranscriptBook;
  private notices!: ReturnType<typeof noticesStore>;
  private credentials!: Credentials;
  private events!: EventLog;
  private server!: DaemonServer;
  private schedulerPaused = false;
  private homeReady = false;
  private stopping = false;
  private shuttingDown = false;
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
    this.events = new EventLog(paths.events, { now: this.now });
    this.credentials = new Credentials({
      paths,
      log,
      run: this.run,
      asPuck: this.opts.privileged ? { uid: PUCK_UID, gid: PUCK_GID } : {},
      now: this.now,
    });
    if (migrated.ok) {
      this.instance = instanceStore(paths.state);
      this.notices = noticesStore(paths.state);
      this.transcripts = new TranscriptBook(paths.transcripts, this.now);
      this.turns = new Turns({
        adapters: this.opts.adapters ?? createAdapters({ log, daemonVersion: this.opts.identity.daemonVersion, orchestratorTools: () => [] }),
        sessions: sessionsStore(paths.state),
        transcripts: this.transcripts,
        emit: (ev) => this.emit(ev),
        log,
        agentFor: (s) => this.agentFor(s.agent, s.kind === 'worker'),
        envFor: () => this.harnessEnv(),
        takeNotices: () => this.takeNotices(),
        now: this.now,
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

    const test = testAdapters !== null;
    try {
      const stages = await provision({
        paths,
        log,
        run: this.run,
        credentials: this.credentials,
        definition: def.value,
        sha: record.sha,
        skipPackages: test && this.opts.env.PUCK_SKIP_PACKAGES === '1',
        gitBase: (test && this.opts.env.PUCK_TEST_GIT_BASE) || 'https://github.com/',
        prior: record.provisioned?.stages ?? {},
        privileged: this.opts.privileged,
        onStage: (stage, detail) => this.onStage(stage, detail),
      });
      record.provisioned = { fingerprint: provisionFingerprint(record.sha, stages), at: this.now(), stages };
      this.instance.save();
    } catch (err) {
      const stage = err instanceof ProvisionError ? err.stage : this.state.stage;
      return this.fail((err as Error).message, stage);
    }
    this.homeReady = true;

    const interrupted = this.turns.reconcile();
    if (interrupted.length) {
      const names = interrupted.map((s) => (s.kind === 'orchestrator' ? 'the orchestrator' : s.agent));
      this.pushNotice(
        'environment.restarted',
        `The environment restarted; interrupted turns were not resumed (${names.join(', ')}).`,
      );
    }
    this.ensureOrchestrator(def.value);
    this.turns.startRestored();
    this.setState({ status: 'ready' });
    this.emit({ kind: 'capacity', ...this.capacity() });
    log.info('daemon.ready', { envId: record.envId, interrupted: interrupted.length });
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
    this.events.append(ev);
  }

  /* ---------- Agents, env, notices ---------- */

  private agentFor(name: string, worker: boolean): DaemonAgent | null {
    const def = this.definition;
    const agent = def?.agentDefs[name];
    if (!def || !agent) return null;
    const extra = worker ? def.agents.find((a) => a.agent === name)?.instructions ?? '' : '';
    return { ...agent, instructions: [agent.instructions, extra].filter(Boolean).join('\n\n') };
  }

  private harnessEnv(): Record<string, string> {
    const def = this.definition;
    const stored = this.credentials.envSecrets();
    const secrets: Record<string, string> = {};
    for (const name of def?.secrets ?? []) if (name in stored) secrets[name] = stored[name];
    return harnessEnv({ home: this.opts.paths.home, lang: this.opts.env.LANG, definitionEnv: def?.env, secrets });
  }

  private pushNotice(kind: 'environment.restarted', text: string): void {
    this.notices.get().pending.push({ id: newId('ntc', this.now()), kind, at: this.now(), text });
    this.notices.save();
  }

  private takeNotices(): Notice[] {
    const pending = this.notices.get().pending.splice(0);
    if (pending.length) this.notices.save();
    return pending;
  }

  private capacity(): Capacity {
    const def = this.definition;
    const agents: Capacity['agents'] = {};
    for (const a of def?.agents ?? []) agents[a.agent] = { running: 0, max: a.maxParallel };
    return { agents, workers: { running: 0, max: def?.limits.maxWorkers ?? 0 }, paused: this.schedulerPaused };
  }

  /* ---------- Commands ---------- */

  private dispatch(op: Op, args: unknown): Promise<unknown> {
    if (this.state.status === 'failed' && !FAILED_OPS.has(op)) {
      return Promise.reject(new OpError('not-ready', `The environment failed: ${this.state.error ?? 'unknown error'}`));
    }
    if (this.stopping && op !== 'snapshot.get' && op !== 'logs.tail') {
      return Promise.reject(new OpError('not-ready', 'The environment daemon is stopping.'));
    }
    if (READY_OPS.has(op) && this.state.status !== 'ready') {
      return Promise.reject(new OpError('not-ready', 'The environment is still starting.'));
    }
    return dispatch(this.handlers, op, args).catch((err: unknown) => {
      if (err instanceof TurnsError) throw new OpError(err.code, err.message);
      throw err;
    });
  }

  private unavailable = (): never => {
    throw new OpError('invalid-state', 'Work items and definition updates are not available in this daemon version.');
  };

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
      if (session?.kind === 'worker') throw new OpError('invalid-state', 'Worker follow-ups are not available in this daemon version.');
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
    'item.create': this.unavailable,
    'item.update': this.unavailable,
    'item.move': this.unavailable,
    'item.assign': this.unavailable,
    'item.cancel': this.unavailable,
    'item.retry': this.unavailable,
    'item.accept': this.unavailable,
    'item.publish': this.unavailable,
    'item.delete': this.unavailable,
    'definition.apply': this.unavailable,
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
    'github.put': ({ token }) => {
      if (!this.credentials.putGithub(token)) throw new OpError('invalid-args', 'That is not a usable GitHub credential.');
      this.emit({ kind: 'github.auth', ...this.credentials.githubAuth() });
      return {};
    },
    'secrets.put': ({ values }) => {
      if (!this.credentials.putSecrets(values)) throw new OpError('invalid-args', 'Secret names or values are invalid.');
      return {};
    },
    'scheduler.pause': () => {
      this.schedulerPaused = true;
      this.emit({ kind: 'capacity', ...this.capacity() });
      return {};
    },
    'scheduler.resume': () => {
      this.schedulerPaused = false;
      this.emit({ kind: 'capacity', ...this.capacity() });
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
      items: [],
      order: [],
      capacity: this.capacity(),
      inflight: this.turns ? this.turns.inflight() : [],
      asks: this.turns ? this.turns.openAsks() : [],
    };
  }

  /* ---------- Upgrade and shutdown ---------- */

  /**
   * Swap in the bundle the app staged at puckd.next.js: stop taking input,
   * let running turns finish (drain) or interrupt them and wait out the
   * shutdown grace (now), persist, rename the new bundle into place and
   * exit 75, so the container's restart policy starts it. The response
   * goes out before the exit.
   */
  private upgrade(mode: 'drain' | 'now'): Record<string, never> {
    const { paths, log } = this.opts;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(paths.nextBundle);
    } catch {
      throw new OpError('invalid-state', 'No new daemon bundle is staged.');
    }
    if (!st.isFile() || st.size === 0) throw new OpError('invalid-state', 'The staged daemon bundle is not a file.');
    if (this.stopping) throw new OpError('invalid-state', 'An upgrade or shutdown is already in progress.');
    this.stopping = true;
    const before = this.state;
    this.emit({ kind: 'daemon.upgrading', mode });
    log.info('daemon.upgrade', { mode });
    this.turns?.stopAccepting();
    setImmediate(() => {
      void (async () => {
        if (mode === 'now') await this.interruptWithinGrace();
        else await this.turns?.idle();
        this.setState({ status: 'stopping', detail: 'upgrading' });
        await this.persist();
        fs.renameSync(paths.nextBundle, paths.bundle);
        log.info('daemon.exit', { code: UPGRADE_EXIT });
        this.opts.exit(UPGRADE_EXIT);
      })().catch((err) => {
        log.error('daemon.upgrade-failed', err);
        void this.settleFailedUpgrade(before);
      });
    });
    return {};
  }

  private async settleFailedUpgrade(before: InstanceState): Promise<void> {
    if (this.shuttingDown) return;
    this.stopping = false;
    await this.turns?.idle();
    if (this.shuttingDown || this.stopping) return;
    this.turns?.resumeAccepting();
    this.setState(before);
  }

  /** SIGTERM: stop taking commands, interrupt every turn, persist, exit 0. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown || (this.stopping && this.state.status === 'stopping')) return;
    this.shuttingDown = true;
    this.stopping = true;
    this.server?.stopAccepting();
    this.turns?.stopAccepting();
    this.setState({ status: 'stopping' });
    this.opts.log.info('daemon.shutdown');
    await this.interruptWithinGrace();
    await this.persist();
    await this.server?.close();
    this.opts.exit(0);
  }

  private interruptWithinGrace(): Promise<unknown> {
    const pending = this.turns?.interruptAll() ?? Promise.resolve();
    return Promise.race([pending, new Promise((resolve) => setTimeout(resolve, this.shutdownGraceMs).unref())]);
  }

  private async persist(): Promise<void> {
    this.events?.flush();
    this.instance?.save();
    await this.transcripts?.flush();
    await flushJsonWrites();
  }
}
