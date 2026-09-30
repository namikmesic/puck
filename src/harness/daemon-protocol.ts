/**
 * The environment daemon's client protocol, declared once in this module.
 * puckd imports it, and so do puck-runner, for its own short connections
 * (GitHub token pushes), and the desktop app, whose daemon client attaches
 * to environments through their runner.
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

export const PROTOCOL_VERSION = 2;

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

/**
 * A ticket's place on the board. Todo: no implement step has started. In
 * progress: a step started and the workflow is not finished. Done: the
 * workflow finished, and `outcome` says how. `docs/delivery-workflow-spec.md`
 * (4.1) has the model; `src/harness/item-transitions.ts` the ticket table.
 */
export type ItemStatus = 'todo' | 'in-progress' | 'done';
export type ItemOutcome = 'merged' | 'accepted' | 'failed' | 'cancelled';

/** A ticket's steps, grouped in rounds; the step machine is `src/harness/workflow.ts`. */
export type StepKind = 'decompose' | 'implement' | 'checks' | 'review' | 'publish' | 'ci' | 'merge';
export type StepState = 'pending' | 'queued' | 'running' | 'needs-input' | 'waiting' | 'done';
export type StepResult = 'passed' | 'failed' | 'inconclusive' | 'skipped' | 'cancelled' | 'superseded';
export type ImplementPurpose = 'task' | 'fix' | 'changes' | 'integrate';
export type Gate = 'pending' | 'clear' | 'blocked' | 'inconclusive';

export interface Step {
  /** `stp_<ulid>`. */
  id: string;
  kind: StepKind;
  /** 1-based. */
  round: number;
  state: StepState;
  /** Set exactly when `state` is `done`. */
  result: StepResult | null;
  /** Implement and review steps. */
  agent: string | null;
  sessionId: string | null;
  /** Checks, review and ci steps: their review record (a later phase). */
  reviewId: string | null;
  /** Implement steps from a plan (a later phase). */
  task: { id: string; title: string; branch: string | null; worktree: string | null } | null;
  /** Implement only. */
  purpose: ImplementPurpose | null;
  /** Readiness group within the round (`src/harness/workflow.ts`). */
  group: number;
  /** A sequential task's predecessor step. */
  after: string | null;
  /** Every attempt of one logical step shares it: the first attempt's id. */
  logicalId: string;
  attempt: number;
  /** The attempt this one replaces. */
  retryOf: string | null;
  /** Implement: what it produced (summary ≤ 2 KB). */
  work: { head: string; commits: number; summary: string } | null;
  queuedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** ≤ 160 bytes: "Stopped by the user", "waiting for a slot since 14:02". */
  detail: string;
  /** Synthesized by the format-2 migration. */
  legacy?: true;
}

export interface RoundInfo {
  round: number;
  /** `rnd_<ulid>`. */
  roundId: string;
  /** Why the round opened. */
  purpose: ImplementPurpose;
  /** The commit verified in this round, once its implement steps are done. */
  headSha: string | null;
  gate: Gate;
  /** The gate at settlement; never changes. */
  settledGate: Gate | null;
  outcome: 'open' | 'settled' | 'superseded' | 'cancelled';
  startedAt: number;
  settledAt: number | null;
}

/** One step as the card and the ticket summary show it. */
export interface StepSummary {
  id: string;
  kind: StepKind;
  state: StepState;
  result: StepResult | null;
  /** Implement and review steps: the agent name the card row shows. */
  agent: string | null;
  /** ≤ 160 bytes. */
  detail: string;
}

/** The current round, bounded (at most 6 KiB serialized). */
export interface WorkflowSummary {
  round: number;
  /** 0 when rounds are unlimited (an environment without delivery). */
  roundsAllowed: number;
  gate: Gate;
  headSha: string | null;
  /** The current round only, in step order, the latest attempt of each, at most 24. */
  steps: StepSummary[];
  obligations: number;
  /** Open and needs-evidence findings, any severity. */
  openFindings: number;
  policy: { merge: 'auto' | 'ask' | 'manual'; require: 'all-clear' | 'any-clear' | null; panel: string[] };
}

