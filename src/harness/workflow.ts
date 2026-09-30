/**
 * A ticket's workflow: an append-only list of steps grouped in rounds, the
 * closed table every step moves through, readiness, the ticket's stage,
 * the bounded summary clients see, and the one mapping between protocol 1's
 * eight statuses and the three-state model (used by the format-2
 * migration, the daemon's protocol-1 projection and the app's protocol-1
 * fallback). Pure: shared by the daemon, the app and the renderer.
 * `docs/delivery-workflow-spec.md` (4.2, 4.4, 12) is the design.
 *
 * Step order within a round is the readiness group, then creation:
 * decompose (0), implement (1), an integrate implement step (2), checks
 * (3), review (4), publish (5), ci (6), merge (7). Without a delivery block
 * a round has only decompose, implement and a manual merge step, which
 * waits for the user's Accept or for GitHub to report the pull request
 * merged: today's Review column, inside In progress.
 *
 * Every attempt of a logical step is its own record with the same
 * `logicalId`; readiness, the stage and the summary read the latest
 * attempt of each. A step in `done` never changes again.
 */

import type {
  Gate,
  ImplementPurpose,
  ItemOutcome,
  ItemStatus,
  ItemStatusV1,
  Reference,
  RoundInfo,
  Step,
  StepKind,
  StepResult,
  StepState,
  StepSummary,
  WorkItem,
  WorkItemV1,
  WorkflowSummary,
} from './daemon-protocol';

export type StepTrigger =
  | 'create'
  | 'legacy'
  | 'ready'
  | 'start'
  | 'ask'
  | 'answer'
  | 'decide'
  | 'decided'
  | 'finish'
  | 'wait'
  | 'error'
  | 'error-final'
  | 'restart'
  | 'supersede'
  | 'skip'
  | 'cancel';

export type SlotEffect = 'acquires' | 'keeps' | 'releases' | null;

export interface StepTransition {
  from: readonly StepState[];
  trigger: StepTrigger;
  to: readonly StepState[];
  /** For moves into `done`: the results allowed. */
  results?: readonly StepResult[];
  /** Kinds the row applies to (every kind when absent). */
  kinds?: readonly StepKind[];
  slot: SlotEffect;
}

const ACTIVE: readonly StepState[] = ['pending', 'queued', 'running', 'needs-input', 'waiting'];
const DECIDABLE: readonly StepKind[] = ['checks', 'publish', 'ci', 'merge'];

/** The closed step table. `create` and `legacy` are creation (from nothing), not moves. */
export const STEP_TRANSITIONS: readonly StepTransition[] = [
  { from: ['pending'], trigger: 'ready', to: ['queued', 'running', 'waiting'], slot: null },
  { from: ['queued'], trigger: 'start', to: ['running'], slot: 'acquires' },
  { from: ['running'], trigger: 'ask', to: ['needs-input'], kinds: ['implement'], slot: 'keeps' },
  { from: ['needs-input'], trigger: 'answer', to: ['running'], slot: 'keeps' },
  // A decision attaches to a checks (setup), publish, CI or merge step (7.10); an implement step waits in needs-input only on its worker's question.
  { from: ['queued', 'running', 'waiting'], trigger: 'decide', to: ['needs-input'], kinds: DECIDABLE, slot: 'releases' },
  { from: ['needs-input'], trigger: 'decided', to: ['queued', 'running', 'waiting', 'done'], kinds: DECIDABLE, slot: null },
  { from: ['running'], trigger: 'finish', to: ['done'], results: ['passed', 'failed', 'inconclusive'], slot: 'releases' },
  { from: ['waiting'], trigger: 'finish', to: ['done'], results: ['passed', 'failed'], slot: null },
  { from: ['running'], trigger: 'wait', to: ['waiting'], slot: 'releases' },
  { from: ['running'], trigger: 'error', to: ['queued'], kinds: ['implement'], slot: 'releases' },
  { from: ['running'], trigger: 'error-final', to: ['done'], results: ['failed'], kinds: ['implement'], slot: 'releases' },
  { from: ['running', 'needs-input'], trigger: 'restart', to: ['queued'], kinds: ['implement'], slot: 'releases' },
  { from: ['queued', 'running', 'waiting', 'needs-input'], trigger: 'supersede', to: ['done'], results: ['superseded'], slot: 'releases' },
  { from: ['pending', 'queued'], trigger: 'skip', to: ['done'], results: ['skipped'], slot: null },
  { from: ACTIVE, trigger: 'cancel', to: ['done'], results: ['cancelled'], slot: 'releases' },
];

