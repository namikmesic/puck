import { describe, expect, it } from 'vitest';
import type { ItemStatusV1, RoundInfo, Step, StepKind, StepResult, StepState, WorkItemV1 } from '../../src/harness/daemon-protocol';
import {
  capText,
  createStep,
  findStepTransition,
  groupOf,
  isReady,
  latestAttempts,
  legacyIds,
  mapLegacy,
  moveStep,
  readyState,
  roundSteps,
  stageOf,
  statusV1,
  STEP_TRANSITIONS,
  stepHoldsSlot,
  StepStateError,
  summarize,
  SUMMARY_LIMITS,
  upgradeV1Item,
  type StepTrigger,
} from '../../src/harness/workflow';

// The step machine is one closed table for every step kind (4.4): every row
// below is allowed, and every other move is refused.

const STATES: StepState[] = ['pending', 'queued', 'running', 'needs-input', 'waiting', 'done'];
const KINDS: StepKind[] = ['decompose', 'implement', 'checks', 'review', 'publish', 'ci', 'merge'];

type Row = [StepState, StepTrigger, StepState, StepResult | null, 'acquires' | 'keeps' | 'releases' | null, StepKind[] | null];

const EXPECTED: Row[] = [
  ['pending', 'ready', 'queued', null, null, null],
  ['pending', 'ready', 'running', null, null, null],
  ['pending', 'ready', 'waiting', null, null, null],
  ['queued', 'start', 'running', null, 'acquires', null],
  ['running', 'ask', 'needs-input', null, 'keeps', ['implement']],
  ['needs-input', 'answer', 'running', null, 'keeps', null],
  ['queued', 'decide', 'needs-input', null, 'releases', ['checks', 'publish', 'ci', 'merge']],
  ['running', 'decide', 'needs-input', null, 'releases', ['checks', 'publish', 'ci', 'merge']],
  ['waiting', 'decide', 'needs-input', null, 'releases', ['checks', 'publish', 'ci', 'merge']],
  ['running', 'finish', 'done', 'passed', 'releases', null],
  ['running', 'finish', 'done', 'failed', 'releases', null],
  ['running', 'finish', 'done', 'inconclusive', 'releases', null],
  ['waiting', 'finish', 'done', 'passed', null, null],
  ['waiting', 'finish', 'done', 'failed', null, null],
  ['running', 'wait', 'waiting', null, 'releases', null],
  ['running', 'error', 'queued', null, 'releases', ['implement']],
  ['running', 'error-final', 'done', 'failed', 'releases', ['implement']],
  ['running', 'restart', 'queued', null, 'releases', ['implement']],
  ['needs-input', 'restart', 'queued', null, 'releases', ['implement']],
  ['queued', 'supersede', 'done', 'superseded', 'releases', null],
  ['running', 'supersede', 'done', 'superseded', 'releases', null],
  ['waiting', 'supersede', 'done', 'superseded', 'releases', null],
  ['needs-input', 'supersede', 'done', 'superseded', 'releases', null],
  ['pending', 'skip', 'done', 'skipped', null, null],
  ['queued', 'skip', 'done', 'skipped', null, null],
  ['pending', 'cancel', 'done', 'cancelled', 'releases', null],
  ['queued', 'cancel', 'done', 'cancelled', 'releases', null],
  ['running', 'cancel', 'done', 'cancelled', 'releases', null],
  ['needs-input', 'cancel', 'done', 'cancelled', 'releases', null],
  ['waiting', 'cancel', 'done', 'cancelled', 'releases', null],
];

function step(over: Partial<Step> & Pick<Step, 'kind' | 'state'>): Step {
  return { ...createStep({ id: over.id ?? `stp_${over.kind}`, kind: over.kind, round: over.round ?? 1, at: 0 }), result: null, ...over };
}

