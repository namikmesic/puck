/**
 * The typed contract between the daemon's turn loop and a harness adapter.
 *
 * An adapter runs ONE turn: it drives its SDK, translates SDK messages into
 * HarnessEvents through `ctx.emit`, reports the provider's resume id as soon
 * as it is known, registers how to interrupt itself, and routes mid-turn
 * questions through `ctx.askUser`. The turn loop owns everything around it:
 * turn boundaries, the guaranteed turn-end, resume-id persistence, the
 * stale-resume retry, and recording.
 */

import type { AskQuestion, HarnessEvent, TurnStats } from '../../harness/types';
import type { SettingsMap } from '../../harness/options';
import type { DaemonAgent } from '../definition';

export interface AdapterRequest {
  sessionId: string;
  turnId: string;
  prompt: string;
  /** Provider session/thread id to resume, or null for a fresh conversation. */
  resumeId: string | null;
  cwd: string;
  /** The effective agent: its instructions already include any assignment text. */
  agent: DaemonAgent;
  /** compileSettings(agent.options) from the pure harness descriptor. */
  settings: SettingsMap;
  /** 'orchestrator' wires the orchestrator's in-process tools; workers get none. */
  tools: 'orchestrator' | null;
  /** The complete harness process environment (an allowlist). */
  env: Record<string, string>;
}

export interface AdapterContext {
  emit(event: HarnessEvent): void;
  /** Report the provider's resume id (eagerly, before the turn ends). */
  reportSession(resumeId: string): void;
  onInterrupt(fn: () => void): void;
  /** Ask the user (or the orchestrator); resolves null when dismissed or cancelled. */
  askUser(questions: AskQuestion[]): Promise<Record<string, string> | null>;
  /** Aborted when the turn is interrupted. */
  signal: AbortSignal;
}

export interface HarnessAdapter {
  /** The harness id (a pure descriptor's id). */
  readonly id: string;
  run(req: AdapterRequest, ctx: AdapterContext): Promise<void>;
}

/**
 * Shared per-turn helpers adapters use: thinking-indicator dedup, the
 * turn-end event, and resume-id tracking.
 */
export interface TurnHelpers {
  thinkingOn(): void;
  thinkingOff(): void;
  endTurn(stats: TurnStats): void;
  /** Report a resume id to the turn loop. */
  session(id: string): void;
  sessionId(): string | null;
}

export function turnHelpers(ctx: AdapterContext, resumeId: string | null): TurnHelpers {
  let thinking = false;
  let session = resumeId;
  return {
    thinkingOn() {
      if (!thinking) {
        thinking = true;
        ctx.emit({ kind: 'thinking', active: true });
      }
    },
    thinkingOff() {
      if (thinking) {
        thinking = false;
        ctx.emit({ kind: 'thinking', active: false });
      }
    },
    endTurn(stats) {
      this.thinkingOff();
      ctx.emit({ kind: 'turn-end', stats });
    },
    session(id) {
      session = id;
      ctx.reportSession(id);
    },
    sessionId: () => session,
  };
}

/**
 * Fields the daemon sets so the CLI runs as the puck user, with the
 * allowlisted environment and the session working directory. A definition's
 * settings or `advanced` passthrough must not replace them.
 */
const DAEMON_OWNED = new Set(['spawnClaudeCodeProcess', 'codexPathOverride', 'env', 'cwd', 'workingDirectory']);

function passthrough(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) if (!DAEMON_OWNED.has(key)) out[key] = value;
  return out;
}

/** Compiled settings, then the agent's `advanced` passthrough, minus daemon-owned isolation keys. */
export function applyOverrides(target: Record<string, unknown>, req: AdapterRequest): void {
  Object.assign(target, passthrough(req.settings), passthrough(req.agent.advanced));
}

/* ---------- Orchestrator tools ---------- */

/** What an in-process MCP tool returns to the model. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * One orchestrator tool. `shape` builds its zod raw shape from the zod the
 * SDK loaded (the daemon does not bundle zod); `run` executes in the
 * daemon (root), whatever user the harness CLI runs as. It returns a
 * JSON-able value or throws an Error whose message is the one-line reason
 * the model sees.
 */
export interface OrchestratorTool {
  name: string;
  description: string;
  shape(z: unknown): Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

/** Run a tool and shape its outcome for the model; failures become `isError` with one line. */
export async function invokeTool(tool: OrchestratorTool, args: unknown, onCall?: (name: string, ok: boolean) => void): Promise<ToolResult> {
  try {
    const value = await tool.run(args && typeof args === 'object' ? (args as Record<string, unknown>) : {});
    onCall?.(tool.name, true);
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 1);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    onCall?.(tool.name, false);
    const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 300);
    return { content: [{ type: 'text', text: reason }], isError: true };
  }
}
