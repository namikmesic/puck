/**
 * The fixture harness: a stand-in `PuckBridge` that renders the
 * environment window from seeded data, with no runner, server or sign-in.
 *
 * Dev only. `PUCK_FIXTURE=<scenario> npm run start:isolated` makes main
 * load the window with `#fixture=<scenario>`, and renderer.ts boots on this
 * bridge instead of the preload's. The import sits behind
 * `process.env.NODE_ENV !== 'production'`, so a packaged build never
 * contains it. Scenarios (`data.ts`): full (an item in every state, a
 * multi-day chat), empty, provisioning and unreachable.
 *
 * Item commands move the seeded tickets through the shared ticket table
 * (`src/harness/item-transitions.ts`), with a workflow summary that
 * mimics the daemon's steps, and stream the same events back
 * (`item.upsert`, `item.removed`, `backlog.order`), so the board, menus,
 * the Done filter and drag and drop can be exercised. `chat.send` echoes a short
 * orchestrator turn. Anything a fixture cannot do rejects with a sentence
 * saying so.
 */

import type { DaemonEventPayload, InstanceEvent, ProviderInfo, PuckBridge, RunnerEvent, RunnersState } from '../../harness/bridge';
import type { ClientResult, DaemonEvent, ItemPosition, OpArgs, RendererOp, StepSummary, WorkflowSummary, WorkItem } from '../../harness/daemon-protocol';
import { nextTicket, type TicketTrigger } from '../../harness/item-transitions';
import { deliveryPull } from '../../harness/references';
import { buildWorld, ENV_ID, ORCH, SCENARIOS, type Scenario } from './data';

const PAGE = 14;

const CAPS = { supportsAsk: true, subAgents: true, subAgentTranscript: true, streamsTokens: true, reportsCost: true };

function providers(): ProviderInfo[] {
  const harness = (id: string, label: string): ProviderInfo => ({
    kind: 'harness',
    id,
    label,
    models: ['auto'],
    thinkingLevels: ['auto'],
    systemPromptHint: '',
    configOptions: [],
    capabilities: { ...CAPS, reportsCost: id === 'claude-code' },
    status: { state: 'connected', detail: 'Signed in' },
    auth: { connected: true, detail: 'Signed in', pending: false },
  });
  return [
    harness('claude-code', 'Claude Code'),
    harness('codex', 'Codex'),
    {
      kind: 'integration',
      id: 'github',
      label: 'GitHub',
      status: { state: 'connected', detail: 'mara' },
      auth: { connected: true, detail: 'mara', pending: false },
      github: { login: 'mara', configRepo: 'acme/puck-home', installUrl: null, server: 'http://localhost:8765' },
    },
  ];
}

function runners(): RunnersState {
  return {
    signedIn: true,
    login: 'mara',
    server: 'http://localhost:8765',
    connection: 'connected',
    runners: [],
    local: { supported: false, unsupported: 'Not in the fixture harness.', installed: false, runnerId: null, busy: null, detail: '', error: null },
  };
}

