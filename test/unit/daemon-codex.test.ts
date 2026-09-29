import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../../src/harness/types';
import { runCodex, type CodexChildren, type CodexSdk } from '../../src/daemon/harness/codex';
import type { AdapterRequest } from '../../src/daemon/harness/types';
import collabTurn from '../fixtures/codex-collab-events.json';
import recorded from '../fixtures/codex-events.expected.json';

// The daemon's Codex adapter is a port of the container runner's runCodex.
// These are the runner's collab sub-agent tests, run against the port, plus
// a check against what the container runner emitted for the same exec
// streams (recorded in codex-events.expected.json before it was removed).

type Collab = {
  id: string;
  type: 'collab_tool_call';
  tool: string;
  sender_thread_id: string;
  receiver_thread_ids: string[];
  prompt: string | null;
  agents_states: Record<string, { status: string; message: string | null }>;
  status: 'in_progress' | 'completed' | 'failed';
  model?: string;
};

function collab(over: Partial<Collab> & { id: string; tool: string }): Collab {
  return {
    type: 'collab_tool_call',
    sender_thread_id: 'thread-parent',
    receiver_thread_ids: [],
    prompt: null,
    agents_states: {},
    status: 'in_progress',
    ...over,
  };
}
const started = (item: Collab) => ({ type: 'item.started', item });
const completed = (item: Collab) => ({ type: 'item.completed', item });

/** A Codex SDK stand-in whose one thread streams the given exec events. */
function scriptedSdk(events: unknown[]) {
  const constructed: unknown[] = [];
  const threads: Array<{ resume: string | null; opts: unknown }> = [];
  const thread = {
    id: 'thread-parent',
    runStreamed: async () => ({
      events: (async function* () {
        for (const ev of events) yield ev;
      })(),
    }),
  };
  const sdk = {
    Codex: class {
      constructor(opts: unknown) {
        constructed.push(opts);
      }
      startThread(opts: unknown) {
        threads.push({ resume: null, opts });
        return thread;
      }
      resumeThread(id: string, opts: unknown) {
        threads.push({ resume: id, opts });
        return thread;
      }
    },
  };
  return { sdk, constructed, threads };
}

const req = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
  sessionId: 'ses_1',
  turnId: 'trn_1',
  prompt: 'hi',
  resumeId: null,
  cwd: '/workspace',
  agent: {
    name: 'impl',
    description: '',
    harness: 'codex',
    model: 'auto',
    effort: 'auto',
    instructions: '',
    options: {},
    advanced: {},
  },
  settings: {},
  tools: null,
  env: { HOME: '/puck/home' },
  ...over,
});

async function drive(events: unknown[], children: CodexChildren = new Map(), over: Partial<AdapterRequest> = {}) {
  const out: HarnessEvent[] = [];
  const sessions: string[] = [];
  const s = scriptedSdk(events);
  await runCodex(
    req(over),
    s.sdk as unknown as CodexSdk,
    {
      emit: (event) => out.push(event),
      reportSession: (id) => sessions.push(id),
      onInterrupt: () => undefined,
      askUser: async () => null,
      signal: new AbortController().signal,
    },
    { codexPath: '/opt/puck/bin/codex-as-puck', children },
  );
  return Object.assign(out, { sessions, ...s });
}

const of = <K extends HarnessEvent['kind']>(events: HarnessEvent[], kind: K) =>
  events.filter((e): e is Extract<HarnessEvent, { kind: K }> => e.kind === kind);
const noDuration = (events: HarnessEvent[]) =>
  events.map((e) => (e.kind === 'turn-end' ? { ...e, stats: { ...e.stats, durationMs: 0 } } : e));

