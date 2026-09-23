/**
 * Wire-level protocol between the renderer and the harness backend.
 *
 * Turns run in the main process — the active provider's SDK executes inside
 * the active environment's Docker container — and stream back over the
 * preload bridge as `HarnessEvent`s. `IpcHarness` (src/harness/ipc.ts)
 * adapts that callback stream into the `AsyncGenerator` protocol below.
 */

export interface TurnStats {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Reported by backends that meter spend (e.g. Claude Code). */
  costUsd?: number;
}

export interface AskOption {
  label: string;
  description: string;
}

/** One question the agent poses mid-turn (Claude Code's AskUserQuestion tool). */
export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect: boolean;
}

type HarnessEventBody =
  | { kind: 'turn-start'; turnId: string }
  | { kind: 'thinking'; active: boolean }
  | { kind: 'text-delta'; text: string; parentId?: string }
  | {
      kind: 'tool-start';
      toolId: string;
      tool: string;
      summary: string;
      input: string;
      /** Set when this call runs inside a sub-agent: the sub-agent's toolId. */
      parentId?: string;
      /** True when this call IS a sub-agent (rendered as an agent card). */
      agent?: boolean;
    }
  | { kind: 'tool-end'; toolId: string; ok: boolean; output: string }
  | {
      kind: 'ask';
      askId: string;
      questions: AskQuestion[];
      /** Recorded renderer-side once answered (null = dismissed), so replayed
       *  history can show the question and what was chosen. */
      answers?: Record<string, string> | null;
    }
  | { kind: 'error'; message: string }
  | { kind: 'turn-end'; stats: TurnStats };

/** Wall-clock stamp is added renderer-side when an event is recorded, so
 *  replayed history keeps original tool-call times and durations. */
export type HarnessEvent = HarnessEventBody & { ts?: number };

export interface Harness {
  /**
   * Send one user prompt to an agent's conversation. Returns the turn's id
   * (for interrupt / answerAsk routing) plus its event stream. Turns for
   * different agents may run concurrently; the backend keeps per-agent
   * history via provider resume ids.
   */
  send(agentId: string, prompt: string): { turnId: string; events: AsyncGenerator<HarnessEvent> };
  /** Interrupt a specific in-flight turn. */
  interrupt(turnId: string): void;
  /** Answer (or dismiss, with null) a mid-turn question from the agent. */
  answerAsk(turnId: string, askId: string, answers: Record<string, string> | null): Promise<void>;
}
