import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessProviderInfo, ProviderInfo } from '../../src/harness/bridge';
import { harnessDescriptors } from '../../src/harness/providers';
import {
  byKind,
  defaultHarness,
  harnessById,
  providerById,
  providerInfos,
  providers,
  requireHarness,
  requireProvider,
  toInfo,
} from '../../src/main/providers';

const harnessInfos = async (): Promise<HarnessProviderInfo[]> =>
  (await providerInfos()).filter((i): i is HarnessProviderInfo => i.kind === 'harness');

describe('provider registry', () => {
  it('registers every kind, with frozen ids, claude-code the default harness', () => {
    expect(providers.map((p) => p.id)).toEqual(['claude-code', 'codex', 'docker-local', 'docker-ssh', 'github']);
    expect(byKind('harness').map((p) => p.id)).toEqual(['claude-code', 'codex']);
    expect(byKind('environment').map((p) => p.id)).toEqual(['docker-local', 'docker-ssh']);
    expect(byKind('integration').map((p) => p.id)).toEqual(['github']);
    expect(defaultHarness().id).toBe('claude-code');
    expect(new Set(providers.map((p) => p.id)).size).toBe(providers.length);
  });

  it('looks up by id and throws on unknown ids', () => {
    expect(providerById('codex')?.label).toBe('Codex');
    expect(providerById('docker-ssh')?.kind).toBe('environment');
    expect(providerById('nope')).toBeUndefined();
    expect(() => requireProvider('nope')).toThrow(/Unknown provider/);
    // Agents and turns only ever resolve harnesses.
    expect(harnessById('github')).toBeUndefined();
    expect(() => requireHarness('docker-local')).toThrow(/Unknown provider/);
    expect(requireHarness('codex').id).toBe('codex');
  });

  it('builds the host halves from the pure harness descriptors', () => {
    for (const d of harnessDescriptors) {
      const host = requireHarness(d.id);
      expect(host.kind).toBe('harness');
      expect(host.configOptions).toBe(d.configOptions);
      expect(host.compileSettings).toBe(d.compileSettings);
      expect(host.packages).toBe(d.packages);
      expect(host.containerEnv).toBe(d.containerEnv);
    }
  });

  it('every info carries its kind', async () => {
    const infos = await providerInfos();
    expect(infos.map((i) => [i.id, i.kind])).toEqual(providers.map((p) => [p.id, p.kind]));
  });

  it('exposes complete frontend metadata for harnesses', async () => {
    for (const info of await harnessInfos()) {
      expect(info.models[0]).toBe('auto');
      expect(info.thinkingLevels[0]).toBe('auto');
      expect(info.systemPromptHint.length).toBeGreaterThan(0);
      expect(info.configOptions.length).toBeGreaterThan(0);
      expect(typeof info.capabilities.supportsAsk).toBe('boolean');
      expect(typeof info.auth.connected).toBe('boolean');
    }
  });

  it('declares sub-agent support and whether the child transcript arrives', async () => {
    for (const info of await harnessInfos()) {
      expect(typeof info.capabilities.subAgents).toBe('boolean');
      expect(typeof info.capabilities.subAgentTranscript).toBe('boolean');
      // A transcript needs sub-agent chats to land in.
      if (info.capabilities.subAgentTranscript) expect(info.capabilities.subAgents).toBe(true);
    }
    expect(requireHarness('claude-code').capabilities).toMatchObject({ subAgents: true, subAgentTranscript: true });
    // codex exec reports collab tool calls (cards), never the child thread.
    expect(requireHarness('codex').capabilities).toMatchObject({ subAgents: true, subAgentTranscript: false });
  });

  it('codex advertises the current reasoning levels', () => {
    expect(requireHarness('codex').thinkingLevels).toContain('xhigh');
  });

  it('every provider reports a status without I/O, and its info carries it', () => {
    for (const p of providers) {
      const status = p.status();
      expect(['connected', 'disconnected', 'pending', 'error']).toContain(status.state);
      expect(typeof status.detail).toBe('string');
      expect(toInfo(p).status).toEqual(status);
    }
  });

  it('toInfo never leaks auth methods, credentials or container internals', () => {
    const keys = (id: string): string[] => Object.keys(toInfo(requireProvider(id))).sort();
    expect(keys('claude-code')).toEqual(
      [
        'auth',
        'capabilities',
        'configOptions',
        'id',
        'kind',
        'label',
        'models',
        'status',
        'systemPromptHint',
        'thinkingLevels',
      ].sort(),
    );
    expect(keys('docker-local')).toEqual(['id', 'kind', 'label', 'status', 'targets']);
    expect(keys('github')).toEqual(['auth', 'github', 'id', 'kind', 'label', 'status']);
    const gh = toInfo(requireProvider('github')) as Extract<ProviderInfo, { kind: 'integration' }>;
    expect(Object.keys(gh.github).sort()).toEqual(
      ['appConfigured', 'configRepo', 'installUrl', 'login', 'pendingCode'].sort(),
    );
  });

  it('derives the container bootstrap contract both providers rely on', () => {
    const clis = harnessDescriptors.flatMap((p) => p.packages.cli);
    const sdks = harnessDescriptors.flatMap((p) => p.packages.sdk);
    expect(clis.map((p) => p.name)).toEqual(['@anthropic-ai/claude-code', '@openai/codex']);
    expect(sdks.map((p) => p.name)).toEqual([
      '@anthropic-ai/claude-agent-sdk',
      'zod',
      '@modelcontextprotocol/sdk',
      '@openai/codex-sdk',
    ]);
    // Every container package is pinned to an exact version (no ranges):
    // provisioning verifies the installed version against it after install.
    for (const pkg of [...clis, ...sdks]) expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    // Today's runner runs as root; the descriptors name the unprivileged layout.
    for (const p of byKind('harness')) expect(p.credential.containerPath.startsWith('/root/.')).toBe(true);
    expect(harnessDescriptors.map((d) => d.credentialPath)).toEqual([
      '/puck/home/.claude/.credentials.json',
      '/puck/home/.codex/auth.json',
    ]);
  });

  it('types the daemon against the exact SDK versions containers install', () => {
    // The daemon imports the SDKs' types from devDependencies and loads the
    // packages themselves from the container pins, so the two must agree.
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    for (const sdk of harnessDescriptors.flatMap((p) => p.packages.sdk)) {
      expect([sdk.name, pkg.devDependencies[sdk.name]]).toEqual([sdk.name, sdk.version]);
    }
  });
});