describe('step state machine', () => {
  it('has exactly the designed moves, outside the decided matrix', () => {
    const table = STEP_TRANSITIONS.filter((t) => t.trigger !== 'decided').flatMap((t) =>
      t.from.flatMap((from) => t.to.flatMap((to) => (to === 'done' ? (t.results ?? []).map((r) => `${from}:${t.trigger}:${to}:${r}`) : [`${from}:${t.trigger}:${to}:`]))),
    );
    expect(table.sort()).toEqual(EXPECTED.map(([from, trigger, to, result]) => `${from}:${trigger}:${to}:${result ?? ''}`).sort());
  });

  it.each(EXPECTED.map((row) => [`${row[0]} --${row[1]}--> ${row[2]}${row[3] ? ` (${row[3]})` : ''}`, row] as const))('%s', (_name, [from, trigger, to, result, slot, kinds]) => {
    for (const kind of kinds ?? KINDS) {
      const before = step({ kind, state: from });
      const after = moveStep(before, trigger, to, 100, { result });
      expect(after.state).toBe(to);
      expect(after.result).toBe(to === 'done' ? result : null);
      const held = stepHoldsSlot(before);
      const holds = stepHoldsSlot(after);
      if (slot === 'acquires' && (kind === 'implement' || kind === 'review' || kind === 'checks')) expect([held, holds]).toEqual([false, true]);
      if (slot === 'keeps' && kind === 'implement') expect([held, holds]).toEqual([true, true]);
      if (slot === 'releases') expect(holds).toBe(false);
    }
    for (const kind of KINDS.filter((k) => kinds && !kinds.includes(k))) {
      expect(() => moveStep(step({ kind, state: from }), trigger, to, 100, { result })).toThrow(StepStateError);
    }
  });

  it('refuses every other move, and a done step never moves again', () => {
    const triggers: StepTrigger[] = ['ready', 'start', 'ask', 'answer', 'decide', 'finish', 'wait', 'error', 'error-final', 'restart', 'supersede', 'skip', 'cancel'];
    const allowed = new Set(EXPECTED.map(([f, t, to]) => `${f}:${t}:${to}`));
    for (const from of STATES) {
      for (const trigger of triggers) {
        for (const to of STATES) {
          if (allowed.has(`${from}:${trigger}:${to}`)) continue;
          expect(findStepTransition({ kind: 'implement', state: from }, trigger, to, to === 'done' ? 'passed' : null), `${from} ${trigger} ${to}`).toBeNull();
        }
      }
    }
    for (const trigger of triggers) expect(() => moveStep(step({ kind: 'implement', state: 'done', result: 'passed' }), trigger, 'done', 1, { result: 'passed' })).toThrow(StepStateError);
  });

  it('stamps queuedAt, startedAt and finishedAt as a step moves', () => {
    let s = step({ kind: 'implement', state: 'pending' });
    s = moveStep(s, 'ready', 'queued', 10);
    expect(s.queuedAt).toBe(10);
    s = moveStep(s, 'start', 'running', 20);
    expect(s.startedAt).toBe(20);
    s = moveStep(s, 'finish', 'done', 30, { result: 'passed' });
    expect([s.finishedAt, s.result]).toEqual([30, 'passed']);
  });

  it('gives ready the state each kind waits in', () => {
    expect(readyState('implement')).toBe('queued');
    expect(readyState('review')).toBe('queued');
    expect(readyState('checks')).toBe('queued');
    expect(readyState('checks', { runsCommands: false })).toBe('running');
    expect(readyState('decompose')).toBe('running');
    expect(readyState('publish')).toBe('running');
    expect(readyState('publish', { manual: true })).toBe('waiting');
    expect(readyState('ci')).toBe('waiting');
    expect(readyState('merge')).toBe('running');
    expect(readyState('merge', { ask: true })).toBe('waiting');
    expect(readyState('merge', { manual: true })).toBe('waiting');
  });

  it('holds a slot for running implement, review and command-running checks steps, and a worker waiting on its question', () => {
    expect(stepHoldsSlot({ kind: 'implement', state: 'running' })).toBe(true);
    expect(stepHoldsSlot({ kind: 'implement', state: 'needs-input' })).toBe(true);
    expect(stepHoldsSlot({ kind: 'review', state: 'running' })).toBe(true);
    expect(stepHoldsSlot({ kind: 'checks', state: 'running' })).toBe(true);
    expect(stepHoldsSlot({ kind: 'checks', state: 'running' }, false)).toBe(false);
    expect(stepHoldsSlot({ kind: 'review', state: 'needs-input' })).toBe(false);
    for (const s of ['pending', 'queued', 'waiting', 'done'] as StepState[]) expect(stepHoldsSlot({ kind: 'implement', state: s })).toBe(false);
    for (const kind of ['decompose', 'publish', 'ci', 'merge'] as StepKind[]) expect(stepHoldsSlot({ kind, state: 'running' })).toBe(false);
  });
});

