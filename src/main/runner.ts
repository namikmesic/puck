/**
 * Runner bridge (main process).
 *
 * Maintains one long-lived `docker exec` into each environment's container
 * running the runner agent (/opt/puck/runner.js), and multiplexes turn
 * requests over NDJSON stdio. Stdio avoids published ports entirely, which
 * keeps this working across Docker runtimes (Docker Desktop, colima, …).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { HarnessEvent } from '../harness/types';
import { log } from './log';

/**
 * Transport seam: how to open a stdio exec into an environment's runner.
 * The composition root (src/index.ts) wires the docker adapter from
 * environments.ts; tests inject a scripted fake. Keeping Docker knowledge
 * out of this module lets the NDJSON bridge be tested as pure concurrency.
 */
export type ExecSpawner = (envId: string) => ChildProcessWithoutNullStreams;

let spawnExec: ExecSpawner = () => {
  throw new Error('runner: no exec spawner wired (composition root not initialized)');
};

export function useExecSpawner(fn: ExecSpawner): void {
  spawnExec = fn;
}

/**
 * Lifecycle seam: when the exec dies mid-turn, environments can explain it
 * (a concurrent stop/restart) so the user reads "restarting", not
 * "disconnected". Returns null when no lifecycle operation is active.
 */
export type DisconnectExplainer = (envId: string) => string | null;
let explainDisconnect: DisconnectExplainer = () => null;
export function useDisconnectExplainer(fn: DisconnectExplainer): void {
  explainDisconnect = fn;
}

/** Subscribers told when a runner exec ends on its own (not via detach). */
const exitSubscribers: Array<(envId: string, code: number | null) => void> = [];
export function onRunnerExit(cb: (envId: string, code: number | null) => void): void {
  exitSubscribers.push(cb);
}

/**
 * Wire contract with the container runner. runner.js (which cannot import
 * host code) declares the same values as `OP`/`RV`; the sync is enforced by
 * test/unit/runner-source.test.ts.
 */
export const WIRE = {
  ops: { turn: 'turn', interrupt: 'interrupt', answer: 'answer' },
  /** Protocol revision: 2 = the runner understands the compiled `settings` field. */
  rv: 2,
} as const;

export interface TurnRequest {
  id: string;
  provider: string;
  model: string;
  systemPrompt: string;
  thinking: string;
  /**
   * JSON of the compiled provider-settings fragment (host-side
   * `compileSettings` output), applied by the runner before `advanced`.
   */
  settings: string;
  /** JSON object string merged into the provider SDK options LAST. */
  advanced: string;
  resume: string | null;
  prompt: string;
}

interface RunnerMsg {
  id?: string;
  event?: HarnessEvent;
  done?: boolean;
  providerSessionId?: string | null;
  /** Eager resume-id report, sent as soon as the SDK announces the session. */
  session?: string;
  ready?: boolean;
  /** Runner protocol revision (absent = 1). 2+ understands `settings`. */
  rv?: number;
}

interface RunnerProc {
  child: ChildProcessWithoutNullStreams;
  routes: Map<string, (msg: RunnerMsg | null) => void>;
  /** Last ~8KB of container stderr — the only diagnostics on failure. */
  stderrTail: string;
  /** Resolves on the runner's `{ready:true}` handshake; rejects on death. */
  ready: Promise<void>;
  /** Protocol revision reported by the ready handshake (old runners: 1). */
  rv: number;
  /** Exit code once the exec has closed (137 = killed, e.g. container stop). */
  exitCode: number | null;
}

/** One NDJSON frame to the runner; frames are the whole wire protocol. */
function send(proc: RunnerProc, msg: Record<string, unknown>): void {
  proc.child.stdin?.write(JSON.stringify(msg) + '\n');
}

const runners = new Map<string, RunnerProc>();

