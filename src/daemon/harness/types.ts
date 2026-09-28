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

/** Compiled settings, then the agent's `advanced` passthrough LAST. */
export function applyOverrides(target: Record<string, unknown>, req: AdapterRequest): void {
  Object.assign(target, req.settings, req.agent.advanced);
}
