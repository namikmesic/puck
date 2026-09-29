/**
 * Contract of the `window.puck` bridge the preload script exposes.
 *
 * The main process owns provider selection (Claude Code / Codex), the Docker
 * environment lifecycle, and per-session harness state; the renderer starts
 * turns and receives `HarnessEvent`s tagged with a turnId.
 */

import type { HarnessEvent } from './types';
import type { ProviderOption } from './options';
import type { DefinitionChange, DefinitionListing, DefinitionRefs, PinSpec, UpdateClass } from './definitions/types';
import type { RunnerAsset, RunnerDockerInfo, RunnerStatusWord, ServerInstanceStatus } from './server-api';

export type { RunnerAsset, RunnerDockerInfo, RunnerStatusWord, ServerInstanceStatus } from './server-api';
import type { DaemonEvent, InstanceState, OpArgs, OpResult, Pin, RendererOp, Snapshot } from './daemon-protocol';
import type { InstanceStage } from './runner-protocol';

export type {
  DefinitionListing,
  DefinitionRefs,
  ListedError,
  Pin,
  PinKind,
  PinSpec,
  RefInfo,
} from './definitions/types';

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

/** The three kinds of provider Puck configures; ids are unique across kinds. */
export type ProviderKind = 'harness' | 'environment' | 'integration';

/** One provider's state at a glance, whatever its kind. */
export interface ProviderStatus {
  state: 'connected' | 'disconnected' | 'pending' | 'error';
  /** One user-facing line, e.g. the signed-in account or where the docker CLI was found. */
  detail: string;
}

/** A harness provider (Claude Code, Codex): runs agents inside environments. */
export interface HarnessProviderInfo {
  kind: 'harness';
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
  status: ProviderStatus;
  auth: ProviderAuthInfo;
}

/** A runner as Settings and the start flow show it (`GET /v1/runners` plus what this install knows). */
export interface RunnerRow {
  id: string;
  name: string;
  labels: string[];
  os: string;
  arch: string;
  version: string;
  /** `SHA256:…` of the runner's key; `config.sh` prints the same. */
  fingerprint: string;
  status: RunnerStatusWord;
  /** Running environments, as the runner last reported. */
  running: number;
  maxEnvironments: number | null;
  docker: RunnerDockerInfo | null;
  createdAt: number;
  lastSeenAt: number | null;
  /** The This Mac runner this app installed (reached over its local socket). */
  local: boolean;
  /** The environments the Puck server places on this runner. */
  environments: { envId: string; definition: string; status: ServerInstanceStatus }[];
  /** The server lists a different key than this install first saw: channels are refused. */
  keyChanged: boolean;
}

/** The This Mac runner: installed by the app as a LaunchAgent, reached over a local socket. */
export interface LocalRunnerState {
  /** False on machines the runner does not ship for (it needs macOS on Apple silicon). */
  supported: boolean;
  installed: boolean;
  runnerId: string | null;
  /** An install or uninstall in progress. */
  busy: 'installing' | 'uninstalling' | null;
  /** The current step, or the last result, in words. */
  detail: string;
  error: string | null;
}

/** Everything the Runners settings render, in one read. */
export interface RunnersState {
  /** Signed in to the Puck server (runners belong to the signed-in user). */
  signedIn: boolean;
  login: string | null;
  /** The Puck server's URL. */
  server: string;
  /** The app's live connection to the server (push events, relay). */
  connection: 'idle' | 'connecting' | 'connected' | 'offline';
  runners: RunnerRow[];
  local: LocalRunnerState;
}

/** The runner environment provider: every environment runs on one of the user's runners. */
export interface EnvironmentProviderInfo {
  kind: 'environment';
  id: string;
  label: string;
  status: ProviderStatus;
  runners: RunnersState;
}

/** A registration token and what the Add runner dialog needs to show the commands. */
export interface RunnerRegistration {
  /** Revokes the token (Cancel in the dialog). */
  id: string;
  token: string;
  expiresAt: number;
  /** What `config.sh --url` takes. */
  serverUrl: string;
  /** The latest runner release, per platform; empty when the server publishes none. */
  version: string | null;
  assets: RunnerAsset[];
}

/** A removal token and the command that uses it. */
export interface RunnerRemoval {
  id: string;
  token: string;
  expiresAt: number;
  command: string;
}

/** Pushed main → renderer when the runner list, This Mac or the server connection changed. */
export type RunnerEvent =
  | { kind: 'upsert'; runner: RunnerRow }
  | { kind: 'removed'; runnerId: string }
  | { kind: 'state'; state: RunnersState };

