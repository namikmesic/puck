import { describe, expect, it } from 'vitest';
import {
  activeSettings,
  compileGeneric,
  effectiveValue,
  expandDots,
  isDefaultValue,
  validateSettings,
  type ProviderOption,
} from '../../src/harness/options';

const schema: readonly ProviderOption[] = [
  {
    kind: 'enum',
    id: 'sandbox_mode',
    label: 'Sandbox',
    description: '',
    group: 'Sandbox',
    values: ['read-only', 'workspace-write', 'danger-full-access'],
    default: 'danger-full-access',
  },
  {
    kind: 'boolean',
    id: 'sandbox_workspace_write.network_access',
    label: 'Network',
    description: '',
    group: 'Sandbox',
    default: false,
    showIf: { optionId: 'sandbox_mode', equals: 'workspace-write' },
  },
  {
    kind: 'string-list',
    id: 'sandbox_workspace_write.writable_roots',
    label: 'Writable roots',
    description: '',
    group: 'Sandbox',
    default: [],
    showIf: { optionId: 'sandbox_mode', equals: 'workspace-write' },
  },
  {
    kind: 'number',
    id: 'maxTurns',
    label: 'Max turns',
    description: '',
    group: 'Limits',
    min: 1,
    max: 200,
    step: 1,
    default: null,
  },
  {
    kind: 'number',
    id: 'maxBudgetUsd',
    label: 'Budget',
    description: '',
    group: 'Limits',
    min: 0.5,
    max: 100,
    step: 0.5,
    default: null,
  },
  {
    kind: 'boolean',
    id: 'tool.Bash',
    label: 'Bash',
    description: '',
    group: 'Tools',
    default: true,
    sdkKey: null,
  },
  {
    kind: 'string',
    id: 'note',
    label: 'Note',
    description: '',
    group: 'Misc',
    default: '',
  },
];

describe('validateSettings', () => {
  it('drops unknown ids and mistyped values', () => {
    expect(
      validateSettings(schema, {
        bogus: true,
        sandbox_mode: 42,
        'tool.Bash': 'nope',
        maxTurns: 'many',
      }),
    ).toEqual({});
  });

  it('rejects non-object input without throwing', () => {
    expect(validateSettings(schema, null)).toEqual({});
    expect(validateSettings(schema, 'x')).toEqual({});
    expect(validateSettings(schema, [1])).toEqual({});
  });

  it('enforces enum membership', () => {
    expect(validateSettings(schema, { sandbox_mode: 'yolo' })).toEqual({});
    expect(validateSettings(schema, { sandbox_mode: 'read-only' })).toEqual({
      sandbox_mode: 'read-only',
    });
  });

  it('clamps and step-snaps numbers', () => {
    expect(validateSettings(schema, { maxTurns: 9999 })).toEqual({ maxTurns: 200 });
    expect(validateSettings(schema, { maxTurns: 0 })).toEqual({ maxTurns: 1 });
    expect(validateSettings(schema, { maxTurns: 12.7 })).toEqual({ maxTurns: 13 });
    expect(validateSettings(schema, { maxBudgetUsd: 1.3 })).toEqual({ maxBudgetUsd: 1.5 });
    expect(validateSettings(schema, { maxTurns: NaN })).toEqual({});
  });

  it('cleans string lists and rejects non-string entries', () => {
    expect(
      validateSettings(schema, {
        sandbox_mode: 'workspace-write',
        'sandbox_workspace_write.writable_roots': [' /a ', '', '/b'],
      }),
    ).toEqual({
      sandbox_mode: 'workspace-write',
      'sandbox_workspace_write.writable_roots': ['/a', '/b'],
    });
    expect(
      validateSettings(schema, { 'sandbox_workspace_write.writable_roots': [1] }),
    ).toEqual({});
  });

  it('drops values equal to their default (sparseness)', () => {
    expect(
      validateSettings(schema, {
        sandbox_mode: 'danger-full-access',
        'tool.Bash': true,
        'sandbox_workspace_write.writable_roots': [],
        note: '  ',
      }),
    ).toEqual({});
  });

  it('keeps showIf entries even when the condition is unsatisfied', () => {
    // sandbox_mode is default (danger-full-access) — network_access kept anyway.
    expect(
      validateSettings(schema, { 'sandbox_workspace_write.network_access': true }),
    ).toEqual({ 'sandbox_workspace_write.network_access': true });
  });
});

describe('isDefaultValue / effectiveValue', () => {
  it('compares list defaults structurally', () => {
    const opt = schema[2];
    expect(isDefaultValue(opt, [])).toBe(true);
    expect(isDefaultValue(opt, ['/a'])).toBe(false);
  });

  it('effectiveValue falls back to the default', () => {
    expect(effectiveValue(schema, {}, 'sandbox_mode')).toBe('danger-full-access');
    expect(effectiveValue(schema, { sandbox_mode: 'read-only' }, 'sandbox_mode')).toBe(
      'read-only',
    );
    expect(effectiveValue(schema, {}, 'nope')).toBeUndefined();
  });
});

describe('activeSettings', () => {
  it('filters entries whose showIf is unsatisfied', () => {
    const settings = { 'sandbox_workspace_write.network_access': true };
    expect(activeSettings(schema, settings)).toEqual({});
  });

  it('keeps entries once the controller matches', () => {
    const settings = {
      sandbox_mode: 'workspace-write',
      'sandbox_workspace_write.network_access': true,
    };
    expect(activeSettings(schema, settings)).toEqual(settings);
  });
});

describe('expandDots', () => {
  it('nests dotted keys and merges siblings', () => {
    expect(
      expandDots({
        'sandbox_workspace_write.network_access': true,
        'sandbox_workspace_write.writable_roots': ['/a'],
        sandbox_mode: 'workspace-write',
      }),
    ).toEqual({
      sandbox_workspace_write: { network_access: true, writable_roots: ['/a'] },
      sandbox_mode: 'workspace-write',
    });
  });
});

describe('compileGeneric', () => {
  it('compiles nothing from an empty settings map', () => {
    expect(compileGeneric(schema, {})).toEqual({});
  });

  it('maps identity ids, expands dots, and skips sdkKey:null options', () => {
    expect(
      compileGeneric(schema, {
        sandbox_mode: 'workspace-write',
        'sandbox_workspace_write.network_access': true,
        'tool.Bash': false,
        maxTurns: 30,
      }),
    ).toEqual({
      sandbox_mode: 'workspace-write',
      sandbox_workspace_write: { network_access: true },
      maxTurns: 30,
    });
  });

  it('drops showIf-unsatisfied overrides at compile', () => {
    expect(
      compileGeneric(schema, { 'sandbox_workspace_write.network_access': true }),
    ).toEqual({});
  });
});
