/**
 * Claude Code adapter: drives the Claude Agent SDK for one turn and
 * translates its messages into HarnessEvents.
 *
 * Kept behavior (ported from the container runner): streamed text deltas,
 * tool cards with one-line summaries, Task/Agent calls as sub-agent cards
 * with nested tool calls mirrored into them, the AskUserQuestion bridge
 * (the raw tool cards are hidden and the question goes through askUser),
 * and `<usage>` / `agentId:` plumbing stripped from sub-agent results.
 *
 * New in the daemon: the CLI runs as the puck user through
 * `spawnClaudeCodeProcess`, its environment is an allowlist, `cwd` comes
 * from the session, and the orchestrator session gets the in-process
 * `puck` MCP server.
 */

import type {
  CanUseTool,
  Options,
  SDKMessage,
  SpawnOptions,
  SpawnedProcess,
  McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';
import type { HarnessEvent } from '../../harness/types';
import { type AdapterContext, type AdapterRequest, type HarnessAdapter, applyOverrides, turnHelpers } from './types';

/** The slice of the Claude Agent SDK the adapter uses (tests pass a scripted fake). */
export interface ClaudeSdk {
  query(params: { prompt: string; options: Options }): AsyncIterable<SDKMessage> & { interrupt(): Promise<void> | void };
  createSdkMcpServer?(options: {
    name: string;
    version?: string;
    tools?: unknown[];
    alwaysLoad?: boolean;
  }): McpSdkServerConfigWithInstance;
}

export interface ClaudeAdapterDeps {
  loadSdk(): Promise<ClaudeSdk>;
  spawner: (options: SpawnOptions) => SpawnedProcess;
  /** The orchestrator's in-process tools (SDK tool definitions); empty = no server. */
  orchestratorTools(): unknown[];
  daemonVersion: string;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function ccToolSummary(name: string, input: Json): string {
  switch (name) {
    case 'Bash':
      return str(input.command);
    case 'Read':
    case 'Edit':
    case 'Write':
      return str(input.file_path);
    case 'Glob':
    case 'Grep':
      return str(input.pattern);
    case 'WebFetch':
      return str(input.url);
    case 'WebSearch':
      return str(input.query);
    case 'Task':
      return str(input.description);
    default:
      return JSON.stringify(input).slice(0, 80);
  }
}

export function ccResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: unknown) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('\n');
  }
  return '';
}

/** Sub-agent results carry SDK plumbing the UI must never show. */
function stripAgentPlumbing(output: string): string {
  return output
    .replace(/<usage>[\s\S]*?<\/usage>/g, '')
    .split('\n')
    .filter((line) => !/^agentId:/.test(line.trim()))
    .join('\n')
    .trim();
}

interface Block {
  type?: string;
  id?: unknown;
  name?: unknown;
  input?: Json;
  text?: string;
  tool_use_id?: unknown;
  is_error?: boolean;
  content?: unknown;
}

/** SDK messages are read loosely: fields beyond the typed union are common. */
type LooseMessage = {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: unknown;
  message?: { content?: Block[] };
  event?: {
    type?: string;
    content_block?: { type?: string };
    delta?: { type?: string; text?: string };
  };
  result?: unknown;
  usage?: Record<string, number | undefined>;
  total_cost_usd?: number;
};

/**
 * One Claude turn. `sdk` is injected so the translation runs against a
 * scripted SDK in tests exactly as it runs against the real one.
 */