function ensure(envId: string): RunnerProc {
  const existing = runners.get(envId);
  if (existing && existing.child.exitCode === null && !existing.child.killed) {
    return existing;
  }
  runners.delete(envId);

  const child = spawnExec(envId);
  const routes = new Map<string, (msg: RunnerMsg | null) => void>();
  let readyResolve!: () => void;
  let readyReject!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => undefined); // observed via await in turn(); avoid unhandled
  const proc: RunnerProc = { child, routes, stderrTail: '', ready, rv: 1, exitCode: null };
  const readyTimer = setTimeout(() => {
    readyReject(new Error('runner did not report ready within 15s'));
  }, 15_000);

  // A dead exec (container gone, daemon stopped) must fail the turn, not the
  // app: without these handlers an EPIPE on stdin is a process-fatal throw.
  let failed = false;
  const fail = (code: number | null = null): void => {
    if (failed) return;
    failed = true;
    proc.exitCode = code;
    log.warn('runner.exit', {
      envId,
      code,
      turns: routes.size,
      stderr: proc.stderrTail.trim().slice(-300),
    });
    clearTimeout(readyTimer);
    readyReject(new Error(code === null ? 'runner process exited' : `runner process exited (code ${code})`));
    for (const route of routes.values()) route(null);
    routes.clear();
    if (runners.get(envId) === proc) runners.delete(envId);
    // An exec WE killed (detach) is not news; one that died on its own is —
    // the environment may have stopped underneath us.
    if (!child.killed) for (const cb of exitSubscribers) cb(envId, code);
  };
  child.on('error', () => fail());
  child.stdin?.on('error', () => fail());

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += String(chunk);
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as RunnerMsg;
        if (msg.ready) {
          proc.rv = msg.rv ?? 1;
          clearTimeout(readyTimer);
          readyResolve();
        }
        if (msg.id) routes.get(msg.id)?.(msg);
      } catch {
        // non-JSON noise
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    proc.stderrTail = (proc.stderrTail + String(chunk)).slice(-8000);
  });
  child.on('close', (code) => fail(code));

  runners.set(envId, proc);
  return proc;
}

/**
 * Readiness handshake probe: opens the runner exec (or reuses a live one)
 * and resolves once the runner reports `{ready:true}`. The exec stays cached
 * for the first turn. Rejects with container stderr when the runner cannot
 * start (typically MODULE_NOT_FOUND: the runner file or an SDK is missing).
 */
export async function probe(envId: string): Promise<{ rv: number }> {
  const proc = ensure(envId);
  try {
    await proc.ready;
  } catch (err) {
    throw new Error(diagnose(proc, `Runner handshake failed: ${err instanceof Error ? err.message : err}`));
  }
  return { rv: proc.rv };
}

function diagnose(proc: RunnerProc, headline: string): string {
  const tail = proc.stderrTail.trim();
  return tail ? `${headline}\nContainer stderr:\n${tail.slice(-800)}` : headline;
}

const endStats = { inputTokens: 0, outputTokens: 0, durationMs: 0 };

/**
 * Why a turn lost its runner. A lifecycle operation in progress (stop,
 * restart, rebuild) is the answer when there is one — including the exit
 * 137 Docker delivers when it kills the exec during a stop; only an
 * unexplained death gets the diagnostic headline plus container stderr.
 */
function disconnectMessage(envId: string, proc: RunnerProc, sawMessage: boolean): string {
  const lifecycle = explainDisconnect(envId);
  if (lifecycle) return `${lifecycle} This turn was cancelled.`;
  if (proc.exitCode === 137) {
    return diagnose(
      proc,
      'Runner was killed (exit 137) — the container stopped or the process ran out of memory.',
    );
  }
  const headline = sawMessage
    ? 'Runner disconnected — is the environment container still running?'
    : 'Runner did not respond within 90s — is the environment container healthy?';
  return diagnose(proc, headline);
}

