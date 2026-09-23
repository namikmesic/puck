/**
 * The Provider interface: everything Puck needs to know about one agent
 * provider (Claude Code, Codex, …), declared in one place.
 *
 * A provider implementation covers four surfaces:
 *  - descriptor: identity + agent-editor metadata (models, thinking levels,
 *    system-prompt semantics, capability flags shown to the frontend)
 *  - auth: the OAuth login lifecycle
 *  - container: how the provider is installed into and authenticated inside
 *    environment containers
 *  - execution: lives container-side in runner/runner.js as the PROVIDERS
 *    table — the hand-synced mirror of this interface (TypeScript cannot
 *    reach into the embedded runner string)
 */

import type { ProviderCapabilities } from '../../harness/bridge';
import type { ProviderOption, SettingsMap } from '../../harness/options';

/** Login + token lifecycle for one provider account. */
export interface ProviderAuth {
  status(): { connected: boolean; detail: string };
  /**
   * Opens the sign-in window; resolves with the authorize URL. The login
   * itself completes asynchronously (window intercept / loopback server).
   */
  start(): Promise<string>;
  logout(): void;
  /** Invoked whenever a login lands (host pushes creds into running envs). */
  setOnLogin(cb: () => void): void;
}

/** A CLI credential file Puck mirrors between host and containers. */
export interface ProviderCredential {
  /** Absolute host-side CLI file, docker-cp'd on env start when present. */
  hostPath: string;
  /** Full in-container path Puck reads/writes (and `cat`s on stop). */
  containerPath: string;
  /**
   * Fresh serialized body (refreshing tokens when stale), or null when logged
   * out. `supersedes(theirs)` must be true when our copy should overwrite the
   * container's — strictly fresher, or the container copy is unparseable.
   */
  fresh(): Promise<{ content: string; supersedes(containerJson: string): boolean } | null>;
  /** Adopt container-side tokens when fresher (CLIs rotate them mid-session). */
  adoptIfNewer(containerJson: string): void;
}

/** How the provider is installed and authenticated inside containers. */
export interface ContainerIntegration {
  /** Binary probed with `command -v` before installing the CLI. */
  cliBin: string;
  /** npm -g packages that provide the interactive CLI. */
  cliPackages: string[];
  /** npm packages the runner agent needs under /opt/puck. */
  sdkPackages: string[];
  /** Host env vars forwarded into the container at creation. */
  forwardedEnvKeys: string[];
  /** Env baked into the container at creation (e.g. IS_SANDBOX=1). */
  containerEnv: Record<string, string>;
  credential: ProviderCredential;
}

export interface Provider {
  /** Persisted in puck-agents.json and runner dispatch — NEVER change. */
  readonly id: string;
  readonly label: string;
  /** Model ids for the agent editor, 'auto' first. */
  readonly models: string[];
  /** Thinking/effort levels, 'auto' first. */
  readonly thinkingLevels: string[];
  /** Agent-editor hint: where the system prompt lands for this provider. */
  readonly systemPromptHint: string;
  /** Schema-driven per-agent options rendered generically by the agent editor. */
  readonly configOptions: readonly ProviderOption[];
  readonly capabilities: ProviderCapabilities;
  readonly auth: ProviderAuth;
  readonly container: ContainerIntegration;
  /**
   * Sparse validated settings → the exact SDK options (Claude) / config
   * (Codex) fragment the runner applies before the `advanced` passthrough.
   */
  compileSettings(settings: SettingsMap): SettingsMap;
}