/** What `providerAuthStart` returns: the sign-in page opened in the system browser. */
export interface AuthStart {
  url: string;
}

/** GitHub's integration state as Settings shows it. Never carries a token. */
export interface GitHubStatus {
  /** The GitHub login signed in to Puck, null when signed out. */
  login: string | null;
  /** `owner/name` of the config repo, or null until one is chosen. */
  configRepo: string | null;
  /** Where to install the GitHub App on an account; null unless the client id and slug are both set. */
  installUrl: string | null;
  /** The Puck server GitHub sign-in goes through. */
  server: string;
}

/** An integration provider (GitHub): an external service Puck signs in to. */
export interface IntegrationProviderInfo {
  kind: 'integration';
  id: string;
  label: string;
  status: ProviderStatus;
  auth: ProviderAuthInfo;
  github: GitHubStatus;
}

export type ProviderInfo = HarnessProviderInfo | EnvironmentProviderInfo | IntegrationProviderInfo;

/** The app's connection to an environment's daemon. */
export type AttachState = 'connecting' | 'attached' | 'reconnecting' | 'unreachable' | 'incompatible' | 'detached';

/** What the app is doing to an environment right now, or last failed to do. */
export interface InstanceOp {
  kind: 'starting' | 'stopping' | 'resuming' | 'rebuilding' | 'deleting';
  /** The runner's stage (`pulling-image`, …) while it works; then the daemon's provisioning stages arrive as events. */
  stage: InstanceStage | null;
  detail: string;
  startedAt: number;
  /** Set when the operation failed; the op stays until the next one starts. */
  error: string | null;
}

/** One environment as the app shows it: the Puck server's index, the runner, and this app's attachment. */
export interface InstanceInfo {
  id: string;
  /** The environment definition's name. */
  name: string;
  runnerId: string;
  runnerName: string;
  /** Hosted by the This Mac runner. */
  local: boolean;
  /** In the index: on its runner (active), kept by a removed runner (orphaned), or on a force-removed runner (lost). */
  status: ServerInstanceStatus;
  repos: string[];
  /** The attached environment (only one at a time). */
  current: boolean;
  attach: AttachState | null;
  attachDetail: string;
  /** The daemon's own lifecycle, from its last `instance.status` event this app applied. */
  daemon: InstanceState | null;
  op: InstanceOp | null;
  /** The last daemon event this app applied (replay resumes after it). */
  lastSeq: number | null;
  /** The attached daemon runs another build than the one this app carries: offer the update. */
  daemonUpdate?: boolean;
}

/** What the start flow sends: main resolves the pin, reads the definition, and checks everything first. */
export interface StartSpec {
  pin: PinSpec;
  /** The environment definition's name at that pin. */
  definition: string;
  runnerId: string;
  /** Values for the definition's `secrets`. */
  secrets: Record<string, string>;
}

export type InstanceEvent = { kind: 'upsert'; instance: InstanceInfo } | { kind: 'removed'; envId: string };

/**
 * A newer definition for an environment (its branch moved, or a newer tag
 * exists), and what applying it changes, grouped by how each change
 * applies: hot (nothing is interrupted), reprovision (the daemon runs its
 * provisioning again), rebuild (the container is recreated; work is kept).
 */
export interface InstanceUpdate {
  pin: Pin;
  changes: Record<UpdateClass, DefinitionChange[]>;
}

/** Pushed main → renderer for the attached environment: each daemon event in seq order, or a resync snapshot. */
export type DaemonEventPayload =
  | { envId: string; seq: number; at: number; ev: DaemonEvent }
  | { envId: string; snapshot: Snapshot };

/** One GitHub App installation the signed-in user can reach. */
export interface GithubInstallation {
  id: number;
  /** The account (user or organization) the app is installed on. */
  account: string;
  accountType: string;
  /** github.com page where the installation is managed. */
  manageUrl: string;
  repositorySelection: string;
}

export interface GithubRepo {
  /** `owner/name`. */
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
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
 * requires bumping `v` and adding a read-side migration. The daemon's
 * transcript format v2 (`transcript.ts`) follows these merge rules and adds
 * `notice` entries and a `turnId`.
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
  /** Every provider of every kind; `ProviderInfo.kind` discriminates. */
  providers(): Promise<ProviderInfo[]>;
  /** Open an http(s) link in the system browser (chat links never navigate the app). */
  openExternal(url: string): Promise<void>;
  /** Begins a provider login in the system browser and returns the page it
   *  opened: a harness's own sign-in, or GitHub (signing in to the Puck
   *  server). The login lands asynchronously - poll `providers()` for
   *  `auth.connected`. */
  providerAuthStart(id: string): Promise<AuthStart>;
  /** Aborts a pending login; no-op when none is pending. */
  providerAuthCancel(id: string): Promise<void>;
  providerAuthLogout(id: string): Promise<void>;