export async function* turn(
  envId: string,
  req: TurnRequest,
  onSession: (providerSessionId: string) => void,
): AsyncGenerator<HarnessEvent> {
  const proc = ensure(envId);
  try {
    await proc.ready;
  } catch (err) {
    yield {
      kind: 'error',
      message: diagnose(proc, `Runner failed to start: ${err instanceof Error ? err.message : err}. Try restarting the environment.`),
    };
    yield { kind: 'turn-end', stats: endStats };
    return;
  }
  if (proc.routes.has(req.id)) {
    yield { kind: 'error', message: `Duplicate turn id ${req.id} — refusing to clobber the running turn.` };
    yield { kind: 'turn-end', stats: endStats };
    return;
  }
  // A container started before an app update keeps its old runner.js until
  // the environment restarts; an old runner silently ignores `settings`.
  if (proc.rv < WIRE.rv && req.settings && req.settings !== '{}') {
    yield {
      kind: 'error',
      message:
        'This environment is running an older Puck runner that ignores agent option settings. Restart the environment from Settings to apply them.',
    };
  }

  const queue: Array<RunnerMsg | null> = [];
  let wake: (() => void) | null = null;
  proc.routes.set(req.id, (msg) => {
    queue.push(msg);
    wake?.();
    wake = null;
  });

  // Watchdog: a runner that accepts the request but never answers must fail
  // the turn, not hang it forever. Cleared on the first message.
  let sawMessage = false;
  const watchdog = setTimeout(() => {
    if (!sawMessage) proc.routes.get(req.id)?.(null);
  }, 90_000);

  send(proc, { op: WIRE.ops.turn, ...req });

  let done = false;
  let sawTurnEnd = false;
  try {
    for (;;) {
      if (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
      while (queue.length) {
        const msg = queue.shift();
        if (msg === null || msg === undefined) {
          yield { kind: 'error', message: disconnectMessage(envId, proc, sawMessage) };
          yield { kind: 'turn-end', stats: endStats };
          return;
        }
        sawMessage = true;
        if (msg.session) onSession(msg.session);
        if (msg.event) {
          if (msg.event.kind === 'turn-end') sawTurnEnd = true;
          yield msg.event;
        }
        if (msg.done) {
          if (msg.providerSessionId) onSession(msg.providerSessionId);
          done = true;
          // turn-end is the protocol's only terminal event; a runner that
          // reports done without one (old runners' dispatch error path)
          // would otherwise lock the conversation's composer forever.
          if (!sawTurnEnd) yield { kind: 'turn-end', stats: endStats };
          return;
        }
      }
    }
  } finally {
    clearTimeout(watchdog);
    proc.routes.delete(req.id);
    // The consumer went away mid-turn (window reload, generator abandoned):
    // stop the container-side work instead of letting it run invisibly.
    if (!done && proc.child.exitCode === null && !proc.child.killed) {
      try {
        send(proc, { op: WIRE.ops.interrupt, id: req.id });
      } catch {
        // stdin already gone — nothing left to stop
      }
    }
  }
}

export function interrupt(envId: string, turnId: string): void {
  const proc = runners.get(envId);
  if (proc && proc.child.exitCode === null) {
    send(proc, { op: WIRE.ops.interrupt, id: turnId });
  }
}

export function answerAsk(
  envId: string,
  turnId: string,
  askId: string,
  answers: Record<string, string> | null,
): void {
  const proc = runners.get(envId);
  if (proc && proc.child.exitCode === null) {
    send(proc, { op: WIRE.ops.answer, id: turnId, askId, answers });
  }
}

/** Drop the cached bridge (e.g. after an environment stop). */
export function detach(envId: string): void {
  const proc = runners.get(envId);
  if (proc) {
    proc.child.kill('SIGTERM');
    runners.delete(envId);
  }
}

/** Kill every runner exec on app quit — no orphaned docker processes. */
export function detachAll(): void {
  for (const envId of [...runners.keys()]) detach(envId);
}
