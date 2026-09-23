import { describe, expect, it } from 'vitest';
import {
  defaultProvider,
  providerById,
  providerInfos,
  providers,
  requireProvider,
  toInfo,
} from '../../src/main/providers';

describe('provider registry', () => {
  it('registers claude-code first (registration order is the default)', () => {
    expect(providers.map((p) => p.id)).toEqual(['claude-code', 'codex']);
    expect(defaultProvider().id).toBe('claude-code');
  });

  it('looks up by id and throws on unknown ids', () => {
    expect(providerById('codex')?.label).toBe('Codex');
    expect(providerById('nope')).toBeUndefined();
    expect(() => requireProvider('nope')).toThrow(/Unknown provider/);
  });

  it('exposes complete frontend metadata', () => {
    for (const info of providerInfos()) {
      expect(info.models[0]).toBe('auto');
      expect(info.thinkingLevels[0]).toBe('auto');
      expect(info.systemPromptHint.length).toBeGreaterThan(0);
      expect(info.configOptions.length).toBeGreaterThan(0);
      expect(typeof info.capabilities.supportsAsk).toBe('boolean');
      expect(typeof info.auth.connected).toBe('boolean');
    }
  });

  it('codex advertises the current reasoning levels', () => {
    expect(providerById('codex')?.thinkingLevels).toContain('xhigh');
  });

  it('toInfo never leaks auth methods or container internals', () => {
    const info = toInfo(providers[0]);
    expect(Object.keys(info).sort()).toEqual(
      ['auth', 'capabilities', 'configOptions', 'id', 'label', 'models', 'systemPromptHint', 'thinkingLevels'].sort(),
    );
  });

  it('derives the container bootstrap contract both providers rely on', () => {
    const clis = providers.flatMap((p) => p.container.cliPackages);
    const sdks = providers.flatMap((p) => p.container.sdkPackages);
    expect(clis).toEqual(['@anthropic-ai/claude-code', '@openai/codex']);
    expect(sdks).toEqual(['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk']);
    for (const p of providers) {
      expect(p.container.credential.containerPath.startsWith('/root/.')).toBe(true);
    }
  });
});
