/**
 * Codex adapter: drives the Codex SDK for one turn and translates its
 * thread events into HarnessEvents.
 *
 * Kept behavior (ported from the container runner): one tool card per
 * command, file change, MCP call, web search and plan; a generic card for
 * item types it does not know; collab tool calls (spawn_agent, send_input,
 * wait, close_agent) as nested sub-agent cards.
 *
 * New in the daemon: the SDK runs the CLI through a wrapper that drops to
 * the puck user, its environment is an allowlist (the SDK does not inherit
 * the daemon's), and the working directory comes from the session.
 */

import type { HarnessEvent } from '../../harness/types';
import { type AdapterContext, type AdapterRequest, type HarnessAdapter, applyOverrides, turnHelpers } from './types';

type Json = Record<string, unknown>;

/** A Codex thread item, read loosely (the SDK adds fields and item types over time). */
export interface CodexItem {
  id?: string;
  type?: string;
  command?: string;
  changes?: { kind?: string; path?: string }[];
  server?: string;
  tool?: string;
  query?: string;
  items?: { completed?: boolean; text?: string }[];
  text?: string;
  message?: string;
  status?: string;
  exit_code?: number | null;
  aggregated_output?: string;
  prompt?: string | null;
  model?: string;
  receiver_thread_ids?: unknown[];
  agents_states?: Record<string, { status?: string; message?: string | null }>;
}

export interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: Record<string, number | undefined>;
  message?: string;
}

interface CodexThread {
  id?: string | null;
  runStreamed(prompt: string, opts: { signal: AbortSignal }): Promise<{ events: AsyncIterable<CodexEvent> }>;
}

/** The slice of the Codex SDK the adapter uses (tests pass a scripted fake). */
export interface CodexSdk {
  Codex: new (opts: { config: Json; codexPathOverride?: string; env?: Record<string, string> }) => {
    startThread(opts: Json): CodexThread;
    resumeThread(id: string, opts: Json): CodexThread;
  };
}

export interface CodexAdapterDeps {
  loadSdk(): Promise<CodexSdk>;
  /** The wrapper that runs the CLI as the puck user. */
  codexPath: string;
}

interface CardSpec {
  tool: string;
  summary: string;
  input: string;
}

export function cxToolCard(item: CodexItem): CardSpec | null {
  switch (item.type) {
    case 'command_execution':
      return { tool: 'Shell', summary: item.command || '', input: item.command || '' };
    case 'file_change': {
      const files = (item.changes || []).map((c) => ((c.kind || 'edit') + ' ' + (c.path || '')).trim()).join(', ');
      return { tool: 'Edit', summary: files || 'file changes', input: files };
    }
    case 'mcp_tool_call':
      return {
        tool: 'MCP',
        summary: [item.server, item.tool].filter(Boolean).join(' - '),
        input: JSON.stringify(item).slice(0, 1000),
      };
    case 'web_search':
      return { tool: 'WebSearch', summary: item.query || '', input: item.query || '' };
    case 'todo_list': {
      const todos = (item.items || []).map((t) => (t.completed ? '[x] ' : '[ ] ') + (t.text || ''));
      return { tool: 'Plan', summary: todos.length + ' step' + (todos.length === 1 ? '' : 's'), input: todos.join('\n') };
    }
    // Non-tool items are handled by the event loop; anything new the SDK
    // adds gets a generic card, not silence.
    case 'agent_message':
    case 'reasoning':
    case 'error':
      return null;
    default:
      return {
        tool: String(item.type || 'unknown'),
        summary: JSON.stringify(item).slice(0, 80),
        input: JSON.stringify(item, null, 2).slice(0, 2000),
      };
  }
}

/**
 * Codex sub-agents. The exec interface reports the parent's collab tool
 * calls with the child thread id and its last known status, and nothing from
 * the child's own thread. Each spawn becomes a sub-agent card whose chat
 * carries that lifecycle only. Child thread ids are stable across turns, so
 * the map outlives the turn (a later wait/close still settles the original
 * card), but not the daemon process: collab items for children this daemon
 * never saw spawn fall back to the raw card.
 */
export type CodexChildren = Map<string, { toolId: string; ended: boolean }>;