export async function runClaude(
  req: AdapterRequest,
  sdk: ClaudeSdk,
  ctx: AdapterContext,
  deps: Pick<ClaudeAdapterDeps, 'spawner' | 'orchestratorTools' | 'daemonVersion'>,
): Promise<void> {
  const started = Date.now();
  const h = turnHelpers(ctx, req.resumeId);
  // The container is the safety boundary and the CLI runs as the puck user:
  // full tool access. Interactive tools (AskUserQuestion) still route through
  // canUseTool under bypassPermissions; they are forwarded and awaited.
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName === 'AskUserQuestion') {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      const answers = await ctx.askUser(
        questions.map((q: Json) => ({
          question: String(q.question || ''),
          header: String(q.header || ''),
          multiSelect: q.multiSelect === true,
          options: (Array.isArray(q.options) ? q.options : []).map((o: Json) => ({
            label: String(o.label || ''),
            description: String(o.description || ''),
          })),
        })),
      );
      if (!answers) {
        return { behavior: 'deny', message: 'The user dismissed the question. Continue with your best judgment.' };
      }
      return { behavior: 'allow', updatedInput: { questions: input.questions, answers } };
    }
    return { behavior: 'allow', updatedInput: input };
  };
  const options: Options = {
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    canUseTool,
  };
  if (req.agent.model && req.agent.model !== 'auto') options.model = req.agent.model;
  if (req.resumeId) options.resume = req.resumeId;
  if (req.agent.instructions) {
    options.systemPrompt = { type: 'preset', preset: 'claude_code', append: req.agent.instructions };
  }
  if (req.agent.effort && req.agent.effort !== 'auto') {
    options.effort = req.agent.effort as Options['effort'];
  }
  if (req.tools === 'orchestrator' && sdk.createSdkMcpServer) {
    const tools = deps.orchestratorTools();
    if (tools.length) {
      options.mcpServers = {
        puck: sdk.createSdkMcpServer({ name: 'puck', version: deps.daemonVersion, tools, alwaysLoad: true }),
      };
    }
  }
  applyOverrides(options as Record<string, unknown>, req);
  options.cwd = req.cwd;
  options.env = req.env;
  options.spawnClaudeCodeProcess = deps.spawner;

  let sawText = false;
  // AskUserQuestion renders as a question card via the 'ask' event; its raw
  // tool_use/tool_result cards are suppressed.
  const hiddenToolIds = new Set<string>();
  // Task/Agent calls render as sub-agent cards.
  const agentToolIds = new Set<string>();

  const q = sdk.query({ prompt: req.prompt, options });
  ctx.onInterrupt(() => {
    try {
      void Promise.resolve(q.interrupt()).catch(() => undefined);
    } catch {
      // best effort
    }
  });
  for await (const raw of q) {
    const msg = raw as LooseMessage;
    if (msg.parent_tool_use_id) {
      // Sub-agent activity: mirror nested tool calls into the parent's card.
      const parentId = String(msg.parent_tool_use_id);
      if (msg.type === 'assistant' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            ctx.emit({ kind: 'text-delta', text: block.text + '\n\n', parentId });
            continue;
          }
          if (block.type !== 'tool_use') continue;
          ctx.emit({
            kind: 'tool-start',
            toolId: String(block.id),
            tool: String(block.name),
            summary: ccToolSummary(String(block.name), block.input || {}),
            input: JSON.stringify(block.input || {}, null, 2).slice(0, 2000),
            parentId,
          });
        }
      } else if (msg.type === 'user' && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue;
          ctx.emit({
            kind: 'tool-end',
            toolId: String(block.tool_use_id),
            ok: block.is_error !== true,
            output: ccResultText(block.content).slice(0, 4000) || '(no output)',
          });
        }
      }
      continue;
    }
    if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
      h.session(msg.session_id);
    } else if (msg.type === 'stream_event' && msg.event) {
      const ev = msg.event;
      const startedThinking =
        (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking') ||
        (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta');
      if (startedThinking) h.thinkingOn();
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        h.thinkingOff();
        sawText = true;
        ctx.emit({ kind: 'text-delta', text: ev.delta.text });
      }
    } else if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type !== 'tool_use') continue;
        h.thinkingOff();
        if (block.name === 'AskUserQuestion') {
          hiddenToolIds.add(String(block.id));
          continue;
        }
        const input = block.input || {};
        if (block.name === 'Task' || block.name === 'Agent') {
          agentToolIds.add(String(block.id));
          const kind = typeof input.subagent_type === 'string' ? input.subagent_type : '';
          ctx.emit({
            kind: 'tool-start',
            toolId: String(block.id),
            tool: 'Agent',
            summary: (typeof input.description === 'string' ? input.description : 'sub-agent') + (kind ? ' - ' + kind : ''),
            input: (typeof input.prompt === 'string' ? input.prompt : '').slice(0, 4000),
            agent: true,
          });
          continue;
        }
        ctx.emit({
          kind: 'tool-start',
          toolId: String(block.id),
          tool: String(block.name),
          summary: ccToolSummary(String(block.name), input),
          input: JSON.stringify(input, null, 2).slice(0, 2000),
        });
      }
    } else if (msg.type === 'user' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type !== 'tool_result') continue;
        if (hiddenToolIds.has(String(block.tool_use_id))) continue;
        let output = ccResultText(block.content);
        if (agentToolIds.has(String(block.tool_use_id))) output = stripAgentPlumbing(output);
        ctx.emit({
          kind: 'tool-end',
          toolId: String(block.tool_use_id),
          ok: block.is_error !== true,
          output: output.slice(0, 4000) || '(no output)',
        });
      }
    } else if (msg.type === 'result') {
      h.thinkingOff();
      if (msg.session_id && msg.session_id !== h.sessionId()) h.session(msg.session_id);
      if (msg.subtype && msg.subtype !== 'success') {
        const event: HarnessEvent = {
          kind: 'error',
          message:
            'Claude Code turn ended early: ' + msg.subtype + (msg.result ? ' - ' + String(msg.result).slice(0, 500) : ''),
        };
        ctx.emit(event);
      } else if (!sawText && msg.result) {
        ctx.emit({ kind: 'text-delta', text: String(msg.result) });
      }
      const usage = msg.usage || {};
      h.endTurn({
        inputTokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        outputTokens: usage.output_tokens || 0,
        durationMs: Date.now() - started,
        costUsd: msg.total_cost_usd,
      });
    }
  }
}

export function createClaudeAdapter(deps: ClaudeAdapterDeps): HarnessAdapter {
  let sdk: Promise<ClaudeSdk> | null = null;
  return {
    id: 'claude-code',
    async run(req, ctx) {
      sdk ??= deps.loadSdk();
      const loaded = await sdk.catch((err: unknown) => {
        sdk = null; // a failed import is retried on the next turn
        throw err;
      });
      await runClaude(req, loaded, ctx, deps);
    },
  };
}