describe('readiness groups', () => {
  it('orders a round by group: decompose, implement, integrate, checks, review, publish, ci, merge', () => {
    expect(KINDS.map((k) => groupOf(k, null))).toEqual([0, 1, 3, 4, 5, 6, 7]);
    expect(groupOf('implement', 'integrate')).toBe(2);
  });

  it('keeps the latest attempt of each logical step, in step order', () => {
    const merge = step({ id: 'stp_m', kind: 'merge', state: 'pending' });
    const first = step({ id: 'stp_i1', kind: 'implement', state: 'done', result: 'failed' });
    const retry = { ...step({ id: 'stp_i2', kind: 'implement', state: 'queued' }), logicalId: 'stp_i1', attempt: 2, retryOf: 'stp_i1' };
    const other = step({ id: 'stp_x', kind: 'implement', state: 'queued', round: 2 });
    expect(latestAttempts([merge, first, retry]).map((s) => s.id)).toEqual(['stp_i2', 'stp_m']);
    expect(roundSteps([merge, first, retry, other], 2).map((s) => s.id)).toEqual(['stp_x']);
  });

  it('without delivery, the manual merge step is ready once every implement step is done without failing', () => {
    const merge = step({ kind: 'merge', state: 'pending' });
    const running = step({ kind: 'implement', state: 'running' });
    expect(isReady(merge, [running, merge], { delivery: false })).toBe(false);
    expect(isReady(merge, [{ ...running, state: 'done', result: 'passed' }, merge], { delivery: false })).toBe(true);
    expect(isReady(merge, [{ ...running, state: 'done', result: 'cancelled' }, merge], { delivery: false })).toBe(true);
    expect(isReady(merge, [{ ...running, state: 'done', result: 'failed' }, merge], { delivery: false })).toBe(false);
  });

  it('with delivery, each group waits for the one below it to pass', () => {
    const decompose = step({ id: 'd', kind: 'decompose', state: 'done', result: 'skipped' });
    const implement = step({ id: 'i', kind: 'implement', state: 'pending' });
    const checks = step({ id: 'c', kind: 'checks', state: 'pending' });
    const review = step({ id: 'r', kind: 'review', state: 'pending' });
    const publish = step({ id: 'p', kind: 'publish', state: 'pending' });
    const ctx = { delivery: true };
    expect(isReady(implement, [decompose, implement, checks], ctx)).toBe(true);
    expect(isReady(checks, [decompose, { ...implement, state: 'running' }, checks], ctx)).toBe(false);
    expect(isReady(checks, [decompose, { ...implement, state: 'done', result: 'passed' }, checks], ctx)).toBe(true);
    expect(isReady(review, [decompose, { ...implement, state: 'done', result: 'passed' }, { ...checks, state: 'done', result: 'passed' }, review], ctx)).toBe(true);
    expect(isReady(review, [decompose, { ...implement, state: 'done', result: 'passed' }, { ...checks, state: 'done', result: 'failed' }, review], ctx)).toBe(false);
    expect(isReady(publish, [publish], { delivery: true, gate: 'pending' })).toBe(false);
    expect(isReady(publish, [publish], { delivery: true, gate: 'clear' })).toBe(true);
    const chained = { ...step({ id: 'i2', kind: 'implement', state: 'pending' }), after: 'i' };
    expect(isReady(chained, [decompose, { ...implement, state: 'running' }, chained], ctx)).toBe(false);
    expect(isReady(chained, [decompose, { ...implement, state: 'done', result: 'passed' }, chained], ctx)).toBe(true);
  });
});