export interface ItemResult {
  summary: string;
  commits: { sha: string; subject: string }[];
  diffStat: { files: number; insertions: number; deletions: number; text: string };
  uncommitted: string[];
  interrupted: boolean;
  endedAt: number;
  /** The captured head of the ticket's branch ('' when it was never captured). */
  head: string;
}

/** Protocol 1: the GitHub issue a work item came from (intake by label, or an import). */
export interface IssueSource {
  kind: 'github-issue';
  /** `owner/name`. */
  repo: string;
  number: number;
  url: string;
  /** The issue's `updated_at` when Puck last read it (epoch ms). */
  updatedAt: number;
}

export type ChecksState = 'pending' | 'success' | 'failure' | 'neutral';

/** CI on a published pull request's head commit: check runs, commit statuses and failed workflow jobs. */
export interface PullChecks {
  sha: string;
  state: ChecksState;
  failing: { name: string; url: string; summary: string }[];
}

/** One issue from a search of the environment's repositories. */
export interface IssueHit {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  state: string;
  labels: string[];
  url: string;
  /** "W-3 (review)" when an open work item is already on it. Done and cancelled items are omitted. */
  item: string | null;
}

/** One review, inline comment or conversation comment on an item's pull request. */
export interface PullFeedback {
  kind: 'review' | 'inline' | 'comment';
  author: string;
  /** Reviews: APPROVED, CHANGES_REQUESTED, COMMENTED. */
  state?: string;
  /** Inline comments: `path:line`. */
  where?: string;
  body: string;
  url: string;
  at: number;
  /** From someone with write access. Anything else is never sent to agents. */
  trusted: boolean;
}

/** An item's pull request as work detail shows it: state, CI, and the feedback read so far. */
export interface PullView {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  checks: PullChecks | null;
  /** Oldest first. */
  feedback: PullFeedback[];
  reviewRounds: { used: number; max: number };
}

/** Protocol 1: an item's pull request. */
export interface PullRequestRef {
  number: number;
  url: string;
  draft: boolean;
  lastPushedSha: string;
  /** As GitHub last reported it; absent until the first poll. */
  state?: 'open' | 'closed' | 'merged';
  checks?: PullChecks | null;
}

export type ReferenceRole = 'source' | 'delivery' | 'related' | 'followup-of' | 'followup';

/**
 * A ticket's links (`src/harness/references.ts` has the rules and the two
 * accessors). At most one `source` issue and one `delivery` pull request,
 * the one Puck pushes, watches and merges; `related` links are display-only.
 */
export type Reference =
  | { id: string; role: 'source' | 'related'; kind: 'github-issue'; repo: string; number: number; url: string; updatedAt: number; title?: string }
  | {
      id: string;
      role: 'delivery' | 'related';
      kind: 'github-pr';
      repo: string;
      number: number;
      url: string;
      draft: boolean;
      lastPushedSha: string;
      state?: 'open' | 'closed' | 'merged';
      checks?: PullChecks | null;
      mergeCommitSha?: string | null;
    }
  | { id: string; role: 'followup-of' | 'followup'; kind: 'ticket'; itemId: string; number: number; findingIds: string[] }
  | { id: string; role: 'related'; kind: 'url'; url: string; label: string | null };

export type GithubPullReference = Extract<Reference, { kind: 'github-pr' }>;
export type GithubIssueReference = Extract<Reference, { kind: 'github-issue' }>;

/** An open ask of a ticket: a worker's question, or a decision (a later phase). */
export interface TicketAsk {
  askId: string;
  kind: 'question' | 'decision';
  roundId: string;
  stepId: string | null;
  routedTo: 'orchestrator' | 'user';
  since: number;
}