const CX_COLLAB_TOOLS = new Set(['spawn_agent', 'send_input', 'wait', 'close_agent']);
/** Terminal child statuses and whether the card settles as ok; anything else leaves it running. */
const CX_AGENT_DONE: Record<string, boolean> = {
  completed: true,
  shutdown: true,
  errored: false,
  interrupted: false,
  not_found: false,
};

function cxPrompt(item: CodexItem): string {
  return typeof item.prompt === 'string' ? item.prompt : '';
}

function cxAgentSummary(item: CodexItem): string {
  const head = cxPrompt(item).split('\n')[0].trim().slice(0, 80) || 'sub-agent';
  const model = typeof item.model === 'string' ? item.model : '';
  return head + (model ? ' - ' + model : '');
}

/** One child's state as "completed" or "errored - <message>". */
function cxAgentStatus(state: { status?: string; message?: string | null } | null | undefined): string {
  const status = state && typeof state.status === 'string' ? state.status : '';
  const message = state && typeof state.message === 'string' ? state.message.trim() : '';
  return status + (message ? ' - ' + message : '');
}

/**
 * Translate one collab item event into sub-agent card events. True when
 * handled; false hands the item to the raw card path (an unknown collab
 * tool, or a send/wait/close for a child this daemon never saw spawn).
 */
export function cxCollab(
  ev: CodexEvent,
  emit: (event: HarnessEvent) => void,
  thinkingOff: () => void,
  openTools: Set<string>,
  children: CodexChildren,
): boolean {
  const item = ev.item;
  if (!item || item.type !== 'collab_tool_call' || !item.id || !CX_COLLAB_TOOLS.has(item.tool || '')) return false;
  const itemId = item.id;
  const completed = ev.type === 'item.completed';
  const receivers = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.map(String) : [];
  const states = item.agents_states && typeof item.agents_states === 'object' ? item.agents_states : {};
  const say = (toolId: string, text: string): void => emit({ kind: 'text-delta', text: text + '\n\n', parentId: toolId });

  if (item.tool === 'spawn_agent') {
    thinkingOff();
    if (!openTools.has(itemId)) {
      openTools.add(itemId);
      emit({
        kind: 'tool-start',
        toolId: itemId,
        tool: 'Agent',
        summary: cxAgentSummary(item),
        input: cxPrompt(item).slice(0, 4000),
        agent: true,
      });
    }
    if (!completed) return true;
    openTools.delete(itemId);
    const child = receivers[0];
    if (item.status === 'failed' || !child) {
      const detail = cxAgentStatus(child ? states[child] : null);
      emit({
        kind: 'tool-end',
        toolId: itemId,
        ok: false,
        output: 'Codex could not start this sub-agent' + (detail ? ': ' + detail : '.'),
      });
      return true;
    }
    children.set(child, { toolId: itemId, ended: false });
    say(itemId, 'Started as Codex thread `' + child + '` (' + (cxAgentStatus(states[child]) || 'running') + ').');
    return true;
  }

  // send_input / wait / close_agent address children by thread id. Every
  // receiver must be a known child; otherwise the whole item is a raw card,
  // and a raw card already opened at item.started must also close as one.
  if (openTools.has(itemId)) return false;
  const known = receivers.map((thread) => children.get(thread));
  if (!receivers.length || known.some((c) => !c)) return false;
  if (!completed) return true; // the outcome arrives with the completion

  thinkingOff();
  receivers.forEach((thread, i) => {
    const child = known[i];
    if (!child) return;
    if (item.tool === 'send_input') {
      say(child.toolId, 'Follow-up input from the parent agent:\n\n> ' + cxPrompt(item).replace(/\n/g, '\n> '));
      return;
    }
    const state = states[thread] || {};
    const ok = state.status !== undefined ? CX_AGENT_DONE[state.status] : undefined;
    if (ok === undefined) {
      if (state.status) say(child.toolId, 'Status: ' + cxAgentStatus(state) + '.');
      else if (item.status === 'failed') say(child.toolId, 'Codex reported that ' + item.tool + ' failed.');
      return;
    }
    if (child.ended) return; // settled by an earlier wait/close
    child.ended = true;
    say(child.toolId, 'Finished: ' + cxAgentStatus(state) + '.');
    emit({ kind: 'tool-end', toolId: child.toolId, ok, output: cxAgentStatus(state) });
  });
  return true;
}