export function fixtureScenario(hash: string): Scenario {
  const name = new URLSearchParams(hash.replace(/^#/, '')).get('fixture') ?? '';
  return (SCENARIOS as readonly string[]).includes(name) ? (name as Scenario) : 'full';
}

export function fixtureBridge(scenario: Scenario): PuckBridge {
  const world = buildWorld(scenario);
  const snap = world.snapshot;
  let seq = snap.head;
  let nextNumber = Math.max(0, ...snap.items.map((i) => i.number)) + 1;
  const daemonListeners: ((e: DaemonEventPayload) => void)[] = [];
  const instanceListeners: ((e: InstanceEvent) => void)[] = [];

  function emit(...evs: DaemonEvent[]): void {
    for (const ev of evs) {
      seq += 1;
      for (const cb of daemonListeners) cb({ envId: ENV_ID, seq, at: Date.now(), ev });
    }
  }

  function find(itemId: string): WorkItem {
    const it = snap.items.find((i) => i.id === itemId);
    if (!it) throw new Error('That item is not in the backlog.');
    return it;
  }

  function change(it: WorkItem, patch: Partial<WorkItem>): WorkItem {
    Object.assign(it, patch, { updatedAt: Date.now() });
    emit({ kind: 'item.upsert', item: { ...it } });
    return { ...it };
  }

  const NO_ASKS = { needsInput: null, oldestUserAsk: null, openAsks: 0, userAsks: 0 } as const;

  /** A one-step workflow summary, the way the daemon shows a round's implement step. */
  function implementFlow(it: WorkItem, state: StepSummary['state'], round = 1): WorkflowSummary {
    return {
      round,
      roundsAllowed: 0,
      gate: 'pending',
      headSha: null,
      steps: [{ id: `stp_fx_${it.number}_${round}`, kind: 'implement', state, result: null, agent: it.agent, detail: '' }],
      obligations: 0,
      openFindings: 0,
      policy: { merge: 'manual', require: null, panel: [] },
    };
  }

  function move(it: WorkItem, trigger: TicketTrigger, patch: Partial<WorkItem> = {}): WorkItem {
    const to = nextTicket({ status: it.status, outcome: it.outcome }, trigger, !!it.sessionId);
    if (to === 'removed') throw new Error(`Cannot ${trigger} this ticket here.`);
    const done = to.status === 'done';
    return change(it, {
      ...patch,
      status: to.status,
      outcome: to.outcome,
      stage: to.status === 'in-progress' ? 'implement' : null,
      closedAt: done ? Date.now() : null,
      ...(done ? { workflow: null, ...NO_ASKS } : {}),
    });
  }

  function place(itemId: string, position: ItemPosition): void {
    const order = snap.order.filter((id) => id !== itemId);
    let idx = order.length;
    if (position === 'top') idx = 0;
    else if (typeof position === 'object') {
      const anchor = order.indexOf('before' in position ? position.before : position.after);
      idx = anchor < 0 ? order.length : 'before' in position ? anchor : anchor + 1;
    }
    order.splice(idx, 0, itemId);
    snap.order = order;
    emit({ kind: 'backlog.order', order: [...order] });
  }

  function create(title: string, extra: Partial<WorkItem>, position: ItemPosition = 'top'): WorkItem {
    const now = Date.now();
    const number = nextNumber++;
    const it: WorkItem = {
      id: `itm_new${number}`,
      number,
      title,
      body: '',
      status: 'todo',
      stage: null,
      outcome: null,
      agent: null,
      repo: null,
      createdBy: 'user',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      attempts: 0,
      sessionId: null,
      branch: null,
      worktree: null,
      base: null,
      result: null,
      references: [],
      lastError: null,
      cancelReason: null,
      acceptNote: null,
      ...NO_ASKS,
      delivery: null,
      workflow: null,
      ...extra,
    };
    if (it.agent) it.workflow = implementFlow(it, 'queued');
    snap.items.push(it);
    emit({ kind: 'item.upsert', item: { ...it } });
    place(it.id, position);
    return { ...it };
  }

  function orchestratorReply(text: string): void {
    const turnId = `trn_live${seq}`;
    const now = Date.now();
    emit({ kind: 'turn.user', sessionId: ORCH, entry: { kind: 'user', author: 'user', text, ts: now } }, { kind: 'turn.start', sessionId: ORCH, turnId });
    setTimeout(() => {
      emit(
        { kind: 'turn.event', sessionId: ORCH, turnId, event: { kind: 'text-delta', text: `(fixture) Noted: “${text.slice(0, 80)}”. W-2 and W-3 are unchanged.`, ts: Date.now() } },
        { kind: 'turn.event', sessionId: ORCH, turnId, event: { kind: 'turn-end', stats: { inputTokens: 1200, outputTokens: 40, durationMs: 900, costUsd: 0.0042 }, ts: Date.now() } },
        { kind: 'turn.end', sessionId: ORCH, turnId, stats: { inputTokens: 1200, outputTokens: 40, durationMs: 900, costUsd: 0.0042 } },
      );
    }, 700);
  }

  async function daemon<K extends RendererOp>(envId: string, op: K, args: OpArgs<K>): Promise<ClientResult<K>> {
    if (envId !== ENV_ID) throw new Error('The fixture has one environment.');
    if (scenario === 'unreachable') throw new Error("Can't reach build-box.");
    const a = args as Record<string, unknown>;
    const out = (value: unknown): ClientResult<K> => value as ClientResult<K>;
    switch (op) {
      case 'snapshot.get':
        return out(structuredClone(snap));
      case 'session.history': {
        const log = world.transcripts.get(String(a.sessionId)) ?? [];
        const before = typeof a.before === 'number' ? a.before : log.length;
        const start = Math.max(0, before - PAGE);
        return out({ entries: structuredClone(log.slice(start, before)), total: log.length, hasMore: start > 0, head: seq });
      }
      case 'chat.send':
        if (a.sessionId === ORCH) orchestratorReply(String(a.text));
        else emit({ kind: 'turn.user', sessionId: String(a.sessionId), entry: { kind: 'user', author: 'user', text: String(a.text), ts: Date.now() } });
        return out({ queued: false });
      case 'session.interrupt':
        return out({});
      case 'ask.answer': {
        const ask = snap.asks.find((x) => x.askId === a.askId);
        snap.asks = snap.asks.filter((x) => x.askId !== a.askId);
        emit({ kind: 'ask.closed', sessionId: String(a.sessionId), askId: String(a.askId), answers: (a.answers as Record<string, string> | null) ?? null, by: 'user' });
        const it = snap.items.find((i) => i.oldestUserAsk?.askId === a.askId || i.needsInput?.askId === a.askId);
        if (it) {
          const left = it.openAsks - 1;
          change(it, left > 0 && it.needsInput?.askId !== a.askId ? { oldestUserAsk: null, openAsks: left, userAsks: 0 } : { ...NO_ASKS, workflow: implementFlow(it, 'running', it.workflow?.round ?? 1) });
        }
        if (ask?.sessionId === ORCH) {
          emit({ kind: 'turn.event', sessionId: ORCH, turnId: ask.turnId, event: { kind: 'text-delta', text: '\n\nThanks — I will hold W-7 until W-2 merges.', ts: Date.now() } });
        }
        return out({});
      }
      case 'item.create':
        return out(create(String(a.title), { agent: (a.agent as string) ?? null, repo: (a.repo as string) ?? null, body: (a.body as string) ?? '' }, a.position as ItemPosition));
      case 'item.update': {
        const it = find(String(a.itemId));
        const patch: Partial<WorkItem> = {};
        if (typeof a.title === 'string') patch.title = a.title;
        if (typeof a.body === 'string') patch.body = a.body;
        if (typeof a.repo === 'string') patch.repo = a.repo;
        return out(change(it, patch));
      }
      case 'item.move':
        find(String(a.itemId));
        place(String(a.itemId), a.position as ItemPosition);
        return out({ order: [...snap.order] });
      case 'item.assign': {
        const it = find(String(a.itemId));
        if (it.status !== 'todo') throw new Error(`W-${it.number} is not in Todo; only a ticket in Todo is assigned.`);
        const agent = a.agent ? String(a.agent) : null;
        return out(change(it, { agent, workflow: agent ? implementFlow({ ...it, agent }, 'queued') : null }));
      }
      case 'item.cancel':
        return out(move(find(String(a.itemId)), 'cancel', { cancelReason: 'Cancelled by you.' }));
      case 'item.accept':
        return out(move(find(String(a.itemId)), 'accept', { acceptNote: 'Accepted by you.' }));
      case 'item.retry': {
        const it = find(String(a.itemId));
        const moved = move(it, 'retry', { attempts: 0, lastError: null });
        return out(change(it, { workflow: moved.agent ? implementFlow(moved, 'queued', (it.workflow?.round ?? 1) + 1) : null }));
      }
      case 'item.publish': {
        const it = find(String(a.itemId));
        const repo = it.repo === 'api' ? 'acme/api' : 'acme/web';
        const pr = {
          id: `ref_fx_${it.number}_d`,
          role: 'delivery' as const,
          kind: 'github-pr' as const,
          repo,
          number: 50 + it.number,
          url: `https://github.com/${repo}/pull/${50 + it.number}`,
          draft: false,
          lastPushedSha: 'feedf00',
          state: 'open' as const,
          checks: null,
        };
        change(it, { references: [...it.references.filter((r) => r.id !== deliveryPull(it)?.id), pr] });
        return out({ prUrl: pr.url });
      }
      case 'item.workflow': {
        const it = find(String(a.itemId));
        const wf = it.workflow;
        if (!wf) return out({ roundsTotal: 0, round: null, steps: [], stepsCursor: null, reviews: [], decisions: [], findingsTotal: 0 });
        const round = { round: wf.round, roundId: `rnd_fx_${it.number}_${wf.round}`, purpose: 'task' as const, headSha: it.result?.commits[0]?.sha ?? null, gate: wf.gate, settledGate: null, outcome: 'open' as const, startedAt: it.createdAt, settledAt: null };
        const steps = wf.steps.map((s) => ({
          ...s,
          round: wf.round,
          sessionId: s.kind === 'implement' ? it.sessionId : null,
          reviewId: null,
          task: null,
          purpose: s.kind === 'implement' ? ('task' as const) : null,
          group: s.kind === 'merge' ? 7 : 1,
          after: null,
          logicalId: s.id,
          attempt: 1,
          retryOf: null,
          work: s.kind === 'implement' && it.result ? { head: it.result.commits[0]?.sha ?? '', commits: it.result.commits.length, summary: it.result.summary } : null,
          queuedAt: it.createdAt,
          startedAt: it.sessionId ? it.createdAt : null,
          finishedAt: s.state === 'done' ? it.updatedAt : null,
        }));
        return out({ roundsTotal: wf.round, round, steps, stepsCursor: null, reviews: [], decisions: [], findingsTotal: 0 });
      }
      case 'item.link': {
        const it = find(String(a.itemId));
        const ref = String(a.ref);
        if (!/^https:\/\//.test(ref) && !/#\d+$/.test(ref)) throw new Error(`Puck cannot read "${ref}" as a GitHub issue, pull request or https URL.`);
        const link = { id: `ref_fx_${Date.now()}`, role: 'related' as const, kind: 'url' as const, url: ref, label: null };
        return out(change(it, { references: [...it.references, link] }));
      }
      case 'item.unlink': {
        const it = find(String(a.itemId));
        return out(change(it, { references: it.references.filter((r) => r.id !== a.referenceId) }));
      }
      case 'item.delete': {
        const it = find(String(a.itemId));
        nextTicket({ status: it.status, outcome: it.outcome }, 'delete');
        snap.items = snap.items.filter((i) => i.id !== it.id);
        snap.order = snap.order.filter((id) => id !== it.id);
        emit({ kind: 'item.removed', itemId: it.id });
        return out({});
      }
      case 'item.pr': {
        const pull = world.pulls.get(String(a.itemId));
        if (!pull) throw new Error('No pull request yet.');
        return out(structuredClone(pull));
      }
      case 'issue.search':
        return out({
          issues: [
            { repo: 'acme/web', number: 131, title: 'Onboarding checklist copy', state: 'open', labels: ['launch'], url: 'https://github.com/acme/web/issues/131', item: 'W-9 (in Todo)' },
            { repo: 'acme/web', number: 140, title: 'Keyboard shortcut for search', state: 'open', labels: [], url: 'https://github.com/acme/web/issues/140', item: null },
            { repo: 'acme/api', number: 77, title: 'Verify webhook signatures', state: 'open', labels: ['security'], url: 'https://github.com/acme/api/issues/77', item: null },
          ].filter((hit) => `${hit.repo}#${hit.number} ${hit.title}`.toLowerCase().includes(String(a.query).toLowerCase()) || String(a.query).length < 3),
        });
      case 'issue.import': {
        const repo = String(a.repo);
        const number = Number(a.number);
        const source = { id: `ref_fx_${number}_s`, role: 'source' as const, kind: 'github-issue' as const, repo, number, url: `https://github.com/${repo}/issues/${number}`, updatedAt: Date.now() };
        return out(create(`Issue ${repo}#${number}`, { repo: repo.split('/')[1] ?? null, references: [source] }, a.position as ItemPosition));
      }
      case 'scheduler.pause':
      case 'scheduler.resume':
        snap.capacity = { ...snap.capacity, paused: op === 'scheduler.pause' };
        emit({ kind: 'capacity', ...snap.capacity });
        return out({});
      case 'logs.tail':
        return out({ text: '(fixture) no daemon log' });
    }
    throw new Error(`${op} is not available in the fixture harness.`);
  }

  const bridge: Partial<PuckBridge> = {
    providers: async () => providers(),
    openExternal: async (url) => {
      console.info(`[fixture] open ${url}`);
    },
    runners: async () => runners(),
    onRunnerEvent: (cb: (e: RunnerEvent) => void) => {
      void cb;
    },
    instanceList: async () => structuredClone(world.instances),
    instanceOpen: async () => undefined,
    instanceCheckUpdate: async () => null,
    onInstanceEvent: (cb) => {
      instanceListeners.push(cb);
    },
    daemon: daemon as PuckBridge['daemon'],
    onDaemonEvent: (cb) => {
      daemonListeners.push(cb);
    },
    onFlush: () => undefined,
  };
  return new Proxy(bridge as PuckBridge, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof PuckBridge];
      return async () => {
        throw new Error(`${prop} is not available in the fixture harness.`);
      };
    },
  });
}
