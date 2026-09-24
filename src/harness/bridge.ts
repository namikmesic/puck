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
  /** True when an agent is selected and the active environment is `ready`. */
  connected: boolean;
  /** The active agent (named provider configuration), if any. */
  agent: { id: string; name: string; provider: string; model: string } | null;
  /** The active environment with its Puck-owned lifecycle state, if any. */
  environment: ({ id: string; name: string } & EnvLifecycle) | null;
}

/**
 * Puck-owned environment lifecycle state. Docker liveness alone is not
 * readiness: a running container may still be installing (runner not yet
 * deployed) or already stopping (Docker keeps State.Running true during the
 * stop grace period). `ready` is set only after bootstrap, credential and
 * secret injection, runner deployment, and a successful runner handshake.
 */
export type EnvStatus = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';

/** Start / stop stages, in the order a start runs them. */
export type EnvStage =
  | 'checking-image'
  | 'pulling-image'
  | 'building-image'
  | 'starting-container'
  | 'installing-clis'
  | 'installing-sdks'
  | 'verifying-packages'
  | 'deploying-runner'
  | 'injecting-credentials'
  | 'probing-runner'
  | 'stopping-container'
  | 'removing-container';

export interface EnvLifecycle {
  status: EnvStatus;
  /** Current stage while starting/stopping; the failing stage after a failure; else null. */
  stage: EnvStage | null;
  /** Last bounded, sanitized line of docker / npm output for the stage (never credentials). */
  detail: string;
  /** Epoch ms when the current (or last) operation began; null when never operated. */
  startedAt: number | null;
  /** Epoch ms when the last operation ended (ready, stopped, or failed); null while running. */
  endedAt: number | null;
  /** Classified failure message; non-null only while `status` is `failed`. */
  error: string | null;
}

/** Pushed main → renderer on every lifecycle change (see `PuckBridge.onEnvEvent`). */
export interface EnvLifecycleEvent extends EnvLifecycle {
  envId: string;
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

export interface EnvironmentInfo extends EnvironmentConfig, EnvLifecycle {
  id: string;
  active: boolean;
  /** Names of secrets (values never leave the main process). */
  secretKeys: string[];
}

export interface ProviderAuthInfo {
  connected: boolean;
  detail: string;
  /** A login is in progress in the system browser (waiting for its callback). */
  pending: boolean;
}

/** What a provider can do — lets the frontend adapt without id checks. */
export interface ProviderCapabilities {
  /** Mid-turn 'ask' question cards (AskUserQuestion). */
  supportsAsk: boolean;
  /** Sub-agent chats (Task/Agent tools, parentId-tagged events). */
  subAgents: boolean;
  /**
   * Sub-agent chats carry the child's own transcript (its text and tool
   * calls). False = lifecycle only: the spawn prompt, follow-up input, and
   * the final status (Codex over `codex exec` reports nothing else).
   */
  subAgentTranscript: boolean;
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

/** Version and data paths shown on Settings → Support (and documented in the README). */
export interface SupportInfo {
  version: string;
  /** Electron userData: the folder every Puck store and log lives under. */
  dataDir: string;
  /** The current diagnostic log file. */
  logFile: string;
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
  /** Begins a provider login (authorize page opens in the system browser);
   *  returns the authorize URL. The login lands asynchronously - poll
   *  `providers()` for `auth.connected`. */
  providerAuthStart(id: string): Promise<{ url: string }>;
  /** Aborts a pending login; no-op when none is pending. */
  providerAuthCancel(id: string): Promise<void>;
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
  /** Streamed lifecycle progress (stage, output line, failure) for every environment. */
  onEnvEvent(cb: (payload: EnvLifecycleEvent) => void): void;

  /** Persist / restore the per-agent conversation transcripts. */
  convoSave(agentId: string, data: ConversationData): Promise<void>;
  convoLoad(): Promise<Record<string, ConversationData>>;

  supportInfo(): Promise<SupportInfo>;
  /**
   * Save a support bundle (diagnostic logs plus a sanitized configuration
   * summary) where the user picks; `path` is null when the dialog is canceled.
   */
  supportExport(): Promise<{ path: string | null }>;

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
  /**
   * Main is about to quit: persist everything still pending (debounced saves,
   * the composer draft) and resolve. Quit waits for the promise (bounded).
   */
  onFlush(cb: () => Promise<void>): void;
}

declare global {
  interface Window {
    puck?: PuckBridge;
  }
}
