/**
 * The environment daemon's client protocol, declared once in this module.
 * puckd imports it, and so does puck-runner for its own short connections
 * (GitHub token pushes). The desktop app does not import it yet and still
 * talks to the container runner.
 *
 * Transport: one NDJSON stream per attach. The runner hosting the
 * environment runs `docker exec -i <container> node /opt/puck/puckd.js
 * attach`, which pipes stdio to the daemon's unix socket, and relays that
 * stream to the app over an attach channel. The client sends `hello`, then commands; the daemon answers
 * `welcome`, replays the events the client missed, then streams live ones.
 * Every state change the UI renders is an event with a strictly increasing
 * `seq` that survives daemon restarts.
 *
 * Versioning: new optional fields and new event kinds do not bump
 * PROTOCOL_VERSION (clients ignore event kinds they do not know). Changing
 * or removing a shape bumps it, and the daemon keeps serving the previous
 * version for one release.
 */

import type { HarnessEvent, AskQuestion, TurnStats } from './types';
import type { TranscriptEntry, UserEntry, NoticeEntry } from './transcript';

export const PROTOCOL_VERSION = 1;

/** The daemon serves PROTOCOL_VERSION and the one before it. */
export function protocolSupported(version: unknown): boolean {
  return (
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version >= 1 &&
    (version === PROTOCOL_VERSION || version === PROTOCOL_VERSION - 1)
  );
}

/** Wire limits and timings shared by both ends. */
export const WIRE_LIMITS = {
  /** One frame (one line of UTF-8 JSON). Larger results are paged. */
  maxFrameBytes: 1024 * 1024,
  /** The client must send `hello` within this long after connecting. */
  helloTimeoutMs: 5_000,
  pingIntervalMs: 15_000,
  /** No frame for this long: the client kills the exec and reconnects. */
  idleTimeoutMs: 45_000,
  /** Reconnect backoff (seconds, capped at the last), reset after a welcome. */
  reconnectBackoffS: [1, 2, 5, 10, 30] as readonly number[],
} as const;

export const EVENT_LOG = {
  /** Events per segment file (`events/<firstSeq>.ndjson`). */
  segmentSize: 10_000,
  /** The newest events kept; older segments are deleted whole. */
  retention: 50_000,
  /** Hold window for live text-deltas. Coalescing is in src/daemon/eventlog.ts. */
  coalesceMs: 50,
} as const;

export const COMMAND_LIMITS = {
  chatTextBytes: 100 * 1024,
  historyDefault: 150,
  historyMax: 200,
  logsTailMax: 2_000,
} as const;

/* ---------- Shared shapes ---------- */

export interface Pin {
  kind: 'tag' | 'branch' | 'commit';
  name: string;
  sha: string;
}

export type InstanceStatus = 'provisioning' | 'ready' | 'degraded' | 'failed' | 'stopping';

/** Boot provisioning stages, in the order they run. */
export const PROVISION_STAGES = [
  'checking-runtime',
  'creating-user',
  'installing-clis',
  'installing-sdks',
  'verifying-packages',
  'configuring-git',
  'syncing-repos',
  'writing-credentials',
] as const;
export type ProvisionStage = (typeof PROVISION_STAGES)[number];

export interface InstanceState {
  status: InstanceStatus;
  stage?: ProvisionStage;
  detail?: string;
  error?: string;
}

export type GithubAuthState = 'ok' | 'expiring' | 'revoked' | 'missing';

/**
 * The environment's GitHub credential state: `expiring` when a grant has
 * under ten minutes left, `missing` when no grant is live. `expiresAt` is
 * the earliest live grant's expiry, so the runner can schedule its next
 * push without asking the server.
 */
export interface GithubAuth {
  state: GithubAuthState;
  login?: string;
  expiresAt?: number;
}

/**
 * One short-lived GitHub App installation token for an environment: the
 * token covers `repos` (`owner/name`) of one installation and expires at
 * `expiresAt` (epoch ms). An environment whose repositories span several
 * owners holds one grant per installation. There is no refresh token: the
 * runner hosting the environment pushes fresh grants before these expire.
 */
