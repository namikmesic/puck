import { describe, expect, it } from 'vitest';
import { isDefaultValue, validateSettings, type ProviderOption } from '../../src/harness/options';
import { providers, requireProvider } from '../../src/main/providers';

/** A value guaranteed to differ from the option's default. */
function nonDefault(opt: ProviderOption): unknown {
  switch (opt.kind) {
    case 'boolean':
      return !opt.default;
    case 'enum':
      return opt.values.find((v) => v !== opt.default);
    case 'number':
      return opt.default === opt.min ? opt.max : opt.min;
    case 'string':
      return `${opt.default}x`;
    case 'string-list':
      return ['x'];
  }
}

describe('provider option schemas', () => {
  for (const provider of providers) {
    describe(provider.id, () => {
      const schema = provider.configOptions;

      it('has unique option ids', () => {
        const ids = schema.map((o) => o.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('showIf targets exist and are not themselves conditional', () => {
        for (const opt of schema) {
          if (!opt.showIf) continue;
          const target = schema.find((o) => o.id === opt.showIf?.optionId);
          expect(target, `${opt.id} showIf target`).toBeDefined();
          expect(target?.showIf, `${opt.id} showIf target must be unconditional`).toBeUndefined();
        }
      });

      it('every default passes its own validation as a non-override', () => {
        for (const opt of schema) {
          if (opt.default === null) continue; // "unset" numbers have no storable default
          expect(isDefaultValue(opt, opt.default), opt.id).toBe(true);
          expect(validateSettings(schema, { [opt.id]: opt.default })).toEqual({});
        }
      });

      it('enum labels stay parallel to values', () => {
        for (const opt of schema) {
          if (opt.kind !== 'enum') continue;
          expect(opt.values).toContain(opt.default);
          if (opt.labels) expect(opt.labels.length).toBe(opt.values.length);
        }
      });

      it('compiles an empty fragment for untouched agents', () => {
        expect(provider.compileSettings({})).toEqual({});
      });

      it('layout slots are uniform within each group', () => {
        const byGroup = new Map<string, Set<string | undefined>>();
        for (const opt of schema) {
          const set = byGroup.get(opt.group) ?? new Set<string | undefined>();
          set.add(opt.slot);
          byGroup.set(opt.group, set);
        }
        for (const [group, slotSet] of byGroup) {
          expect(slotSet.size, `${provider.id}/${group} mixes slots`).toBe(1);
        }
      });

      it('every option, when overridden, reaches the compiled output', () => {
        // Catches a compileSettings that forgot to consume an sdkKey:null
        // option — the override would otherwise vanish silently.
        for (const opt of schema) {
          const settings: Record<string, unknown> = { [opt.id]: nonDefault(opt) };
          if (opt.showIf) settings[opt.showIf.optionId] = opt.showIf.equals;
          const out = provider.compileSettings(settings);
          expect(
            Object.keys(out).length,
            `${provider.id}: override of ${opt.id} vanished in compile`,
          ).toBeGreaterThan(0);
        }
      });
    });
  }

  it('claude declares the identity slot the editor card relies on', () => {
    expect(
      requireProvider('claude-code').configOptions.some((o) => o.slot === 'identity'),
    ).toBe(true);
  });
});

describe('claude compileSettings', () => {
  const claude = requireProvider('claude-code');

  it('couples allowDangerouslySkipPermissions to the permission mode', () => {
    expect(claude.compileSettings({ permissionMode: 'plan' })).toEqual({
      permissionMode: 'plan',
      allowDangerouslySkipPermissions: false,
    });
  });

  it('turns disabled tools into disallowedTools (Agent covers legacy Task)', () => {
    expect(
      claude.compileSettings({ 'tool.Bash': false, 'tool.WebFetch': false, 'tool.Agent': false }),
    ).toEqual({ disallowedTools: ['Bash', 'WebFetch', 'Agent', 'Task'] });
  });

  it('compiles the SDK thinking shape', () => {
    expect(claude.compileSettings({ thinking: 'disabled' })).toEqual({
      thinking: { type: 'disabled' },
    });
    expect(claude.compileSettings({ thinking: 'enabled' })).toEqual({
      thinking: { type: 'enabled' },
    });
    expect(claude.compileSettings({ thinking: 'enabled', thinkingBudget: 2048 })).toEqual({
      thinking: { type: 'enabled', budgetTokens: 2048 },
    });
    // Budget without 'enabled' is showIf-inactive and must not leak.
    expect(claude.compileSettings({ thinkingBudget: 2048 })).toEqual({});
  });

  it('passes plain options through by identity', () => {
    expect(claude.compileSettings({ maxTurns: 30, fallbackModel: 'claude-sonnet-5' })).toEqual({
      maxTurns: 30,
      fallbackModel: 'claude-sonnet-5',
    });
  });
});

describe('codex compileSettings', () => {
  const codex = requireProvider('codex');

  it('nests dotted config keys', () => {
    expect(
      codex.compileSettings({
        sandbox_mode: 'workspace-write',
        'sandbox_workspace_write.network_access': true,
        'sandbox_workspace_write.writable_roots': ['/tmp/scratch'],
      }),
    ).toEqual({
      sandbox_mode: 'workspace-write',
      sandbox_workspace_write: { network_access: true, writable_roots: ['/tmp/scratch'] },
    });
  });

  it('drops workspace-write options outside workspace-write mode', () => {
    expect(
      codex.compileSettings({ 'sandbox_workspace_write.network_access': true }),
    ).toEqual({});
  });

  it('passes plain config keys through', () => {
    expect(
      codex.compileSettings({ web_search: 'live', 'agents.enabled': false }),
    ).toEqual({ web_search: 'live', agents: { enabled: false } });
  });
});

describe('sanitize round-trip through schemas', () => {
  it('validateSettings accepts a full valid override set for claude', () => {
    const schema = requireProvider('claude-code').configOptions;
    const out = validateSettings(schema, {
      permissionMode: 'plan',
      'tool.Bash': false,
      maxTurns: 50,
      thinking: 'enabled',
      thinkingBudget: 4096,
      betas: ['context-1m-2025-08-07'],
    });
    expect(out).toEqual({
      permissionMode: 'plan',
      'tool.Bash': false,
      maxTurns: 50,
      thinking: 'enabled',
      thinkingBudget: 4096,
      betas: ['context-1m-2025-08-07'],
    });
  });
});
