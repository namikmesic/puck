/**
 * Provider kinds: everything Puck configures is a provider of one of three
 * kinds, sharing one registry (index.ts) and one Settings page.
 *
 *  - harness (Claude Code, Codex): the pure descriptor from
 *    src/harness/providers/ plus the host half - sign-in and the CLI
 *    credential file mirrored into containers. Execution lives
 *    container-side in runner/runner.js as the PROVIDERS table, the
 *    hand-synced mirror of the descriptors.
 *  - environment (`runner`): the user's runners, listed by the Puck server,
 *    with This Mac among them. The app never runs docker for them; it
 *    opens channels to a runner, which runs Docker on its machine.
 *  - integration (GitHub): an external service Puck signs in to, through
 *    the Puck server.
 *
 * Provider ids are persisted and never renamed.
 */

import type { GitHubStatus, ProviderAuthInfo, ProviderKind, ProviderStatus, RunnersState } from '../../harness/bridge';
import type { HarnessDescriptor } from '../../harness/providers';
import type { RunnerTransport } from '../runners/channel';

export type { ProviderKind, ProviderStatus } from '../../harness/bridge';
export type { HarnessDescriptor, PinnedPackage } from '../../harness/providers';

export interface ProviderBase {
  readonly kind: ProviderKind;
  /** Persisted (agent records, stores, runner dispatch) - NEVER change. */
  readonly id: string;
  readonly label: string;
  /** Current state without I/O: sign-in state, or what is configured. */
  status(): ProviderStatus;
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
 * The environment provider: runners. Its targets are the signed-in user's
 * runners from the Puck server, This Mac among them when the app installed
 * it. Channels to a runner go through the server's relay, end-to-end
 * encrypted, or over This Mac's local socket.
 */
export interface EnvironmentProvider extends ProviderBase {
  readonly kind: 'environment';
  /** The runners, This Mac, and the server connection, without I/O. */
  state(): RunnersState;
  /** Opens channels to one runner. Throws for an unknown runner or a changed key. */
  transport(runnerId: string): RunnerTransport;
}

/** Sign-in lifecycle of an integration: signing in to the Puck server with GitHub. */
export interface IntegrationAuth {
  status(): ProviderAuthInfo;
  /** Opens the sign-in page in the system browser; resolves with its URL. */
  start(): Promise<string>;
  cancel(): void;
  /** Sign out: a fence like the harness logout. */
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
