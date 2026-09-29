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
 * Item commands move the seeded items through the shared state machine
 * (`src/harness/item-transitions.ts`) and stream the same events back
 * (`item.upsert`, `item.removed`, `backlog.order`), so the board, menus
 * and drag and drop can be exercised. `chat.send` echoes a short
 * orchestrator turn. Anything a fixture cannot do rejects with a sentence
 * saying so.
 */

import type { DaemonEventPayload, InstanceEvent, ProviderInfo, PuckBridge, RunnerEvent, RunnersState } from '../../harness/bridge';
import type { DaemonEvent, ItemPosition, OpArgs, OpResult, RendererOp, WorkItem } from '../../harness/daemon-protocol';
import { nextStatus, type ItemTrigger } from '../../harness/item-transitions';
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

  function move(it: WorkItem, trigger: ItemTrigger, patch: Partial<WorkItem> = {}): WorkItem {
    const to = nextStatus(it.status, trigger);
    if (to === 'removed') throw new Error(`Cannot ${trigger} an item that is ${it.status}.`);
    return change(it, { ...patch, status: to });
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
      status: extra.agent ? 'queued' : 'backlog',
      agent: null,
      repo: null,
      createdBy: 'user',
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      sessionId: null,
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
      ...extra,
    };
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

  async function daemon<K extends RendererOp>(envId: string, op: K, args: OpArgs<K>): Promise<OpResult<K>> {
    if (envId !== ENV_ID) throw new Error('The fixture has one environment.');
    if (scenario === 'unreachable') throw new Error("Can't reach build-box.");
    const a = args as Record<string, unknown>;
    const out = (value: unknown): OpResult<K> => value as OpResult<K>;
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
        const it = snap.items.find((i) => i.pendingAsk?.askId === a.askId);
        if (it) change(it, { status: 'running', pendingAsk: null });
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
        return out(a.agent ? move(it, 'assign', { agent: String(a.agent) }) : move(it, 'unassign', { agent: null }));
      }
      case 'item.cancel':
        return out(move(find(String(a.itemId)), 'cancel', { pendingAsk: null, cancelReason: 'Cancelled by you.' }));
      case 'item.accept':
        return out(move(find(String(a.itemId)), 'accept', { pendingAsk: null, acceptNote: 'Accepted by you.' }));
      case 'item.retry':
        return out(move(find(String(a.itemId)), 'retry', { attempts: 0, lastError: null }));
      case 'item.publish': {
        const it = find(String(a.itemId));
        const repo = it.repo === 'api' ? 'acme/api' : 'acme/web';
        const pr = { number: 50 + it.number, url: `https://github.com/${repo}/pull/${50 + it.number}`, draft: false, lastPushedSha: 'feedf00', state: 'open' as const, checks: null };
        change(it, { pr });
        return out({ prUrl: pr.url });
      }
      case 'item.delete': {
        const it = find(String(a.itemId));
        nextStatus(it.status, 'delete');
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
            { repo: 'acme/web', number: 131, title: 'Onboarding checklist copy', state: 'open', labels: ['launch'], url: 'https://github.com/acme/web/issues/131', item: 'W-9 (backlog)' },
            { repo: 'acme/web', number: 140, title: 'Keyboard shortcut for search', state: 'open', labels: [], url: 'https://github.com/acme/web/issues/140', item: null },
            { repo: 'acme/api', number: 77, title: 'Verify webhook signatures', state: 'open', labels: ['security'], url: 'https://github.com/acme/api/issues/77', item: null },
          ].filter((hit) => `${hit.repo}#${hit.number} ${hit.title}`.toLowerCase().includes(String(a.query).toLowerCase()) || String(a.query).length < 3),
        });
      case 'issue.import': {
        const repo = String(a.repo);
        const number = Number(a.number);
        return out(create(`Issue ${repo}#${number}`, { repo: repo.split('/')[1] ?? null, source: { kind: 'github-issue', repo, number, url: `https://github.com/${repo}/issues/${number}`, updatedAt: Date.now() } }, a.position as ItemPosition));
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
