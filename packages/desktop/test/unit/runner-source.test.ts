import { describe, expect, it } from 'vitest';
import { providers } from '../../src/main/providers';
import { WIRE } from '../../src/main/runner';
import { RUNNER_SOURCE as source } from '../../src/main/runner-source';

describe('container runner source', () => {
  it('is syntactically valid JavaScript', () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it('has a PROVIDERS entry and SDK import for every registered provider', () => {
    // Derived from the live registry: adding a provider host-side without
    // updating runner.js must fail here, not silently misroute at runtime.
    for (const p of providers) {
      expect(source, `runner.js PROVIDERS lacks '${p.id}'`).toMatch(
        new RegExp(`['"]?${p.id}['"]?:\\s*\\{`),
      );
      for (const pkg of p.container.sdkPackages) {
        expect(source, `runner.js does not import ${pkg}`).toContain(pkg);
      }
    }
  });

  it('declares the same wire contract as the host (WIRE)', () => {
    const opMatch = source.match(/const OP = (\{[^}]*\});/);
    const rvMatch = source.match(/const RV = (\d+);/);
    expect(opMatch, 'runner.js OP block missing').toBeTruthy();
    expect(rvMatch, 'runner.js RV missing').toBeTruthy();
    if (!opMatch || !rvMatch) return;
    const ops = new Function(`return ${opMatch[1]}`)() as Record<string, string>;
    expect(ops).toEqual(WIRE.ops);
    expect(Number(rvMatch[1])).toBe(WIRE.rv);
  });

  it('keeps the stdio protocol markers', () => {
    expect(source).toContain('ready: true, rv: RV');
    expect(source).toContain('providerSessionId');
  });

  it('applies compiled settings before the advanced passthrough in both providers', () => {
    expect(source).toContain('[req.settings, req.advanced]');
    const claude = source.slice(source.indexOf('async function runClaude'), source.indexOf('async function runCodex'));
    const codex = source.slice(source.indexOf('async function runCodex'));
    for (const fn of [claude, codex]) expect(fn).toContain('applyOverrides(');
  });

  it('pairs bypassPermissions with its explicit SDK opt-in', () => {
    expect(source).toContain('allowDangerouslySkipPermissions: true');
  });

  it('delivers Codex system instructions as developer instructions, not prompt text', () => {
    expect(source).toContain('developer_instructions');
    expect(source).not.toContain('System instructions:');
  });

  it('fails loudly on unknown providers instead of falling back', () => {
    expect(source).not.toContain("|| PROVIDERS['claude-code']");
  });
});
