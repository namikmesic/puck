/**
 * Pure harness descriptors: everything about a harness provider (Claude
 * Code, Codex) that is plain data - identity, models, the option schema and
 * its compiler, capabilities, pinned container packages, container env, and
 * where its CLI keeps credentials inside an environment. No node:* or
 * electron imports, so the app and the code running inside environments
 * share one definition. The host halves (sign-in, credential mirror) live in
 * src/main/providers/.
 */

import type { ProviderCapabilities } from '../bridge';
import type { ProviderOption, SettingsMap } from '../options';
import { claudeHarness } from './claude';
import { codexHarness } from './codex';

/**
 * An npm package installed into containers at an exact version. Pins keep
 * the environment daemon in lockstep with the packages it was written
 * against; provisioning verifies the installed version after install and
 * fails setup on drift. Bump a pin together with the daemon code that
 * depends on that version. An SDK pin must also match the devDependency the
 * daemon's types are checked against.
 */
export interface PinnedPackage {
  name: string;
  /** Exact version (no range). */
  version: string;
}

export interface HarnessPackages {
  /** CLI binary name (empty for API-key-only providers without a CLI). */
  cliBin: string;
  /** npm -g packages that provide the harness CLI. */
  cli: PinnedPackage[];
  /** npm packages the daemon loads from /opt/puck/node_modules. */
  sdk: PinnedPackage[];
}

export interface HarnessDescriptor {
  /** Persisted in stores, definitions, and daemon dispatch — never rename. */
  readonly id: string;
  readonly label: string;
  /** Known model ids, 'auto' first. */
  readonly models: readonly string[];
  /** Thinking/effort levels, 'auto' first. */
  readonly thinkingLevels: readonly string[];
  /** Where this harness places the agent's instructions. */
  readonly systemPromptHint: string;
  /** Per-agent option schema. Definitions are checked against it. */
  readonly configOptions: readonly ProviderOption[];
  readonly capabilities: ProviderCapabilities;
  /**
   * Sparse validated settings → the exact SDK options (Claude) / config
   * (Codex) fragment the daemon applies before the `advanced` passthrough.
   */
  compileSettings(settings: SettingsMap): SettingsMap;
  readonly packages: HarnessPackages;
  /** Non-secret env baked into the container at creation (e.g. IS_SANDBOX=1). */
  readonly containerEnv: Readonly<Record<string, string>>;
  /**
   * The CLI credential file inside an environment, whose agents run as the
   * unprivileged user with HOME=/puck/home.
   */
  readonly credentialPath: string;
}

export { claudeHarness, codexHarness };

/** Registration order matters: the first entry is the default harness. */
export const harnessDescriptors: readonly HarnessDescriptor[] = [claudeHarness, codexHarness];

export function harnessDescriptorById(id: string): HarnessDescriptor | undefined {
  return harnessDescriptors.find((d) => d.id === id);
}