export class StepStateError extends Error {
  readonly code = 'invalid-state';
}

/** The row that allows this move, or null. */
export function findStepTransition(step: Pick<Step, 'kind' | 'state'>, trigger: StepTrigger, to: StepState, result: StepResult | null): StepTransition | null {
  return (
    STEP_TRANSITIONS.find(
      (t) =>
        t.trigger === trigger &&
        t.from.includes(step.state) &&
        t.to.includes(to) &&
        (!t.kinds || t.kinds.includes(step.kind)) &&
        (to === 'done' ? !!result && (!t.results || t.results.includes(result)) : result === null),
    ) ?? null
  );
}

/** The state `ready` moves a pending step to. */
export function readyState(kind: StepKind, opts: { manual?: boolean; ask?: boolean; runsCommands?: boolean } = {}): StepState {
  switch (kind) {
    case 'implement':
    case 'review':
      return 'queued';
    case 'checks':
      return opts.runsCommands === false ? 'running' : 'queued';
    case 'decompose':
      return 'running';
    case 'publish':
      return opts.manual ? 'waiting' : 'running';
    case 'ci':
      return 'waiting';
    case 'merge':
      return opts.manual || opts.ask ? 'waiting' : 'running';
  }
}

/**
 * Move a step: the next record, or a StepStateError. Timestamps follow the
 * move (`queuedAt` entering `queued`, `startedAt` entering `running` from
 * `queued`, `finishedAt` entering `done`).
 */
export function moveStep(
  step: Step,
  trigger: StepTrigger,
  to: StepState,
  at: number,
  opts: { result?: StepResult | null; patch?: Partial<Omit<Step, 'id' | 'kind' | 'state' | 'result' | 'logicalId'>> } = {},
): Step {
  const result = to === 'done' ? (opts.result ?? null) : null;
  if (!findStepTransition(step, trigger, to, result)) {
    throw new StepStateError(`${/^[aeiou]/.test(step.kind) ? 'An' : 'A'} ${step.kind} step cannot ${trigger} from ${step.state}${to === 'done' ? ` to ${result ?? 'done'}` : ` to ${to}`}.`);
  }
  const next: Step = { ...step, ...opts.patch, state: to, result };
  if (to === 'queued') next.queuedAt = at;
  if (to === 'running' && step.state === 'queued') next.startedAt = at;
  if (to === 'running' && next.startedAt === null) next.startedAt = at;
  if (to === 'done') next.finishedAt = at;
  return next;
}

/** A step as it is created: pending, or (bootstrap only, `legacy`) any state. */
export function createStep(init: {
  id: string;
  kind: StepKind;
  round: number;
  at: number;
  agent?: string | null;
  sessionId?: string | null;
  purpose?: ImplementPurpose | null;
  retryOf?: Step | null;
  detail?: string;
}): Step {
  const retryOf = init.retryOf ?? null;
  return {
    id: init.id,
    kind: init.kind,
    round: init.round,
    state: 'pending',
    result: null,
    agent: init.agent ?? null,
    sessionId: init.sessionId ?? null,
    reviewId: null,
    task: null,
    purpose: init.kind === 'implement' ? (init.purpose ?? 'task') : null,
    group: groupOf(init.kind, init.purpose ?? null),
    after: null,
    logicalId: retryOf ? retryOf.logicalId : init.id,
    attempt: retryOf ? retryOf.attempt + 1 : 1,
    retryOf: retryOf ? retryOf.id : null,
    work: null,
    queuedAt: null,
    startedAt: null,
    finishedAt: null,
    detail: init.detail ?? '',
  };
}

/** A step's readiness group within its round. */
export function groupOf(kind: StepKind, purpose: ImplementPurpose | null): number {
  switch (kind) {
    case 'decompose':
      return 0;
    case 'implement':
      return purpose === 'integrate' ? 2 : 1;
    case 'checks':
      return 3;
    case 'review':
      return 4;
    case 'publish':
      return 5;
    case 'ci':
      return 6;
    case 'merge':
      return 7;
  }
}

/**
 * True while the step holds one of its agent's slots (and the
 * environment's): an implement or review step running, a checks step
 * running commands, or an implement step waiting on its worker's question
 * (the worker's process waits with it). Decisions never hold a slot.
 */
export function stepHoldsSlot(step: Pick<Step, 'kind' | 'state'>, runsCommands = true): boolean {
  if (step.state === 'running') return step.kind === 'implement' || step.kind === 'review' || (step.kind === 'checks' && runsCommands);
  return step.state === 'needs-input' && step.kind === 'implement';
}