/** A work item: a ticket. The protocol keeps the `item.*` op names and this type's name. */
export interface WorkItem {
  id: string;
  number: number;
  title: string;
  body: string;
  status: ItemStatus;
  /** The kind of the ticket's current step; null in todo and done. */
  stage: StepKind | null;
  /** Set exactly when status is done. */
  outcome: ItemOutcome | null;
  /** The ticket's agent: its implement step's, or the one assigned. */
  agent: string | null;
  repo: string | null;
  createdBy: 'user' | 'orchestrator' | 'pipeline';
  createdAt: number;
  updatedAt: number;
  /** When the ticket last entered done. */
  closedAt: number | null;
  /** The dispatches of the current request on the ticket branch's lane. */
  attempts: number;
  sessionId: string | null;
  branch: string | null;
  worktree: string | null;
  base: { branch: string; sha: string } | null;
  result: ItemResult | null;
  /** Replaces protocol 1's `source` and `pr`. */
  references: Reference[];
  lastError: string | null;
  /** Why the item was cancelled, when the canceller gave one. */
  cancelReason: string | null;
  /** Note recorded when the item was accepted. */
  acceptNote: string | null;
  /** The oldest open ask, whoever it is routed to. */
  needsInput: TicketAsk | null;
  /** The oldest ask routed to the user. */
  oldestUserAsk: Omit<TicketAsk, 'routedTo'> | null;
  /** Every open ask of the ticket. */
  openAsks: number;
  /** Those routed to the user: what the card badge and the Board tab count. */
  userAsks: number;
  /** A ticket's own workflow override: a later phase; always null in this version. */
  delivery: null;
  /** Null in done, and in todo without steps. */
  workflow: WorkflowSummary | null;
}

/** Protocol 1's statuses: what a protocol-1 connection sees. */
export type ItemStatusV1 = 'backlog' | 'queued' | 'running' | 'needs-input' | 'review' | 'done' | 'failed' | 'cancelled';

/** Protocol 1's work item. */
export interface WorkItemV1 {
  id: string;
  number: number;
  title: string;
  body: string;
  status: ItemStatusV1;
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
  result: Omit<ItemResult, 'head'> | null;
  pr: PullRequestRef | null;
  source: IssueSource | null;
  lastError: string | null;
  cancelReason: string | null;
  acceptNote: string | null;
  pendingAsk: { askId: string; routedTo: 'orchestrator' | 'user' } | null;
}

export type ItemPosition = 'top' | 'bottom' | { before: string } | { after: string };