describe('stage', () => {
  it('is null in todo and done, and otherwise the first step of the latest round not done', () => {
    const implement = step({ id: 'i', kind: 'implement', state: 'running' });
    expect(stageOf('todo', [implement])).toBeNull();
    expect(stageOf('done', [implement])).toBeNull();
    expect(stageOf('in-progress', [implement])).toBe('implement');
    const finished = { ...implement, state: 'done' as const, result: 'passed' as const, finishedAt: 5 };
    const merge = step({ id: 'm', kind: 'merge', state: 'waiting' });
    expect(stageOf('in-progress', [finished, merge])).toBe('merge');
    // Round 2 wins over round 1; when every step of it is done, the last one that finished.
    const round2 = step({ id: 'i2', kind: 'implement', state: 'queued', round: 2 });
    expect(stageOf('in-progress', [finished, { ...merge, state: 'done', result: 'superseded', finishedAt: 6 }, round2])).toBe('implement');
    expect(stageOf('in-progress', [finished, { ...merge, state: 'done', result: 'passed', finishedAt: 9 }])).toBe('merge');
    expect(stageOf('in-progress', [])).toBeNull();
  });
});

describe('summary', () => {
  const round = (n: number): RoundInfo => ({ round: n, roundId: `rnd_${n}`, purpose: 'task', headSha: null, gate: 'pending', settledGate: null, outcome: 'open', startedAt: 0, settledAt: null });

  it('shows the current round only, in step order, at most 24 steps and 6 KiB', () => {
    const steps: Step[] = [step({ id: 'old', kind: 'implement', state: 'done', result: 'passed' })];
    for (let i = 0; i < 40; i++) steps.push({ ...step({ id: `s${i}`, kind: 'implement', state: 'queued', round: 2 }), detail: 'é'.repeat(200) });
    const summary = summarize([round(1), round(2)], steps, { roundsAllowed: 0 });
    expect(summary?.round).toBe(2);
    expect(summary?.steps).toHaveLength(SUMMARY_LIMITS.steps);
    expect(summary?.steps.every((s) => s.id !== 'old')).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(summary)).length).toBeLessThanOrEqual(SUMMARY_LIMITS.bytes);
    expect(summary?.policy).toEqual({ merge: 'manual', require: null, panel: [] });
    expect(summarize([], [], { roundsAllowed: 0 })).toBeNull();
  });

  it('cuts text by UTF-8 bytes', () => {
    expect(capText('abc', 10)).toBe('abc');
    const cut = capText('é'.repeat(100), 20);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(20);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe("protocol 1's statuses and the three-state model", () => {
  // 4.1's table: the one mapping the migration, the projection and the app's fallback share.
  const MAPPING: Array<[ItemStatusV1, boolean, 'open' | 'merged' | undefined, boolean, ReturnType<typeof mapLegacy>]> = [
    ['backlog', false, undefined, false, { status: 'todo', outcome: null, stage: null, implement: null, merge: null }],
    ['queued', false, undefined, false, { status: 'todo', outcome: null, stage: null, implement: { state: 'queued', result: null }, merge: null }],
    ['queued', true, undefined, false, { status: 'in-progress', outcome: null, stage: 'implement', implement: { state: 'queued', result: null }, merge: null }],
    ['running', true, undefined, false, { status: 'in-progress', outcome: null, stage: 'implement', implement: { state: 'running', result: null }, merge: null }],
    ['needs-input', true, undefined, false, { status: 'in-progress', outcome: null, stage: 'implement', implement: { state: 'needs-input', result: null }, merge: null }],
    ['review', true, undefined, false, { status: 'in-progress', outcome: null, stage: 'merge', implement: { state: 'done', result: 'passed' }, merge: { state: 'waiting' } }],
    ['review', true, undefined, true, { status: 'in-progress', outcome: null, stage: 'merge', implement: { state: 'done', result: 'cancelled' }, merge: { state: 'waiting' } }],
    ['done', true, 'merged', false, { status: 'done', outcome: 'merged', stage: null, implement: { state: 'done', result: 'passed' }, merge: null }],
    ['done', true, 'open', false, { status: 'done', outcome: 'accepted', stage: null, implement: { state: 'done', result: 'passed' }, merge: null }],
    ['failed', true, undefined, false, { status: 'done', outcome: 'failed', stage: null, implement: { state: 'done', result: 'failed' }, merge: null }],
    ['cancelled', false, undefined, false, { status: 'done', outcome: 'cancelled', stage: null, implement: { state: 'done', result: 'cancelled' }, merge: null }],
  ];

  it.each(MAPPING.map((m) => [`${m[0]}${m[1] ? ' with a session' : ''}${m[2] ? ` (${m[2]})` : ''}${m[3] ? ' interrupted' : ''}`, m] as const))('%s', (_n, [status, session, prState, interrupted, want]) => {
    expect(mapLegacy({ status, sessionId: session ? 'ses_1' : null, agent: 'implementer', prState, interrupted })).toEqual(want);
  });

  it('sends a queued ticket with no agent to Todo without a step, with or without a session: nothing would run it', () => {
    for (const sessionId of [null, 'ses_1']) {
      expect(mapLegacy({ status: 'queued', sessionId, agent: null, interrupted: false })).toEqual({ status: 'todo', outcome: null, stage: null, implement: null, merge: null });
    }
  });

  function v1(over: Partial<WorkItemV1> & Pick<WorkItemV1, 'status'>): WorkItemV1 {
    return {
      id: 'itm_01J0000000000000000000000A',
      number: 3,
      title: 'T',
      body: '',
      agent: 'implementer',
      repo: 'web',
      createdBy: 'user',
      createdAt: 1,
      updatedAt: 2,
      attempts: 1,
      sessionId: 'ses_1',
      branch: null,
      worktree: null,
      base: null,
      result: null,
      pr: null,
      source: null,
      lastError: null,
      cancelReason: null,
      acceptNote: null,
      pendingAsk: null,
      ...over,
    };
  }

  it('maps a protocol-1 item up and projects it back to the same status', () => {
    for (const status of ['backlog', 'queued', 'running', 'needs-input', 'review', 'done', 'failed', 'cancelled'] as ItemStatusV1[]) {
      const up = upgradeV1Item(v1({ status, agent: status === 'backlog' ? null : 'implementer', sessionId: status === 'backlog' ? null : 'ses_1' }));
      expect(statusV1(up), status).toBe(status);
    }
  });

  it('carries source, pull request and a pending question into references and needsInput', () => {
    const ids = legacyIds('itm_01J0000000000000000000000A');
    const up = upgradeV1Item(
      v1({
        status: 'needs-input',
        source: { kind: 'github-issue', repo: 'acme/web', number: 12, url: 'https://github.com/acme/web/issues/12', updatedAt: 5 },
        pr: { number: 40, url: 'https://github.com/acme/web/pull/40', draft: false, lastPushedSha: 'abc', state: 'open' },
        pendingAsk: { askId: 'ask_1', routedTo: 'user' },
      }),
    );
    expect(up.references.map((r) => [r.role, r.kind])).toEqual([
      ['source', 'github-issue'],
      ['delivery', 'github-pr'],
    ]);
    expect(up.references[1]).toMatchObject({ repo: 'acme/web', number: 40 });
    expect(up.needsInput).toEqual({ askId: 'ask_1', kind: 'question', roundId: ids.roundId, stepId: ids.implementId, routedTo: 'user', since: 2 });
    expect([up.openAsks, up.userAsks, up.oldestUserAsk?.askId]).toEqual([1, 1, 'ask_1']);
  });

  it('derives the legacy ids from the ticket id, so a second run gives the same ones', () => {
    expect(legacyIds('itm_01J0000000000000000000000A')).toEqual({
      workflowId: 'wfl_01J0000000000000000000000A',
      roundId: 'rnd_01J0000000000000000000000A_1',
      implementId: 'stp_01J0000000000000000000000A_i1',
      mergeId: 'stp_01J0000000000000000000000A_m1',
    });
  });
});