export interface GithubGrant {
  /** The account that owns `repos` (the installation's account login). */
  owner: string;
  installationId: number;
  /** `owner/name` of every repository this token reaches. */
  repos: string[];
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

export type SessionKind = 'orchestrator' | 'worker';
/**
 * idle: waiting for input. running: a turn is in flight. interrupted: a turn
 * was cut off by a daemon restart (the next input resumes normally).
 * closed: read-only (a replaced orchestrator).
 */
export type SessionStatus = 'idle' | 'running' | 'interrupted' | 'closed';

/** A session as clients see it (the resume id stays inside the daemon). */
export interface SessionSummary {
  id: string;
  kind: SessionKind;
  /** The agent definition name. */
  agent: string;
  harness: string;
  itemId?: string;
  cwd: string;
  status: SessionStatus;
  turns: number;
  lastTurnTokens: number;
  costUsd: number;
  createdAt: number;
  lastActiveAt: number;
  /** Inputs waiting behind the running turn. */
  queued: number;
  /** Orchestrator only: the runaway guard paused automatic turns. */
  autoWakePaused?: boolean;
}

export type ItemStatus = 'backlog' | 'queued' | 'running' | 'needs-input' | 'review' | 'done' | 'failed' | 'cancelled';

export interface ItemResult {
  summary: string;
  commits: { sha: string; subject: string }[];
  diffStat: { files: number; insertions: number; deletions: number; text: string };
  uncommitted: string[];
  interrupted: boolean;
  endedAt: number;
}

export interface WorkItem {
  id: string;
  number: number;
  title: string;
  body: string;
  status: ItemStatus;
  agent: string | null;
  repo: string | null;
  createdBy: 'user' | 'orchestrator';
  createdAt: number;
  updatedAt: number;
  attempts: number;
  sessionId: string | null;
  branch: string | null;
  worktree: string | null;
  base: { branch: string; sha: string } | null;
  result: ItemResult | null;
  pr: { number: number; url: string; draft: boolean; lastPushedSha: string } | null;
  lastError: string | null;
  /** Why the item was cancelled, when the canceller gave one. */
  cancelReason: string | null;
  /** Note recorded when the item was accepted. */
  acceptNote: string | null;
  pendingAsk: { askId: string; routedTo: 'orchestrator' | 'user' } | null;
}

export type ItemPosition = 'top' | 'bottom' | { before: string } | { after: string };

export interface Capacity {
  agents: Record<string, { running: number; max: number }>;
  workers: { running: number; max: number };
  paused: boolean;
}

/** A turn still streaming when the snapshot was taken (recorded dialect). */
export interface InflightTurn {
  sessionId: string;
  turnId: string;
  startedAt: number;
  events: HarnessEvent[];
}

export interface OpenAsk {
  sessionId: string;
  turnId: string;
  askId: string;
  questions: AskQuestion[];
  routedTo: 'orchestrator' | 'user';
  note?: string;
}

/** Everything a client needs to render an environment, except transcripts. */
export interface Snapshot {
  envId: string;
  name: string;
  daemon: { version: string; build: string; protocol: number };
  /** The last event seq included in this snapshot; live events follow from head + 1. */
  head: number;
  instance: InstanceState & { pin: Pin | null; sha: string | null };
  github: GithubAuth;
  sessions: SessionSummary[];
  /** The current orchestrator session, once one exists. */
  orchestratorSessionId: string | null;
  items: WorkItem[];
  order: string[];
  capacity: Capacity;
  inflight: InflightTurn[];
  asks: OpenAsk[];
}

/* ---------- Commands ---------- */

/** Every command: its args and its result. */
export interface OpMap {
  'snapshot.get': { args: Record<string, never>; result: Snapshot };
  'session.history': {
    args: { sessionId: string; before?: number; limit?: number };
    result: { entries: TranscriptEntry[]; total: number; hasMore: boolean };
  };
  'chat.send': { args: { sessionId?: string; text: string }; result: { queued: boolean; turnId?: string } };
  'session.interrupt': { args: { sessionId: string }; result: Record<string, never> };
  'ask.answer': {
    args: { sessionId: string; askId: string; answers: Record<string, string> | null };
    result: Record<string, never>;
  };
  'item.create': {
    args: { title: string; body?: string; agent?: string; repo?: string; position?: ItemPosition };
    result: WorkItem;
  };
  'item.update': { args: { itemId: string; title?: string; body?: string; repo?: string }; result: WorkItem };
  'item.move': { args: { itemId: string; position: ItemPosition }; result: { order: string[] } };
  'item.assign': { args: { itemId: string; agent: string | null }; result: WorkItem };
  'item.cancel': { args: { itemId: string }; result: WorkItem };
  'item.retry': { args: { itemId: string }; result: WorkItem };
  'item.accept': { args: { itemId: string }; result: WorkItem };
  'item.publish': { args: { itemId: string }; result: { prUrl: string } };
  'item.delete': { args: { itemId: string }; result: Record<string, never> };
  'definition.apply': { args: { definition: unknown; pin: Pin }; result: { classes: string[] } };
  'credentials.put': { args: { harness: { id: string; content: string }[] }; result: Record<string, never> };
  'credentials.get': { args: Record<string, never>; result: { harness: { id: string; content: string }[] } };
  'github.put': { args: { grants: GithubGrant[] }; result: Record<string, never> };
  'secrets.put': { args: { values: Record<string, string> }; result: Record<string, never> };
  'scheduler.pause': { args: Record<string, never>; result: Record<string, never> };
  'scheduler.resume': { args: Record<string, never>; result: Record<string, never> };
  'daemon.upgrade': { args: { mode: 'drain' | 'now' }; result: Record<string, never> };
  'logs.tail': { args: { lines: number }; result: { text: string } };
}

export type Op = keyof OpMap;
export type OpArgs<O extends Op> = OpMap[O]['args'];
export type OpResult<O extends Op> = OpMap[O]['result'];

// A record keyed by Op keeps this list total: a new op without an entry
// here fails to compile.
const OP_TABLE: Record<Op, true> = {
  'snapshot.get': true,
  'session.history': true,
  'chat.send': true,
  'session.interrupt': true,
  'ask.answer': true,
  'item.create': true,
  'item.update': true,
  'item.move': true,
  'item.assign': true,
  'item.cancel': true,
  'item.retry': true,
  'item.accept': true,
  'item.publish': true,
  'item.delete': true,
  'definition.apply': true,
  'credentials.put': true,
  'credentials.get': true,
  'github.put': true,
  'secrets.put': true,
  'scheduler.pause': true,
  'scheduler.resume': true,
  'daemon.upgrade': true,
  'logs.tail': true,
};
export const OPS = Object.keys(OP_TABLE) as Op[];

export function isOp(value: unknown): value is Op {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OP_TABLE, value);
}

