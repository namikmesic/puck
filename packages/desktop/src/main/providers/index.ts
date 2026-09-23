/**
 * Provider registry. Everything outside this directory addresses providers
 * through here — adding a provider means adding one descriptor module and
 * one entry below (plus its runner-side PROVIDERS entry in runner-source.ts).
 */

import type { ProviderInfo } from '../../harness/bridge';
import type { Provider } from './types';
import { claudeProvider } from './claude';
import { codexProvider } from './codex';

export type { Provider } from './types';

/** Registration order matters: the first entry is the default provider. */
export const providers: readonly Provider[] = [claudeProvider, codexProvider];

export function providerById(id: string): Provider | undefined {
  return providers.find((p) => p.id === id);
}

export function requireProvider(id: string): Provider {
  const provider = providerById(id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}

export function defaultProvider(): Provider {
  return providers[0];
}

export function toInfo(provider: Provider): ProviderInfo {
  return {
    id: provider.id,
    label: provider.label,
    models: provider.models,
    thinkingLevels: provider.thinkingLevels,
    systemPromptHint: provider.systemPromptHint,
    configOptions: [...provider.configOptions],
    capabilities: provider.capabilities,
    auth: provider.auth.status(),
  };
}

export function providerInfos(): ProviderInfo[] {
  return providers.map(toInfo);
}

/** Fan a login callback out to every provider's auth implementation. */
export function setOnLogin(cb: () => void): void {
  for (const provider of providers) provider.auth.setOnLogin(cb);
}
