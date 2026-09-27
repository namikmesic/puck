/**
 * Provider kinds: everything Puck configures is a provider of one of three
 * kinds, sharing one registry (index.ts) and one Settings page.
 *
 *  - harness (Claude Code, Codex): the pure descriptor from
 *    src/harness/providers/ plus the host half - sign-in and the CLI
 *    credential file mirrored into containers. Execution lives
 *    container-side in runner/runner.js as the PROVIDERS table, the
 *    hand-synced mirror of the descriptors.
 *  - environment (Local Docker, Docker over SSH): the Docker engines
 *    containers run on, each a target with its own health check.
 *  - integration (GitHub): an external service Puck signs in to.
 *
 * Provider ids are persisted and never renamed.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  DeviceCodePrompt,
  EnvTargetInfo,
  GitHubStatus,
  ProviderAuthInfo,
  ProviderKind,
  TargetHealth,
} from '../../harness/bridge';
import type { HarnessDescriptor } from '../../harness/providers';
import type { DockerRunner } from '../docker-client';

export type { ProviderKind } from '../../harness/bridge';
export type { HarnessDescriptor, PinnedPackage } from '../../harness/providers';

interface ProviderBase {
  readonly kind: ProviderKind;
  /** Persisted (agent records, stores, runner dispatch) - NEVER change. */
  readonly id: string;
  readonly label: string;
}

/** Login + token lifecycle for one harness provider account. */
export interface ProviderAuth {
  status(): ProviderAuthInfo;
  /**
   * Opens the authorize page in the system browser; resolves with the
   * authorize URL. The login itself completes asynchronously when the
   * browser is redirected to the provider's loopback listener.
   */
  start(): Promise<string>;
  /** Abort a pending login (no-op when none is pending). */
  cancel(): void;
  /**
   * Sign out - a fence: abort a pending login, drop Puck's stored tokens so
   * that an exchange or refresh still in flight is discarded and container
   * copies are never adopted back, then run the logout hook (the host removes
   * the credentials it mirrored into containers). Rejects when the hook
   * fails; the local sign-out has already held by then.
   */
  logout(): Promise<void>;
  /** Invoked whenever a login lands (host pushes creds into running envs). */
  setOnLogin(cb: () => void): void;
  /** Invoked after the local fence on logout (host removes container mirrors). */
  setOnLogout(cb: () => Promise<void> | void): void;
}

/** A CLI credential file Puck mirrors between host and containers. */
export interface ProviderCredential {
  /**
   * Full in-container path today's root runner reads (and Puck `cat`s on
   * stop). The descriptor's `credentialPath` is the unprivileged-user layout.
   */
  containerPath: string;
  /** True while Puck holds tokens for this provider (no refresh, no network). */
  signedIn(): boolean;
  /**
   * Fresh serialized body (refreshing tokens when stale), or null when logged
   * out. `supersedes(theirs)` must be true when our copy should overwrite the
   * container's — strictly fresher, or the container copy is unparseable.
   * `current()` turns false once the user signs out after the snapshot was
   * taken; writers check it before and after copying the body anywhere.
   */
  fresh(): Promise<{
    content: string;
    supersedes(containerJson: string): boolean;
    current(): boolean;
  } | null>;
  /** Adopt container-side tokens when fresher (CLIs rotate them mid-session). */
  adoptIfNewer(containerJson: string): void;
}

/** A harness provider: the pure descriptor plus its host half. */
export interface HarnessProvider extends ProviderBase, HarnessDescriptor {
  readonly kind: 'harness';
  readonly auth: ProviderAuth;
  readonly credential: ProviderCredential;
}

/**
 * An environment provider: one or more Docker engines (targets). Container
 * operations address a target through its argv runner, so the same Docker
 * code serves the local engine and a remote one over SSH.
 */
export interface EnvironmentProvider extends ProviderBase {
  readonly kind: 'environment';
  targets(): EnvTargetInfo[];
  /** One line about the provider itself (e.g. where the docker CLI was found). */
  detail(): Promise<string>;
  /** `docker version` against the target, with the failure classified. */
  health(targetId: string): Promise<TargetHealth>;
  /** Argv docker runner bound to the target. Throws for an unknown target. */
  runner(targetId: string): DockerRunner;
  /** Raw stdio docker process bound to the target (for long-lived exec bridges). */
  spawn(targetId: string, args: string[]): ChildProcessWithoutNullStreams;
}

/** Sign-in lifecycle of an integration: GitHub's device flow. */
export interface IntegrationAuth {
  status(): ProviderAuthInfo;
  /** Requests a device code and starts polling; resolves with the code to show. */
  start(): Promise<DeviceCodePrompt>;
  cancel(): void;
  /** Sign out: a fence like the harness logout, then the local tokens are dropped. */
  logout(): Promise<void>;
}

/** An integration provider: an external service Puck signs in to. */
export interface IntegrationProvider extends ProviderBase {
  readonly kind: 'integration';
  readonly auth: IntegrationAuth;
  /** Integration-specific state for Settings (GitHub is the only integration). */
  state(): GitHubStatus;
}

export type Provider = HarnessProvider | EnvironmentProvider | IntegrationProvider;

export type ProviderOfKind<K extends ProviderKind> = Extract<Provider, { kind: K }>;
