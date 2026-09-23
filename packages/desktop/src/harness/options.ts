/**
 * Schema-driven provider configuration.
 *
 * Each provider declares its configurable surface as `ProviderOption`
 * descriptors; the agent editor renders them generically (toggles, sliders,
 * segmented controls), the main process validates saved values against the
 * schema, and compile turns them into the SDK options fragment the container
 * runner applies. Adding an option is one descriptor entry in the provider's
 * module — UI, validation, persistence, and transport all follow the schema.
 *
 * Values are SPARSE: only user overrides are stored and compiled. The runner
 * keeps encoding the defaults, so untouched agents behave identically across
 * runner versions and SDK default changes are never pinned by the schema.
 */

interface OptionBase {
  /** Stable id — the SDK/config key it compiles to; dots denote nesting. */
  id: string;
  label: string;
  description: string;
  /** Section heading in the editor; groups render in declaration order. */
  group: string;
  /**
   * Named layout slot: options whose group carries this render inside an
   * existing editor card (e.g. Identity) instead of their own group card.
   * All options of one group must agree (enforced by provider-settings.test).
   */
  slot?: 'identity';
  /** Tucked into the group's collapsed "Advanced" disclosure. */
  advanced?: boolean;
  /**
   * Show/compile only while another option's effective value matches. Single
   * level: a `showIf` target must not itself be conditional.
   */
  showIf?: { optionId: string; equals: string | number | boolean };
  /** Warning shown while the value is non-default. */
  danger?: string;
  /**
   * Compile mapping: omitted = identity (id as SDK key, dots expanded);
   * a string = that key; null = consumed by the provider's compileSettings
   * special-case code (tool toggles, coupled fields).
   */
  sdkKey?: string | null;
}

export interface BooleanOption extends OptionBase {
  kind: 'boolean';
  default: boolean;
}

export interface EnumOption extends OptionBase {
  kind: 'enum';
  values: string[];
  /** Display labels parallel to `values` (falls back to the values). */
  labels?: string[];
  /** Ordered scale — renders as a discrete slider instead of a segmented control. */
  ordinal?: boolean;
  default: string;
}

export interface NumberOption extends OptionBase {
  kind: 'number';
  min: number;
  max: number;
  step: number;
  /** null = unset (provider default) until the user picks a value. */
  default: number | null;
}

export interface StringOption extends OptionBase {
  kind: 'string';
  default: string;
  placeholder?: string;
}

export interface StringListOption extends OptionBase {
  kind: 'string-list';
  default: string[];
  placeholder?: string;
}

export type ProviderOption =
  | BooleanOption
  | EnumOption
  | NumberOption
  | StringOption
  | StringListOption;

export type SettingsMap = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/** Clamp to [min, max] and snap onto the option's step grid. */
function clampNumber(opt: NumberOption, value: number): number {
  const clamped = Math.min(opt.max, Math.max(opt.min, value));
  const snapped = opt.min + Math.round((clamped - opt.min) / opt.step) * opt.step;
  // Re-clamp (snapping can overshoot max) and kill float noise like 0.30000000000000004.
  return Number(Math.min(opt.max, snapped).toPrecision(12));
}

/** True when `value` equals the option's default (an override would be redundant). */
export function isDefaultValue(opt: ProviderOption, value: unknown): boolean {
  if (opt.kind === 'string-list') {
    const list = cleanList(value);
    return list !== null && JSON.stringify(list) === JSON.stringify(opt.default);
  }
  return value === opt.default;
}

/**
 * The persistence/IPC gate. Drops unknown ids, mistyped values, out-of-enum
 * values; clamps and step-snaps numbers; cleans string-lists; drops values
 * equal to their default so the stored record stays sparse. Never throws.
 */
export function validateSettings(
  schema: readonly ProviderOption[],
  raw: unknown,
): SettingsMap {
  const out: SettingsMap = {};
  if (!isPlainObject(raw)) return out;
  for (const opt of schema) {
    const value = raw[opt.id];
    if (value === undefined || value === null) continue;
    let valid: unknown;
    switch (opt.kind) {
      case 'boolean':
        if (typeof value !== 'boolean') continue;
        valid = value;
        break;
      case 'enum':
        if (typeof value !== 'string' || !opt.values.includes(value)) continue;
        valid = value;
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        valid = clampNumber(opt, value);
        break;
      case 'string':
        if (typeof value !== 'string') continue;
        valid = value.trim();
        break;
      case 'string-list': {
        const list = cleanList(value);
        if (list === null) continue;
        valid = list;
        break;
      }
    }
    if (!isDefaultValue(opt, valid)) out[opt.id] = valid;
  }
  return out;
}

/** Effective value of one option: the stored override, else the default. */
export function effectiveValue(
  schema: readonly ProviderOption[],
  settings: SettingsMap,
  id: string,
): unknown {
  const opt = schema.find((o) => o.id === id);
  if (!opt) return undefined;
  return settings[id] !== undefined ? settings[id] : opt.default;
}

export function showIfSatisfied(
  schema: readonly ProviderOption[],
  settings: SettingsMap,
  opt: ProviderOption,
): boolean {
  if (!opt.showIf) return true;
  return effectiveValue(schema, settings, opt.showIf.optionId) === opt.showIf.equals;
}

/**
 * Overrides whose `showIf` is satisfied against effective values. Sanitize
 * keeps unsatisfied entries (so toggling the controller back restores the
 * user's choice); compile filters them here.
 */
export function activeSettings(
  schema: readonly ProviderOption[],
  settings: SettingsMap,
): SettingsMap {
  const out: SettingsMap = {};
  for (const opt of schema) {
    if (settings[opt.id] === undefined) continue;
    if (showIfSatisfied(schema, settings, opt)) out[opt.id] = settings[opt.id];
  }
  return out;
}

/** { 'a.b': 1, c: 2 } → { a: { b: 1 }, c: 2 }, merging dotted siblings. */
export function expandDots(flat: SettingsMap): SettingsMap {
  const out: SettingsMap = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let node = out;
    for (const part of parts.slice(0, -1)) {
      const existing = node[part];
      if (isPlainObject(existing)) {
        node = existing;
      } else {
        const child: SettingsMap = {};
        node[part] = child;
        node = child;
      }
    }
    node[parts[parts.length - 1]] = value;
  }
  return out;
}

/**
 * The generic compile pass: showIf-filter, map ids through `sdkKey` (identity
 * + dot expansion; `sdkKey: null` options are skipped for the provider's own
 * compileSettings to consume), return the SDK fragment.
 */
export function compileGeneric(
  schema: readonly ProviderOption[],
  settings: SettingsMap,
): SettingsMap {
  const active = activeSettings(schema, settings);
  const flat: SettingsMap = {};
  for (const opt of schema) {
    if (active[opt.id] === undefined || opt.sdkKey === null) continue;
    flat[opt.sdkKey ?? opt.id] = active[opt.id];
  }
  return expandDots(flat);
}