export interface Capacity {
  agents: Record<string, { running: number; max: number }>;
  workers: { running: number; max: number };
  paused: boolean;
  /** Checks and review steps holding a slot (a later phase); absent from older daemons. */
  verifying?: number;
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

/** An open decision's ask (the decision machinery is a later phase; none are open in this version). */
export interface OpenDecision {
  itemId: string;
  askId: string;
  roundId: string;
  stepId: string | null;
  kind: string;
  routedTo: 'orchestrator' | 'user';
  question: string;
  options: { value: string; label: string; needsReason: boolean; override: boolean }[];
  since: number;
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
  decisions: OpenDecision[];
  /** The definition's repositories (`owner/name` and their directory); absent from older daemons. */
  repos?: { github: string; dir: string }[];
}

/** The collections of a snapshot that grow; protocol 2 sends them in parts (`snapshot.part`). */
export const SNAPSHOT_COLLECTIONS = ['items', 'order', 'sessions', 'inflight', 'asks', 'decisions'] as const;
export type SnapshotCollection = (typeof SNAPSHOT_COLLECTIONS)[number];

/** Protocol 2's `snapshot.get`: the bounded fields; the collections follow through `snapshot.part`. */
export type SnapshotHead = Omit<Snapshot, SnapshotCollection> & { partsCursor: string | null };

/** One part of a frozen snapshot: whole records of one collection, below 512 KiB. */
export interface SnapshotPart {
  collection: SnapshotCollection;
  records: unknown[];
  partsCursor: string | null;
}

/** Protocol 1's snapshot, sent whole. */
export interface SnapshotV1 extends Omit<Snapshot, 'items' | 'decisions'> {
  items: WorkItemV1[];
}

/** Paging limits of the growing reads. */
export const PAGE_LIMITS = {
  /** One page of any paged op, serialized. */
  pageBytes: 512 * 1024,
  /** Steps `item.workflow` returns for its round before the rest go to `item.records`. */
  workflowSteps: 64,
  recordsLimit: 100,
  /** How long a frozen snapshot outlives its last request. */
  snapshotTtlMs: 120_000,
} as const;

export type RecordKind = 'rounds' | 'steps' | 'reviews' | 'findings' | 'decisions' | 'trail' | 'audits';

/** A snapshot from its head, before any part has arrived. */
export function snapshotFromHead(head: SnapshotHead): Snapshot {
  const { partsCursor: _cursor, ...rest } = head;
  void _cursor;
  return { ...rest, items: [], order: [], sessions: [], inflight: [], asks: [], decisions: [] };
}

/** Add one part's records. An in-flight turn cut across parts continues under the same turnId: its events join. */
export function addSnapshotPart(snapshot: Snapshot, part: SnapshotPart): void {
  if (!(SNAPSHOT_COLLECTIONS as readonly string[]).includes(part.collection) || !Array.isArray(part.records)) return;
  if (part.collection === 'inflight') {
    for (const record of part.records as InflightTurn[]) {
      const last = snapshot.inflight[snapshot.inflight.length - 1];
      if (last && last.turnId === record.turnId && last.sessionId === record.sessionId) last.events.push(...record.events);
      else snapshot.inflight.push({ ...record, events: [...record.events] });
    }
    return;
  }
  (snapshot[part.collection] as unknown[]).push(...part.records);
}

/* ---------- Commands ---------- */

/** Every command: its args and its result. */
export interface OpMap {
  /** Protocol 2: the bounded fields and a cursor; the collections follow through `snapshot.part`. */
  'snapshot.get': { args: Record<string, never>; result: SnapshotHead };
  'session.history': {
    args: { sessionId: string; before?: number; limit?: number };
    /**
     * `before` is an entry index (a page ends there). `head` is the last event
     * seq the page reflects: later events for the session are not in it.
     * Daemons before it was added leave it out.
     */
    result: { entries: TranscriptEntry[]; total: number; hasMore: boolean; head?: number };
  };
  'chat.send': { args: { sessionId?: string; text: string }; result: { queued: boolean; turnId?: string } };
  'session.interrupt': { args: { sessionId: string }; result: Record<string, never> };
  'ask.answer': {
    args: { sessionId: string; askId: string; answers: Record<string, string> | null };
    result: Record<string, never>;
  };
  'snapshot.part': { args: { cursor: string }; result: SnapshotPart };
  'item.create': {
    args: { title: string; body?: string; agent?: string; repo?: string; position?: ItemPosition; links?: string[] };
    result: WorkItem;
  };
  'item.update': { args: { itemId: string; title?: string; body?: string; repo?: string }; result: WorkItem };
  'item.move': { args: { itemId: string; position: ItemPosition }; result: { order: string[] } };
  'item.assign': { args: { itemId: string; agent: string | null }; result: WorkItem };
  'item.cancel': { args: { itemId: string }; result: WorkItem };
  'item.retry': { args: { itemId: string }; result: WorkItem };
  'item.accept': { args: { itemId: string; reason?: string }; result: WorkItem };
  /** Add a `related` link: a GitHub issue or pull request (`owner/name#12`, a github.com URL) or an https URL. */
  'item.link': { args: { itemId: string; ref: string }; result: WorkItem };
  /** Remove a `related` link. */
  'item.unlink': { args: { itemId: string; referenceId: string }; result: WorkItem };
  /** One round of a ticket's workflow (the newest by default), with the latest attempt of each step. */
  'item.workflow': {
    args: { itemId: string; round?: number };
    result: {
      roundsTotal: number;
      /** Null for a ticket without a workflow. */
      round: RoundInfo | null;
      steps: Step[];
      /** More steps of this round through `item.records`. */
      stepsCursor: string | null;
      /** Reviews and decisions arrive with later phases. */
      reviews: unknown[];
      decisions: unknown[];
      findingsTotal: number;
    };
  };
  /** Every growing collection of a ticket, paged at a stable boundary. */
  'item.records': {
    args: { itemId: string; kind: RecordKind; round?: number; findingId?: string; status?: string[]; cursor?: string; limit?: number };
    result: { records: unknown[]; nextCursor: string | null };
  };
  'item.publish': { args: { itemId: string }; result: { prUrl: string } };
  'item.delete': { args: { itemId: string }; result: Record<string, never> };
  /** Import a GitHub issue of one of the environment's repositories as a work item. */
  'issue.import': {
    args: { repo: string; number: number; agent?: string; position?: ItemPosition };
    result: WorkItem;
  };
  /** Search the open (or closed, or all) issues of the environment's repositories. */
  'issue.search': {
    args: { query: string; repo?: string; state?: 'open' | 'closed' | 'all' };
    result: { issues: IssueHit[] };
  };
  /** An item's pull request with its CI and review feedback, including feedback agents never see. */
  'item.pr': { args: { itemId: string }; result: PullView };
  /** From the runner: something changed on GitHub; poll it now instead of at the next interval. */
  'github.nudge': {
    args: { repo: string; kind: 'issue' | 'pull' | 'checks'; number?: number };
    result: Record<string, never>;
  };
  'definition.apply': { args: { definition: unknown; pin: Pin }; result: { classes: string[] } };
  /** Fresh harness credential files from the app; `content: null` removes one (the user signed out of it). */
  'credentials.put': { args: { harness: { id: string; content: string | null }[] }; result: Record<string, never> };
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
/** What the app's client returns: `snapshot.get` assembled from its parts. */
export type ClientResult<O extends Op> = O extends 'snapshot.get' ? Snapshot : OpResult<O>;

// A record keyed by Op keeps this list total: a new op without an entry
// here fails to compile.
const OP_TABLE: Record<Op, true> = {
  'snapshot.get': true,
  'snapshot.part': true,
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
  'item.link': true,
  'item.unlink': true,
  'item.workflow': true,
  'item.records': true,
  'item.publish': true,
  'item.delete': true,
  'issue.import': true,
  'issue.search': true,
  'item.pr': true,
  'github.nudge': true,
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
 * definition and upgrade commands are issued by the main process only, and
 * `github.nudge` by the runner only.
 */
export type RendererOp =
  | 'snapshot.get'
  | 'snapshot.part'
  | 'session.history'
  | 'chat.send'
  | 'session.interrupt'
  | 'ask.answer'
  | Extract<Op, `item.${string}`>
  | 'issue.import'
  | 'issue.search'
  | 'scheduler.pause'
  | 'scheduler.resume'
  | 'logs.tail';

export const RENDERER_OPS: readonly RendererOp[] = OPS.filter(
  (op): op is RendererOp =>
    op.startsWith('item.') ||
    [
      'snapshot.get',
      'snapshot.part',
      'session.history',
      'chat.send',
      'session.interrupt',
      'ask.answer',
      'issue.import',
      'issue.search',
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
  | { kind: 'instance.definition'; sha: string; pin: Pin; classes: string[]; repos?: { github: string; dir: string }[] }
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
  | { kind: 'daemon.upgrading'; mode: 'drain' | 'now' }
  /* Journaled first (src/daemon/delivery/journal.ts), then emitted. */
  | { kind: 'step.changed'; itemId: string; step: Step; from: StepState | null; trigger: string }
  | { kind: 'round.opened'; itemId: string; roundId: string; round: number; purpose: ImplementPurpose; reason: string }
  | {
      kind: 'round.settled';
      itemId: string;
      roundId: string;
      round: number;
      gate: Gate;
      outcome: 'settled' | 'superseded' | 'cancelled';
      obligations: string[];
    }
  | { kind: 'ticket.removed'; itemId: string; number: number; title: string; status: ItemStatus; outcome: ItemOutcome | null }
  | { kind: 'ticket.reference'; itemId: string; op: 'add' | 'update' | 'remove'; reference: Reference }
  | ({ kind: 'merge.observed' } & MergeObserved);

/** A merge of a ticket's delivery pull request, as the daemon saw it on GitHub. */
export interface MergeObserved {
  itemId: string;
  repo: string;
  prNumber: number;
  prHeadSha: string;
  prCommits: number;
  mergeCommitSha: string | null;
  mergeParents: string[];
  mergedAt: number;
  mergedBy: string | null;
  method: 'squash' | 'merge' | 'rebase' | null;
  initiatedBy: 'puck' | 'external' | 'unknown';
  reviewedHeadSha: string | null;
  reviewed: boolean;
}

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
  'step.changed': true,
  'round.opened': true,
  'round.settled': true,
  'ticket.removed': true,
  'ticket.reference': true,
  'merge.observed': true,
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