describe('daemon Codex adapter', () => {
  it('emits exactly what the container runner emitted for the same exec stream', async () => {
    const tools = [
      { type: 'thread.started', thread_id: 'thread-parent' },
      { type: 'item.started', item: { id: 'r1', type: 'reasoning' } },
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } },
      { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', exit_code: 1, aggregated_output: 'nope', status: 'failed' } },
      { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ kind: 'add', path: 'a.ts' }] } },
      { type: 'item.completed', item: { id: 'x1', type: 'brand_new_item', foo: 1 } },
      { type: 'item.completed', item: { id: 'e1', type: 'error', message: 'rate limited' } },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 3, reasoning_output_tokens: 2 } },
    ];
    expect(noDuration(await drive(collabTurn as unknown[]))).toEqual(recorded.collab);
    expect(noDuration(await drive(tools))).toEqual(recorded.tools);
  });

  it('runs the CLI through the puck wrapper with the allowlisted env, the session cwd and resume id', async () => {
    const out = await drive([{ type: 'thread.started', thread_id: 'thread-parent' }], new Map(), {
      resumeId: 'thread-old',
      cwd: '/workspace/.puck/worktrees/W-2',
      agent: { ...req().agent, model: 'gpt-5', effort: 'high', instructions: 'Terse.', advanced: { model_verbosity: 'low' } },
      settings: { web_search: 'live' },
    });
    expect(out.constructed).toEqual([
      {
        codexPathOverride: '/opt/puck/bin/codex-as-puck',
        env: { HOME: '/puck/home' },
        config: {
          sandbox_mode: 'danger-full-access',
          approval_policy: 'never',
          model: 'gpt-5',
          model_reasoning_effort: 'high',
          developer_instructions: 'Terse.',
          web_search: 'live',
          model_verbosity: 'low',
        },
      },
    ]);
    expect(out.threads).toEqual([
      { resume: 'thread-old', opts: { workingDirectory: '/workspace/.puck/worktrees/W-2', skipGitRepoCheck: true } },
    ]);
    expect(out.sessions).toEqual(['thread-parent']);
  });

  it('keeps the puck wrapper, allowlisted env, and session cwd when advanced overrides them', async () => {
    const out = await drive([{ type: 'thread.started', thread_id: 'thread-parent' }], new Map(), {
      resumeId: 'thread-old',
      cwd: '/workspace/.puck/worktrees/W-2',
      env: { HOME: '/puck/home', PATH: '/usr/bin' },
      agent: {
        ...req().agent,
        advanced: {
          model_verbosity: 'low',
          codexPathOverride: false,
          env: { HOME: '/root', PATH: '/evil' },
          workingDirectory: '/root',
          cwd: '/root',
        },
      },
    });
    expect(out.constructed).toEqual([
      {
        codexPathOverride: '/opt/puck/bin/codex-as-puck',
        env: { HOME: '/puck/home', PATH: '/usr/bin' },
        config: {
          sandbox_mode: 'danger-full-access',
          approval_policy: 'never',
          model_verbosity: 'low',
        },
      },
    ]);
    expect(out.threads).toEqual([
      { resume: 'thread-old', opts: { workingDirectory: '/workspace/.puck/worktrees/W-2', skipGitRepoCheck: true } },
    ]);
  });
});