/**
 * Commands the renderer may issue through the app. Credential, secret,
 * definition and upgrade commands are issued by the main process only.
 */
export type RendererOp =
  | 'snapshot.get'
  | 'session.history'
  | 'chat.send'
  | 'session.interrupt'
  | 'ask.answer'
  | Extract<Op, `item.${string}`>
  | 'scheduler.pause'
  | 'scheduler.resume'
  | 'logs.tail';

export const RENDERER_OPS: readonly RendererOp[] = OPS.filter(
  (op): op is RendererOp =>
    op.startsWith('item.') ||
    [
      'snapshot.get',
      'session.history',
      'chat.send',
      'session.interrupt',
      'ask.answer',
      'scheduler.pause',
      'scheduler.resume',
      'logs.tail',
    ].includes(op),
);

/** The renderer's daemon passthrough: only allowlisted ops get through. */
export function daemonCommandFrom(op: unknown, args: unknown): { op: RendererOp; args: unknown } {
  if (typeof op !== 'string' || !(RENDERER_OPS as readonly string[]).includes(op)) {
    throw new Error(`Daemon command not allowed from the renderer: ${String(op).slice(0, 40)}`);
  }
  return { op: op as RendererOp, args };
}

/* ---------- Events ---------- */

export type DaemonEvent =
  | ({ kind: 'instance.status' } & InstanceState)
  | { kind: 'instance.definition'; sha: string; pin: Pin; classes: string[] }
  | ({ kind: 'github.auth' } & GithubAuth)
  | { kind: 'session.upsert'; session: SessionSummary }
  | { kind: 'turn.user'; sessionId: string; entry: UserEntry }
  | { kind: 'turn.notice'; sessionId: string; entry: NoticeEntry }
  | { kind: 'turn.start'; sessionId: string; turnId: string }
  | { kind: 'turn.end'; sessionId: string; turnId: string; stats: TurnStats }
  | { kind: 'turn.event'; sessionId: string; turnId: string; event: HarnessEvent }
  | { kind: 'ask.routed'; sessionId: string; askId: string; to: 'orchestrator' | 'user' }
  | {
      kind: 'ask.closed';
      sessionId: string;
      askId: string;
      answers: Record<string, string> | null;
      by: 'user' | 'orchestrator' | 'cancelled';
    }
  | { kind: 'item.upsert'; item: WorkItem }
  | { kind: 'item.removed'; itemId: string }
  | { kind: 'backlog.order'; order: string[] }
  | ({ kind: 'capacity' } & Capacity)
  | { kind: 'daemon.upgrading'; mode: 'drain' | 'now' };