export function isActive(step: Pick<Step, 'state'>): boolean {
  return step.state !== 'done';
}

/** The latest attempt of each logical step, in step order (group, then creation). */
export function latestAttempts(steps: readonly Step[]): Step[] {
  const latest = new Map<string, { step: Step; index: number }>();
  steps.forEach((step, index) => {
    const seen = latest.get(step.logicalId);
    if (!seen || step.attempt >= seen.step.attempt) latest.set(step.logicalId, { step, index: seen ? seen.index : index });
  });
  return [...latest.values()].sort((a, b) => a.step.group - b.step.group || a.index - b.index).map((e) => e.step);
}

/** The latest attempts of one round, in step order. */
export function roundSteps(steps: readonly Step[], round: number): Step[] {
  return latestAttempts(steps.filter((s) => s.round === round));
}

export function latestRound<R extends Pick<RoundInfo, 'round'>>(rounds: readonly R[]): R | null {
  return rounds.reduce<R | null>((a, r) => (!a || r.round > a.round ? r : a), null);
}

/**
 * Whether a pending step may become ready now (4.4). `delivery` is false
 * for an environment without a delivery block, where a round has only
 * groups 0, 1 and 7 and its manual merge step is ready once every
 * implement step is done without failing.
 */
export function isReady(step: Step, round: readonly Step[], ctx: { delivery: boolean; gate?: Gate }): boolean {
  if (step.state !== 'pending') return false;
  const lower = round.filter((s) => s.group < step.group);
  if (!ctx.delivery && step.kind === 'merge') {
    const work = round.filter((s) => s.kind === 'implement');
    return work.length > 0 && work.every((s) => s.state === 'done' && s.result !== 'failed');
  }
  if (lower.some((s) => s.state === 'done' && (s.result === 'failed' || s.result === 'cancelled'))) return false;
  const passed = (group: number): boolean => round.filter((s) => s.group === group).every((s) => s.state === 'done' && s.result === 'passed');
  switch (step.group) {
    case 0:
      return true;
    case 1: {
      if (!round.filter((s) => s.group === 0).every((s) => s.state === 'done')) return false;
      if (!step.after) return true;
      const after = round.find((s) => s.id === step.after || s.logicalId === step.after);
      return after?.state === 'done' && after.result === 'passed';
    }
    case 2:
      return passed(1);
    case 3:
      return passed(1) && passed(2);
    case 4:
      return passed(3);
    case 5:
      return ctx.gate === 'clear';
    default: {
      const prev = [...lower].reverse().find((s) => s.group === step.group - 1);
      return prev?.state === 'done' && prev.result === 'passed';
    }
  }
}

/**
 * The ticket's stage: null in Todo and Done. In progress, the kind of the
 * first step of the latest round, in step order, that is not done; when
 * every step of that round is done, the kind of the last one that finished.
 */
export function stageOf(status: ItemStatus, steps: readonly Step[]): StepKind | null {
  if (status !== 'in-progress' || !steps.length) return null;
  const round = Math.max(...steps.map((s) => s.round));
  const current = roundSteps(steps, round);
  const open = current.find((s) => s.state !== 'done');
  if (open) return open.kind;
  const last = current.reduce<Step | null>((a, s) => (!a || (s.finishedAt ?? 0) >= (a.finishedAt ?? 0) ? s : a), null);
  return last?.kind ?? null;
}

export const SUMMARY_LIMITS = { steps: 24, bytes: 6 * 1024, detailBytes: 160 } as const;

const encoder = new TextEncoder();

function bytes(text: string): number {
  return encoder.encode(text).length;
}

/** Cut text to at most `max` UTF-8 bytes, ending in an ellipsis when cut. */
export function capText(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  let out = text;
  while (out && bytes(out) > max - 3) out = out.slice(0, -1);
  return `${out}…`;
}

export function stepSummary(step: Step): StepSummary {
  return { id: step.id, kind: step.kind, state: step.state, result: step.result, agent: step.agent, detail: capText(step.detail, SUMMARY_LIMITS.detailBytes) };
}

/**
 * The bounded summary of a ticket's current round (6.4): at most 24 steps,
 * at most 6 KiB serialized; details are shortened to fit.
 */