/** One Codex turn against an injected SDK. */
export async function runCodex(
  req: AdapterRequest,
  sdk: CodexSdk,
  ctx: AdapterContext,
  opts: { codexPath?: string; children: CodexChildren },
): Promise<void> {
  const started = Date.now();
  const h = turnHelpers(ctx, req.resumeId);
  const config: Json = { sandbox_mode: 'danger-full-access', approval_policy: 'never' };
  if (req.agent.model && req.agent.model !== 'auto') config.model = req.agent.model;
  if (req.agent.effort && req.agent.effort !== 'auto') config.model_reasoning_effort = req.agent.effort;
  // System instructions ride the developer-instructions config channel, so
  // they apply on every turn (resumes included), not just the first message.
  if (req.agent.instructions) config.developer_instructions = req.agent.instructions;
  applyOverrides(config, req);
  const client = new sdk.Codex({ config, codexPathOverride: opts.codexPath, env: req.env });
  const threadOptions = { workingDirectory: req.cwd, skipGitRepoCheck: true };
  const thread = req.resumeId ? client.resumeThread(req.resumeId, threadOptions) : client.startThread(threadOptions);

  const aborter = new AbortController();
  const openTools = new Set<string>();
  ctx.onInterrupt(() => aborter.abort());
  const emit = (event: HarnessEvent): void => ctx.emit(event);

  try {
    const streamed = await thread.runStreamed(req.prompt, { signal: aborter.signal });
    for await (const ev of streamed.events) {
      if (ev.type === 'thread.started') {
        if (ev.thread_id) h.session(ev.thread_id);
      } else if (ev.type === 'item.started' && ev.item) {
        if (ev.item.type === 'reasoning') h.thinkingOn();
        if (cxCollab(ev, emit, h.thinkingOff, openTools, opts.children)) continue;
        const card = cxToolCard(ev.item);
        if (card && ev.item.id) {
          h.thinkingOff();
          openTools.add(ev.item.id);
          emit({ kind: 'tool-start', toolId: ev.item.id, tool: card.tool, summary: card.summary, input: card.input });
        }
      } else if (ev.type === 'item.completed' && ev.item) {
        if (cxCollab(ev, emit, h.thinkingOff, openTools, opts.children)) continue;
        const item = ev.item;
        if (item.type === 'agent_message' && item.text) {
          h.thinkingOff();
          emit({ kind: 'text-delta', text: item.text });
        } else if (item.type === 'error') {
          h.thinkingOff();
          emit({ kind: 'error', message: item.message || 'Codex reported an error.' });
        } else {
          const card = cxToolCard(item);
          if (card && item.id) {
            if (!openTools.has(item.id)) {
              h.thinkingOff();
              emit({ kind: 'tool-start', toolId: item.id, tool: card.tool, summary: card.summary, input: card.input });
            }
            openTools.delete(item.id);
            emit({
              kind: 'tool-end',
              toolId: item.id,
              ok: item.status !== 'failed' && (item.exit_code == null || item.exit_code === 0),
              output: (item.aggregated_output || item.text || item.status || '(done)').slice(0, 4000),
            });
          }
        }
      } else if (ev.type === 'turn.completed') {
        const usage = ev.usage || {};
        h.endTurn({
          inputTokens: (usage.input_tokens || 0) + (usage.cached_input_tokens || 0),
          outputTokens: (usage.output_tokens || 0) + (usage.reasoning_output_tokens || 0),
          durationMs: Date.now() - started,
        });
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        h.thinkingOff();
        emit({ kind: 'error', message: ev.message || 'Codex ' + ev.type });
      }
    }
  } catch (err) {
    if (!aborter.signal.aborted) throw err; // a user stop ends the turn quietly
  } finally {
    // The thread id is final once the stream ends; report it if the stream
    // never announced it (the turn loop ignores an id it only attempted).
    if (thread && thread.id && thread.id !== h.sessionId()) h.session(thread.id);
  }
}

export function createCodexAdapter(deps: CodexAdapterDeps): HarnessAdapter {
  let sdk: Promise<CodexSdk> | null = null;
  const children: CodexChildren = new Map();
  return {
    id: 'codex',
    async run(req, ctx) {
      sdk ??= deps.loadSdk();
      const loaded = await sdk.catch((err: unknown) => {
        sdk = null;
        throw err;
      });
      await runCodex(req, loaded, ctx, { codexPath: deps.codexPath, children });
    },
  };
}
