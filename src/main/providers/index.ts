/**
 * Provider registry: every provider of every kind, in one list. Everything
 * outside this directory addresses providers through here - adding one
 * means adding its module and one entry below (a harness provider also
 * needs an adapter in src/daemon/harness). The checklist is in AGENTS.md.
 */

import type { ProviderInfo } from '../../harness/bridge';
import type { HarnessProvider, Provider, ProviderKind, ProviderOfKind } from './types';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';
import { githubProvider } from './github';
import { runnerProvider } from '../runners';

export type {
  EnvironmentProvider,
  HarnessProvider,
  IntegrationProvider,
  Provider,
  ProviderBase,
  ProviderKind,
  ProviderStatus,
} from './types';

/** Registration order matters within a kind: the first harness is the default. */
export const providers: readonly Provider[] = [
  claudeProvider,
  codexProvider,
  runnerProvider,
  githubProvider,
];

export function byKind<K extends ProviderKind>(kind: K): ProviderOfKind<K>[] {
  return providers.filter((p): p is ProviderOfKind<K> => p.kind === kind);
}

export function providerById(id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}

export function requireProvider(id: string): Provider {
  const provider = providerById(id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

/** A harness provider by id. */
export function harnessById(id: string): HarnessProvider | undefined {
  const provider = providerById(id);
  return provider?.kind === 'harness' ? provider : undefined;
}

export function requireHarness(id: string): HarnessProvider {
  const provider = harnessById(id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function defaultHarness(): HarnessProvider {
  return byKind('harness')[0];
}

export function toInfo(provider: Provider): ProviderInfo {
  switch (provider.kind) {
    case 'harness':
      return {
        kind: 'harness',
        id: provider.id,
        label: provider.label,
        models: [...provider.models],
        thinkingLevels: [...provider.thinkingLevels],
        systemPromptHint: provider.systemPromptHint,
        configOptions: [...provider.configOptions],
        capabilities: provider.capabilities,
        status: provider.status(),
        auth: provider.auth.status(),
      };
    case 'environment':
      return {
        kind: 'environment',
        id: provider.id,
        label: provider.label,
        status: provider.status(),
        runners: provider.state(),
      };
    case 'integration':
      return {
        kind: 'integration',
        id: provider.id,
        label: provider.label,
        status: provider.status(),
        auth: provider.auth.status(),
        github: provider.state(),
      };
  }
}

export async function providerInfos(): Promise<ProviderInfo[]> {
  return providers.map(toInfo);
}

/** Fan a login callback out to every harness provider's auth implementation. */
export function setOnLogin(cb: () => void): void {
  for (const provider of byKind('harness')) provider.auth.setOnLogin(cb);
}

/**
 * Fan a logout hook out to the harness providers: it runs after a provider's
 * local fence (pending login aborted, tokens cleared) so the app can remove
 * the credentials it mirrored into containers. Its rejection surfaces to the
 * caller of logout.
 */
export function setOnLogout(cb: (provider: HarnessProvider) => Promise<void>): void {
  for (const provider of byKind('harness')) provider.auth.setOnLogout(() => cb(provider));
}