export function summarize(
  rounds: readonly RoundInfo[],
  steps: readonly Step[],
  opts: { roundsAllowed: number; policy?: WorkflowSummary['policy']; obligations?: number; openFindings?: number },
): WorkflowSummary | null {
  const round = latestRound(rounds);
  if (!round) return null;
  const summary: WorkflowSummary = {
    round: round.round,
    roundsAllowed: opts.roundsAllowed,
    gate: round.gate,
    headSha: round.headSha,
    steps: roundSteps(steps, round.round).slice(0, SUMMARY_LIMITS.steps).map(stepSummary),
    obligations: opts.obligations ?? 0,
    openFindings: opts.openFindings ?? 0,
    policy: opts.policy ?? { merge: 'manual', require: null, panel: [] },
  };
  for (let cap: number = SUMMARY_LIMITS.detailBytes; bytes(JSON.stringify(summary)) > SUMMARY_LIMITS.bytes && cap > 0; cap = Math.floor(cap / 2)) {
    summary.steps = summary.steps.map((s) => ({ ...s, detail: capText(s.detail, cap) }));
  }
  return summary;
}

/* ---------- Protocol 1's statuses and the three-state model ---------- */

/** The ids the format-2 migration derives from a ticket's own id, so running it twice gives the same ones. */
export function legacyIds(itemId: string): { workflowId: string; roundId: string; implementId: string; mergeId: string } {
  const suffix = itemId.replace(/^itm_/, '');
  return { workflowId: `wfl_${suffix}`, roundId: `rnd_${suffix}_1`, implementId: `stp_${suffix}_i1`, mergeId: `stp_${suffix}_m1` };
}

/** Every ticket's workflow id: one workflow per ticket, derived from its id. */
export function workflowIdOf(itemId: string): string {
  return legacyIds(itemId).workflowId;
}

export interface LegacyShape {
  status: ItemStatusV1;
  sessionId: string | null;
  /** The agent the ticket runs with; a queued ticket without one has nothing to run it. */
  agent: string | null;
  /** The pull request's state as protocol 1 last recorded it. */
  prState?: 'open' | 'closed' | 'merged';
  interrupted: boolean;
}

export interface LegacyMapping {
  status: ItemStatus;
  outcome: ItemOutcome | null;
  stage: StepKind | null;
  /** The ticket's implement step, or null (`backlog` gets none). */
  implement: { state: StepState; result: StepResult | null } | null;
  /** The manual merge step (`review` only). */
  merge: { state: StepState } | null;
}

/**
 * Protocol 1's status in the three-state model (4.1's table): the one
 * mapping the migration, the projection and the app's fallback share.
 */
export function mapLegacy(item: LegacyShape): LegacyMapping {
  const implement = (state: StepState, result: StepResult | null = null) => ({ state, result });
  switch (item.status) {
    case 'backlog':
      return { status: 'todo', outcome: null, stage: null, implement: null, merge: null };
    case 'queued':
      // Queued with no agent (unassigned after it ran, its session's owner unknown): nothing would pick it up,
      // so it waits in Todo like a backlog ticket until someone assigns it.
      if (!item.agent) return { status: 'todo', outcome: null, stage: null, implement: null, merge: null };
      return item.sessionId
        ? { status: 'in-progress', outcome: null, stage: 'implement', implement: implement('queued'), merge: null }
        : { status: 'todo', outcome: null, stage: null, implement: implement('queued'), merge: null };
    case 'running':
    case 'needs-input':
      return { status: 'in-progress', outcome: null, stage: 'implement', implement: implement(item.status), merge: null };
    case 'review':
      return {
        status: 'in-progress',
        outcome: null,
        stage: 'merge',
        implement: implement('done', item.interrupted ? 'cancelled' : 'passed'),
        merge: { state: 'waiting' },
      };
    case 'done':
      return { status: 'done', outcome: item.prState === 'merged' ? 'merged' : 'accepted', stage: null, implement: implement('done', 'passed'), merge: null };
    case 'failed':
      return { status: 'done', outcome: 'failed', stage: null, implement: implement('done', 'failed'), merge: null };
    case 'cancelled':
      return { status: 'done', outcome: 'cancelled', stage: null, implement: implement('done', 'cancelled'), merge: null };
  }
}

/** The current implement step of a ticket's summary that is not done, if any. */
function activeImplement(workflow: WorkflowSummary | null): StepSummary | null {
  return workflow?.steps.find((s) => s.kind === 'implement' && s.state !== 'done') ?? null;
}

