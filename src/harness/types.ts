/**
 * The harness event protocol: what one turn of a harness session emits.
 *
 * The environment daemon's adapters translate each harness SDK's stream
 * into `HarnessEvent`s, record them in the session transcript, and publish
 * them to attached apps as `turn.event`s.
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
      note?: string;
    }
  | { kind: 'error'; message: string }
  | { kind: 'turn-end'; stats: TurnStats };

/** Wall-clock stamp added when the daemon records an event, so replayed
 *  history keeps original tool-call times and durations. */
export type HarnessEvent = HarnessEventBody & { ts?: number };
