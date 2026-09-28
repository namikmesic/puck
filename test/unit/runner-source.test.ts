import { describe, expect, it } from 'vitest';
import { byKind } from '../../src/main/providers';
import { WIRE } from '../../src/main/runner';
import { RUNNER_SOURCE as source } from '../../src/main/runner-source';

describe('container runner source', () => {
  it('is syntactically valid JavaScript', () => {
    expect(() => new Function(source)).not.toThrow();
  });

  it('has a PROVIDERS entry and SDK import for every registered provider', () => {
    // Derived from the live registry: adding a provider host-side without
    // updating runner.js must fail here, not silently misroute at runtime.
    for (const p of byKind('harness')) {
      expect(source, `runner.js PROVIDERS lacks '${p.id}'`).toMatch(
        new RegExp(`['"]?${p.id}['"]?:\\s*\\{`),
      );
      for (const pkg of p.packages.sdk) {
        expect(source, `runner.js does not import ${pkg.name}`).toContain(pkg.name);
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

  it('runs the stdio dispatch only as the main script (unit tests load it as a module)', () => {
    expect(source).toContain('require.main === module');
    expect(source).toContain('module.exports = {');
  });

  it('maps Codex collab items to sub-agent cards, not raw cards', () => {
    expect(source).toContain("'collab_tool_call'");
    for (const tool of ['spawn_agent', 'send_input', 'wait', 'close_agent']) {
      expect(source, `runner.js does not know collab tool ${tool}`).toContain(`'${tool}'`);
    }
  });

  it('fails loudly on unknown providers instead of falling back', () => {
    expect(source).not.toContain("|| PROVIDERS['claude-code']");
  });
});