/** A protocol-2 ticket's status as protocol 1 names it (12.2). */
export function statusV1(item: Pick<WorkItem, 'status' | 'outcome' | 'agent' | 'workflow'>): ItemStatusV1 {
  if (item.status === 'todo') return item.agent ? 'queued' : 'backlog';
  if (item.status === 'done') return item.outcome === 'failed' ? 'failed' : item.outcome === 'cancelled' ? 'cancelled' : 'done';
  const step = activeImplement(item.workflow);
  if (step && (step.state === 'running' || step.state === 'needs-input' || step.state === 'queued')) return step.state;
  return 'review';
}

/** The source issue and delivery pull request of a protocol-1 item, as references with ids derived from the ticket's. */
export function referencesFromV1(item: Pick<WorkItemV1, 'id' | 'source' | 'pr'>, repo: string | null): Reference[] {
  const suffix = item.id.replace(/^itm_/, '');
  const out: Reference[] = [];
  if (item.source) {
    out.push({
      id: `ref_${suffix}_s`,
      role: 'source',
      kind: 'github-issue',
      repo: item.source.repo,
      number: item.source.number,
      url: item.source.url,
      updatedAt: item.source.updatedAt,
    });
  }
  if (item.pr) {
    const fromUrl = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(item.pr.url)?.[1];
    out.push({
      id: `ref_${suffix}_d`,
      role: 'delivery',
      kind: 'github-pr',
      repo: fromUrl ?? item.source?.repo ?? repo ?? '',
      number: item.pr.number,
      url: item.pr.url,
      draft: item.pr.draft,
      lastPushedSha: item.pr.lastPushedSha,
      ...(item.pr.state ? { state: item.pr.state } : {}),
      ...(item.pr.checks !== undefined ? { checks: item.pr.checks } : {}),
    });
  }
  return out;
}

/** The legacy steps of a mapping, as the summary shows them. */
export function legacySummarySteps(itemId: string, agent: string | null, mapping: LegacyMapping): StepSummary[] {
  const ids = legacyIds(itemId);
  const out: StepSummary[] = [];
  if (mapping.implement) {
    const stopped = mapping.merge && mapping.implement.result === 'cancelled';
    out.push({ id: ids.implementId, kind: 'implement', state: mapping.implement.state, result: mapping.implement.result, agent, detail: stopped ? 'Stopped by the user' : '' });
  }
  if (mapping.merge) out.push({ id: ids.mergeId, kind: 'merge', state: mapping.merge.state, result: null, agent: null, detail: '' });
  return out;
}

/**
 * A protocol-1 item in the three-state model: what the app shows when it
 * attached to a daemon that predates protocol 2 (12.3).
 */
export function upgradeV1Item(item: WorkItemV1): WorkItem {
  const mapping = mapLegacy({ status: item.status, sessionId: item.sessionId, agent: item.agent, prState: item.pr?.state, interrupted: !!item.result?.interrupted });
  const ids = legacyIds(item.id);
  const ask = item.pendingAsk
    ? { askId: item.pendingAsk.askId, kind: 'question' as const, roundId: ids.roundId, stepId: ids.implementId, routedTo: item.pendingAsk.routedTo, since: item.updatedAt }
    : null;
  const steps = legacySummarySteps(item.id, item.agent, mapping);
  return {
    id: item.id,
    number: item.number,
    title: item.title,
    body: item.body,
    status: mapping.status,
    stage: mapping.stage,
    outcome: mapping.outcome,
    agent: item.agent,
    repo: item.repo,
    createdBy: item.createdBy,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    closedAt: mapping.status === 'done' ? item.updatedAt : null,
    attempts: item.attempts,
    sessionId: item.sessionId,
    branch: item.branch,
    worktree: item.worktree,
    base: item.base,
    result: item.result ? { ...item.result, head: '' } : null,
    references: referencesFromV1(item, null),
    lastError: item.lastError,
    cancelReason: item.cancelReason,
    acceptNote: item.acceptNote,
    needsInput: ask,
    oldestUserAsk: ask && ask.routedTo === 'user' ? { askId: ask.askId, kind: ask.kind, roundId: ask.roundId, stepId: ask.stepId, since: ask.since } : null,
    openAsks: ask ? 1 : 0,
    userAsks: ask?.routedTo === 'user' ? 1 : 0,
    delivery: null,
    workflow:
      mapping.status === 'done' || !steps.length
        ? null
        : {
            round: 1,
            roundsAllowed: 0,
            gate: 'pending',
            headSha: null,
            steps,
            obligations: 0,
            openFindings: 0,
            policy: { merge: 'manual', require: null, panel: [] },
          },
  };
}
