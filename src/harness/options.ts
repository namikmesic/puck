/**
 * Schema-driven provider configuration.
 *
 * Each provider declares its configurable surface as `ProviderOption`
 * descriptors. An agent definition's `options:` are checked strictly
 * (`checkSettings`), the generated JSON Schema follows those descriptors,
 * and compile turns sparse overrides into the SDK fragment the environment
 * daemon applies. Adding an option is one descriptor in the provider module.
 *
 * Values are sparse: only overrides are compiled. The daemon's adapters
 * encode the defaults, so an untouched agent is not pinned to a schema default.
 */

interface OptionBase {
  /** Stable id — the SDK/config key it compiles to; dots denote nesting. */
  id: string;
  label: string;
  description: string;
  /** Section heading. Groups stay in declaration order. */
  group: string;
  /**
   * Named slot. Every option in one group must use the same slot
   * (`provider-settings.test.ts`).
   */
  slot?: 'identity';
  /** Marked advanced relative to the other options in its group. */
  advanced?: boolean;
  /**
   * Compile only while another option's effective value matches. Single
   * level: a `showIf` target must not itself be conditional.
   */
  showIf?: { optionId: string; equals: string | number | boolean };
  /** Warning associated with a non-default value. */
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
  /** Labels parallel to `values` (same length when present). */
  labels?: string[];
  /** Ordered scale, rather than an unordered set of values. */
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
 * Lenient sanitize before compile. Drops unknown ids, mistyped values, and
 * out-of-enum values; clamps and step-snaps numbers; cleans string-lists;
 * drops values equal to their default so only overrides remain. Never throws.
 * Definitions are checked strictly by `checkSettings` instead.
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

export interface SettingsError {
  /** The option id, or '' when the map itself is wrong. */
  id: string;
  message: string;
}

/** Numbers within this distance of the step grid count as on it (float noise). */
const STEP_EPSILON = 1e-9;

function checkValue(opt: ProviderOption, value: unknown): string | null {
  switch (opt.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'enum':
      if (typeof value !== 'string') return `must be one of ${opt.values.map((v) => JSON.stringify(v)).join(', ')}`;
      return opt.values.includes(value) ? null : `must be one of ${opt.values.map((v) => JSON.stringify(v)).join(', ')}`;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (value < opt.min || value > opt.max) return `must be between ${opt.min} and ${opt.max}`;
      const steps = (value - opt.min) / opt.step;
      if (Math.abs(steps - Math.round(steps)) > STEP_EPSILON) return `must be a multiple of ${opt.step} from ${opt.min}`;
      return null;
    }
    case 'string':
      return typeof value === 'string' ? null : 'must be a string';
    case 'string-list':
      return Array.isArray(value) && value.every((item) => typeof item === 'string') ? null : 'must be a list of strings';
  }
}

/**
 * The strict check for options written by hand (agent definitions): unknown
 * ids, wrong types, values outside an enum or a number's range and step are
 * errors, not silently dropped. `value` holds the entries that passed,
 * exactly as written, so a valid sparse map comes back unchanged. Internal
 * callers that must never fail keep using validateSettings.
 */
export function checkSettings(
  schema: readonly ProviderOption[],
  raw: unknown,
): { value: SettingsMap; errors: SettingsError[] } {
  const value: SettingsMap = {};
  const errors: SettingsError[] = [];
  if (raw === undefined) return { value, errors };
  if (!isPlainObject(raw)) return { value, errors: [{ id: '', message: 'options must be a map of option ids to values' }] };
  for (const [id, v] of Object.entries(raw)) {
    const opt = schema.find((o) => o.id === id);
    if (!opt) {
      errors.push({ id, message: `unknown option "${id}"` });
      continue;
    }
    const problem = checkValue(opt, v);
    if (problem) errors.push({ id, message: `${id} ${problem}` });
    else value[id] = v;
  }
  return { value, errors };
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
 * Overrides whose `showIf` is satisfied against effective values.
 * `validateSettings` keeps unsatisfied entries; compile drops them here.
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