  /** The user's runners, This Mac, and the server connection. */
  runners(): Promise<RunnersState>;
  /** A one-hour registration token for `config.sh`, with the release to download. */
  runnerRegistrationToken(): Promise<RunnerRegistration>;
  /** Revokes a registration token (the Add runner dialog's Cancel). */
  runnerRegistrationCancel(tokenId: string): Promise<void>;
  /** A one-hour removal token and the `config.sh remove` command for a runner. */
  runnerRemovalToken(runnerId: string): Promise<RunnerRemoval>;
  /** Removes a runner whose machine is gone; its environments read as lost. */
  runnerForceRemove(runnerId: string): Promise<RunnersState>;
  runnerUpdate(runnerId: string, patch: { name?: string; labels?: string[] }): Promise<RunnersState>;
  /** Installs and registers the This Mac runner (a LaunchAgent). Resolves once it runs. */
  runnerInstallLocal(): Promise<RunnersState>;
  /** Removes the This Mac runner; its environments are kept (delete them with docker). */
  runnerUninstallLocal(): Promise<RunnersState>;
  onRunnerEvent(cb: (e: RunnerEvent) => void): void;

  /** Every environment in the Puck server's index. */
  instanceList(): Promise<InstanceInfo[]>;
  /**
   * Starts a new environment: checks the definition, harness sign-ins,
   * secrets and the runner, records it with the Puck server, creates it on
   * the runner and attaches. Resolves with its id once the runner started
   * the container; provisioning continues in `onInstanceEvent` and
   * `onDaemonEvent`.
   */
  instanceStart(spec: StartSpec): Promise<{ envId: string }>;
  /** Attaches to an environment and makes it the current one (the previous one keeps working). */
  instanceOpen(envId: string): Promise<void>;
  instanceStop(envId: string): Promise<void>;
  instanceResume(envId: string): Promise<void>;
  /** Recreates the container from the definition at its pin; volumes, and so all work, are kept. */
  instanceRebuild(envId: string): Promise<void>;
  /** Deletes the container, its volumes and image on the runner, and the index entry. */
  instanceDelete(envId: string): Promise<void>;
  /** Forgets an environment whose runner is gone (lost or orphaned): only the index entry goes. */
  instanceForget(envId: string): Promise<void>;
  /** A newer definition for the environment's pin, or null when it runs the newest. */
  instanceCheckUpdate(envId: string): Promise<InstanceUpdate | null>;
  /**
   * Moves the environment to `pin`. Hot and reprovision changes go to the
   * attached daemon (nothing running is interrupted); a change that needs a
   * rebuild rebuilds the container at the new pin.
   */
  instanceApplyUpdate(envId: string, pin: PinSpec): Promise<void>;
  /**
   * Updates the attached environment's daemon to the build this app
   * carries: the runner stages it, then the daemon swaps it in after its
   * running turns finish (`drain`) or at once (`now`), and restarts.
   */
  instanceUpgradeDaemon(envId: string, mode: 'drain' | 'now'): Promise<void>;
  onInstanceEvent(cb: (e: InstanceEvent) => void): void;
  /** A command to an environment's daemon (renderer allowlist only). */
  daemon<K extends RendererOp>(envId: string, op: K, args: OpArgs<K>): Promise<OpResult<K>>;
  onDaemonEvent(cb: (e: DaemonEventPayload) => void): void;

  /** GitHub App installations the signed-in user can reach. */
  githubInstallations(): Promise<GithubInstallation[]>;
  /** Repositories the GitHub sign-in can reach, for the config-repo picker. */
  githubRepos(): Promise<GithubRepo[]>;
  /** Choose the config repo (`owner/name`); returns the updated provider list. */
  githubSetConfigRepo(fullName: string): Promise<ProviderInfo[]>;

  /** The config repo's tags and branches, and the default tag to pin. */
  definitionRefs(): Promise<DefinitionRefs>;
  /** Every definition at a pin, validated; errors carry file:line and an Open in GitHub link. */
  definitionsAt(pin: PinSpec): Promise<DefinitionListing>;

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