describe('daemon Codex sub-agents from collab_tool_call items', () => {
  it('renders the captured spawn/send/wait/close turn as one nested Agent card', async () => {
    const events = await drive(collabTurn);

    // spawn_agent → the same card event the Claude sub-agent path emits.
    const starts = of(events, 'tool-start');
    expect(starts).toEqual([
      {
        kind: 'tool-start',
        toolId: 'item_0',
        tool: 'Agent',
        summary: 'draft a plan',
        input: 'draft a plan',
        agent: true,
      },
    ]); // no raw cards for send_input / wait / close_agent

    // Lifecycle text lands inside the child card (parentId = the spawn item).
    const child = of(events, 'text-delta').filter((e) => e.parentId === 'item_0').map((e) => e.text);
    expect(child[0]).toContain('thread-child');
    expect(child[0]).toContain('running');
    expect(child[1]).toContain('Follow-up input from the parent agent');
    expect(child[1]).toContain('> keep it under one page');
    expect(child[2]).toBe('Status: running.\n\n'); // the first wait timed out
    expect(child[3]).toBe('Finished: completed - Plan drafted in PLAN.md.\n\n');
    expect(child).toHaveLength(4); // close_agent after completion adds nothing

    // Exactly one tool-end, at the terminal wait — not at the later close.
    const ends = of(events, 'tool-end');
    expect(ends).toEqual([
      { kind: 'tool-end', toolId: 'item_0', ok: true, output: 'completed - Plan drafted in PLAN.md' },
    ]);
    const order = events.map((e) => e.kind);
    expect(order.indexOf('tool-end')).toBeGreaterThan(order.indexOf('tool-start'));

    // The parent's own reply and the turn end still flow as before.
    const parentText = of(events, 'text-delta').filter((e) => !e.parentId);
    expect(parentText.map((e) => e.text)).toEqual(['The plan is in PLAN.md.']);
    expect(of(events, 'turn-end')[0]?.stats).toMatchObject({ inputTokens: 1500, outputTokens: 80 });
  });

  it('adds the model to the summary when the item carries one', async () => {
    const events = await drive([
      started(collab({ id: 'item_m', tool: 'spawn_agent', prompt: 'review the diff\nline two', model: 'gpt-5' })),
    ]);
    expect(of(events, 'tool-start')[0]).toMatchObject({
      tool: 'Agent',
      summary: 'review the diff - gpt-5',
      input: 'review the diff\nline two',
      agent: true,
    });
  });

  it('settles a failed spawn as a failed card', async () => {
    const events = await drive([
      started(collab({ id: 'item_f', tool: 'spawn_agent', prompt: 'do it' })),
      completed(collab({ id: 'item_f', tool: 'spawn_agent', prompt: 'do it', status: 'failed' })),
    ]);
    expect(of(events, 'tool-end')).toEqual([
      { kind: 'tool-end', toolId: 'item_f', ok: false, output: 'Codex could not start this sub-agent.' },
    ]);
  });

  it('marks a child that errored as failed, with its message', async () => {
    const spawnDone = collab({
      id: 'item_e',
      tool: 'spawn_agent',
      prompt: 'try',
      receiver_thread_ids: ['thread-err'],
      agents_states: { 'thread-err': { status: 'running', message: null } },
      status: 'completed',
    });
    const events = await drive([
      started(collab({ id: 'item_e', tool: 'spawn_agent', prompt: 'try' })),
      completed(spawnDone),
      completed(
        collab({
          id: 'item_w',
          tool: 'wait',
          receiver_thread_ids: ['thread-err'],
          agents_states: { 'thread-err': { status: 'errored', message: 'tool budget exceeded' } },
          status: 'completed',
        }),
      ),
    ]);
    expect(of(events, 'tool-end')).toEqual([
      { kind: 'tool-end', toolId: 'item_e', ok: false, output: 'errored - tool budget exceeded' },
    ]);
  });

  it('opens the card even when only the completed spawn item arrives', async () => {
    const events = await drive([
      completed(
        collab({
          id: 'item_c',
          tool: 'spawn_agent',
          prompt: 'late start',
          receiver_thread_ids: ['thread-late'],
          agents_states: { 'thread-late': { status: 'running', message: null } },
          status: 'completed',
        }),
      ),
    ]);
    expect(of(events, 'tool-start')).toHaveLength(1);
    expect(of(events, 'text-delta')[0]).toMatchObject({ parentId: 'item_c' });
  });

  it('falls back to the raw card for unknown collab tools and unknown children', async () => {
    const events = await drive([
      started(collab({ id: 'item_u', tool: 'list_agents' })),
      completed(collab({ id: 'item_u', tool: 'list_agents', status: 'completed' })),
      started(collab({ id: 'item_s', tool: 'wait', receiver_thread_ids: ['thread-stranger'] })),
      completed(
        collab({
          id: 'item_s',
          tool: 'wait',
          receiver_thread_ids: ['thread-stranger'],
          agents_states: { 'thread-stranger': { status: 'completed', message: null } },
          status: 'completed',
        }),
      ),
    ]);
    const starts = of(events, 'tool-start');
    expect(starts.map((e) => [e.toolId, e.tool, e.agent])).toEqual([
      ['item_u', 'collab_tool_call', undefined],
      ['item_s', 'collab_tool_call', undefined],
    ]);
    expect(of(events, 'tool-end').map((e) => e.toolId)).toEqual(['item_u', 'item_s']);
    expect(of(events, 'text-delta')).toHaveLength(0); // nothing routed into a card that does not exist
  });
});
