/**
 * Contract of the `window.puck` bridge the preload script exposes.
 *
 * The main process owns provider selection (Claude Code / Codex), the Docker
 * environment lifecycle, and per-session harness state; the renderer starts
 * turns and receives `HarnessEvent`s tagged with a turnId.
 */

import type { HarnessEvent } from './types';
import type { ProviderOption } from './options';

export interface HarnessStatus {
  /** True when an environment is selected and its container is running. */
  connected: boolean;
  /** The active agent (named provider configuration), if any. */
  agent: { id: string; name: string; provider: string; model: string } | null;
  environment: { id: string; name: string; status: string } | null;
}

/** A named, reusable provider configuration. */
export interface AgentConfig {
  id: string;
  name: string;
  /** Provider id from the registry (src/main/providers). */
  provider: string;
  /** Provider model id, or "auto" for the provider default. */
  model: string;
  /** System instructions (Claude: appended to the harness preset; Codex: sent at thread start). */
  systemPrompt: string;
  /** Reasoning-effort level, or "auto" for the provider default. */
  effort: string;
  /**
   * Sparse per-provider option overrides, keyed by `ProviderOption.id` and
   * validated against the provider's `configOptions` schema on save.
   * (On disk, legacy records may still carry the old `settings`/`thinking`
   * keys — the agent store dual-reads them at load.)
   */
  options: Record<string, unknown>;
  /**
   * JSON object merged into the provider SDK options LAST — the untyped
   * escape hatch that overrides compiled `settings`.
   */
  advanced: string;
}

export interface AgentInfo extends AgentConfig {
  active: boolean;
}

export interface EnvironmentConfig {
  name: string;
  /** Base Docker image (used when no Dockerfile is set). */
  image: string;
  /** Host directory mounted at /workspace inside the container. */
  workspacePath: string;
  /** Install the provider CLIs + SDKs into the container on start. */
  autoInstall: boolean;
  /** Optional Dockerfile; when non-empty it is built and overrides `image`. */
  dockerfile: string;
  /** Plain environment variables injected at container creation. */
  envVars: Record<string, string>;
}

export interface EnvironmentInfo extends EnvironmentConfig {
  id: string;
  status: 'running' | 'stopped';
  active: boolean;
  /** Names of secrets (values never leave the main process). */
  secretKeys: string[];
}

export interface ProviderAuthInfo {
  connected: boolean;
  detail: string;
}

/** What a provider can do — lets the frontend adapt without id checks. */
export interface ProviderCapabilities {
  /** Mid-turn 'ask' question cards (AskUserQuestion). */
  supportsAsk: boolean;
  /** Sub-agent chats (Task/Agent tools, parentId-tagged events). */
  subAgents: boolean;
  /** Token-level text deltas (vs whole-message text). */
  streamsTokens: boolean;
  /** costUsd in turn stats. */
  reportsCost: boolean;
}

export interface ProviderInfo {
  id: string;
  label: string;
  /** Known model ids ("auto" first). */
  models: string[];
  /** Supported thinking/effort levels ("auto" first). */
  thinkingLevels: string[];
  /** Agent-editor hint: where the system prompt lands for this provider. */
  systemPromptHint: string;
  /** Schema the agent editor renders as the per-provider options form. */
  configOptions: ProviderOption[];
  capabilities: ProviderCapabilities;
  auth: ProviderAuthInfo;
}

/** One persisted item of a conversation: a user message or a full agent turn. */
export type ConversationEntry =
  | { kind: 'user'; text: string; author: string; ts: number }
  | { kind: 'turn'; ts: number; events: HarnessEvent[] };

/**
 * Persisted transcript of an agent's long-lived conversation. Stored as
 * structured entries (not HTML) so restarts rebuild live UI — clickable turn
 * cards, tool cards, sub-agent chats — by replaying through the renderer.
 *
 * The persisted event dialect differs from the live wire: text-deltas are
 * merged into one, `thinking` events are dropped, and `ts` is stamped by the
 * renderer. Replay silently skips unknown kinds, so event shapes in `log`
 * are append-only — new kinds are fine, changing an existing kind's shape
 * requires bumping `v` and adding a read-side migration.
 */
export interface ConversationData {
  /** Persisted-format version; absent in pre-versioning saves (treated as 1). */
  v?: number;
  log: ConversationEntry[];
  /** Token total (input+output) of the LAST turn — not cumulative. */
  lastTurnTokens: number;
  lastActiveAt: number;
  turns: number;
  /** Composer draft, restored with the conversation. */
  draft?: string;
}

export interface BridgeEventPayload {
  turnId: string;
  event: HarnessEvent;
}

export interface PuckBridge {
  status(): Promise<HarnessStatus>;
  providers(): Promise<ProviderInfo[]>;
  /** Open an http(s) link in the system browser (chat links never navigate the app). */
  openExternal(url: string): Promise<void>;
  /** Begins a provider login (sign-in window opens); returns the authorize URL. */
  providerAuthStart(id: string): Promise<{ url: string }>;
  providerAuthLogout(id: string): Promise<void>;

  agentList(): Promise<AgentInfo[]>;
  agentCreate(cfg: Omit<AgentConfig, 'id'>): Promise<AgentInfo[]>;
  agentUpdate(id: string, cfg: Omit<AgentConfig, 'id'>): Promise<AgentInfo[]>;
  agentDelete(id: string): Promise<AgentInfo[]>;
  agentSelect(id: string): Promise<HarnessStatus>;

  envList(): Promise<EnvironmentInfo[]>;
  envCreate(cfg: EnvironmentConfig): Promise<EnvironmentInfo[]>;
  envUpdate(id: string, cfg: EnvironmentConfig): Promise<EnvironmentInfo[]>;
  envDelete(id: string): Promise<EnvironmentInfo[]>;
  envStart(id: string): Promise<EnvironmentInfo[]>;
  envStop(id: string): Promise<EnvironmentInfo[]>;
  /** Stop + start, refreshing bootstrap, credentials, and the runner. */
  envRestart(id: string): Promise<EnvironmentInfo[]>;
  /** Destroy the container and recreate it from current config (build step included). */
  envRebuild(id: string): Promise<EnvironmentInfo[]>;
  envSecretSet(id: string, key: string, value: string): Promise<EnvironmentInfo[]>;
  envSecretDelete(id: string, key: string): Promise<EnvironmentInfo[]>;
  envSelect(id: string): Promise<HarnessStatus>;

  /** Persist / restore the per-agent conversation transcripts. */
  convoSave(agentId: string, data: ConversationData): Promise<void>;
  convoLoad(): Promise<Record<string, ConversationData>>;

  /**
   * Resolves once the turn's event stream has been fully emitted.
   * `agentId` names the agent whose long-lived conversation this turn joins.
   */
  startTurn(turnId: string, agentId: string, prompt: string): Promise<void>;
  /** Interrupt an in-flight turn (SDK-native where supported). */
  interrupt(turnId: string): Promise<void>;
  /**
   * Answer an in-flight `ask` event (question text → chosen label(s) or typed
   * text). `null` dismisses the question and lets the agent continue.
   */
  answerAsk(turnId: string, askId: string, answers: Record<string, string> | null): Promise<void>;
  onEvent(cb: (payload: BridgeEventPayload) => void): void;
}

declare global {
  interface Window {
    puck?: PuckBridge;
  }
}