export type DaemonEventKind = DaemonEvent['kind'];

const EVENT_KINDS: Record<DaemonEventKind, true> = {
  'instance.status': true,
  'instance.definition': true,
  'github.auth': true,
  'session.upsert': true,
  'turn.user': true,
  'turn.notice': true,
  'turn.start': true,
  'turn.end': true,
  'turn.event': true,
  'ask.routed': true,
  'ask.closed': true,
  'item.upsert': true,
  'item.removed': true,
  'backlog.order': true,
  capacity: true,
  'daemon.upgrading': true,
};

/** Clients apply only kinds they know; anything newer is skipped, never an error. */
export function isKnownEvent(ev: unknown): ev is DaemonEvent {
  return (
    !!ev &&
    typeof ev === 'object' &&
    typeof (ev as { kind?: unknown }).kind === 'string' &&
    Object.prototype.hasOwnProperty.call(EVENT_KINDS, (ev as { kind: string }).kind)
  );
}

/* ---------- Frames ---------- */

export type ErrorCode = 'not-found' | 'invalid-args' | 'invalid-state' | 'limit' | 'not-ready' | 'internal';

export type ClientFrame =
  | { t: 'hello'; protocol: number; client: { app: string; build: string }; since: number | null }
  | { t: 'cmd'; id: string; op: Op; args: unknown }
  | { t: 'ping'; at: number };

export type DaemonFrame =
  | {
      t: 'welcome';
      protocol: number;
      daemon: { version: string; build: string };
      envId: string;
      head: number;
      replay: 'events' | 'resync';
    }
  | { t: 'event'; seq: number; at: number; ev: DaemonEvent }
  | { t: 'res'; id: string; ok: true; result: unknown }
  | { t: 'res'; id: string; ok: false; error: { code: ErrorCode; message: string } }
  | { t: 'pong'; at: number }
  | { t: 'error'; code: 'protocol-mismatch' | 'daemon-unavailable' | 'bad-frame'; message: string };

/** Exit code of `puckd attach` when the daemon's socket is missing. */
export const ATTACH_UNAVAILABLE_EXIT = 3;
/** Exit code of `puckd serve` after an upgrade: the restart policy starts the new bundle. */
export const UPGRADE_EXIT = 75;
