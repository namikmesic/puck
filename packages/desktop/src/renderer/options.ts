/**
 * Generic provider-options form. Renders a `ProviderOption[]` schema as
 * grouped rows of toggles, sliders, and segmented controls; tracks SPARSE
 * overrides (values equal to the schema default are dropped), so `values()`
 * returns exactly what `AgentConfig.settings` persists.
 */

import type { EnumOption, ProviderOption, SettingsMap } from '../harness/options';
import { isDefaultValue, showIfSatisfied, validateSettings } from '../harness/options';
import { asButton, el } from './dom';
import { buildSeg, button } from './util';

export interface OptionsForm {
  /** Sparse overrides — values equal to defaults are absent. */
  values(): SettingsMap;
  /** The rendered group cards (excluding slotted groups), in declaration order. */
  groups: Array<{ name: string; el: HTMLElement }>;
}

/** A slot host card plus the badge in its head that shows the change count. */
export interface OptionSlot {
  host: HTMLElement;
  badge: HTMLElement;
}

type SlotName = NonNullable<ProviderOption['slot']>;

function enumLabel(opt: EnumOption, value: string): string {
  const idx = opt.values.indexOf(value);
  return (idx !== -1 && opt.labels?.[idx]) || value || 'default';
}

/** Range input with a live value readout, shared by the number and ordinal-enum controls. */
function sliderControl(
  label: string,
  min: string,
  max: string,
  step: string,
  onInput: (raw: string) => void,
): { wrap: HTMLElement; input: HTMLInputElement; val: HTMLElement } {
  const wrap = el('span', 'slider-wrap');
  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'slider';
  input.min = min;
  input.max = max;
  input.step = step;
  input.setAttribute('aria-label', label);
  const val = el('span', 'slider-val');
  input.addEventListener('input', () => onInput(input.value));
  wrap.appendChild(input);
  wrap.appendChild(val);
  return { wrap, input, val };
}

function defaultLabel(opt: ProviderOption): string {
  switch (opt.kind) {
    case 'boolean':
      return opt.default ? 'on' : 'off';
    case 'enum':
      return enumLabel(opt, opt.default);
    case 'number':
      return opt.default === null ? 'auto' : String(opt.default);
    case 'string':
      return opt.default || 'empty';
    case 'string-list':
      return opt.default.length ? opt.default.join(', ') : 'none';
  }
}

export function renderOptionsForm(
  container: HTMLElement,
  schema: readonly ProviderOption[],
  initial: SettingsMap,
  /**
   * Slot name → host card: groups whose options declare that `slot` render
   * their rows into the host (an existing card such as Identity) instead of
   * getting their own card. The host receives `dataset.modified` and its
   * badge the change count, so change-dots work the same as for group cards.
   */
  slots: Partial<Record<SlotName, OptionSlot>> = {},
): OptionsForm {
  container.textContent = '';
  for (const slot of Object.values(slots)) {
    slot.host.querySelector(':scope > .opt-slot')?.remove();
    delete slot.host.dataset.modified;
    // Clear the badge too — if this schema has no group for the slot, no
    // refresher will ever touch it again and stale text would survive.
    slot.badge.textContent = '';
  }
  const overrides = new Map(Object.entries(validateSettings(schema, initial)));
  const settings = (): SettingsMap => Object.fromEntries(overrides);

  // Each row registers a refresher; any change re-syncs every row so showIf
  // visibility, reset chips, and danger notes always track effective values.
  const refreshers: Array<() => void> = [];
  const refreshAll = (): void => refreshers.forEach((fn) => fn());
  const setOverride = (opt: ProviderOption, value: unknown): void => {
    if (isDefaultValue(opt, value)) overrides.delete(opt.id);
    else overrides.set(opt.id, value);
    refreshAll();
  };

  type Control = { node: HTMLElement; sync(value: unknown): void };

  function buildControl(opt: ProviderOption): Control {
    switch (opt.kind) {
      case 'boolean': {
        const wrap = el('label', 'switch');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.setAttribute('aria-label', opt.label);
        input.addEventListener('change', () => setOverride(opt, input.checked));
        wrap.appendChild(input);
        wrap.appendChild(el('span', 'switch-track'));
        return {
          node: wrap,
          sync: (value) => {
            input.checked = value === true;
          },
        };
      }
      case 'enum': {
        if (opt.ordinal) {
          const { wrap, input, val } = sliderControl(
            opt.label,
            '0',
            String(opt.values.length - 1),
            '1',
            (raw) => setOverride(opt, opt.values[Number(raw)]),
          );
          return {
            node: wrap,
            sync: (value) => {
              const idx = Math.max(0, opt.values.indexOf(String(value)));
              input.value = String(idx);
              val.textContent = enumLabel(opt, opt.values[idx]);
            },
          };
        }
        if (opt.values.length <= 4) {
          const wrap = el('div', 'seg');
          wrap.setAttribute('role', 'radiogroup');
          wrap.setAttribute('aria-label', opt.label);
          const buttons = buildSeg(
            wrap,
            opt.values.map((value) => ({ value, label: enumLabel(opt, value) })),
            opt.default,
            (value) => setOverride(opt, value),
          );
          return {
            node: wrap,
            sync: (value) => {
              buttons.forEach((btn, i) =>
                btn.setAttribute('aria-pressed', String(opt.values[i] === value)),
              );
            },
          };
        }
        const select = document.createElement('select');
        select.setAttribute('aria-label', opt.label);
        for (const value of opt.values) {
          const item = document.createElement('option');
          item.value = value;
          item.textContent = enumLabel(opt, value);
          select.appendChild(item);
        }
        select.addEventListener('change', () => setOverride(opt, select.value));
        return {
          node: select,
          sync: (value) => {
            select.value = String(value);
          },
        };
      }
      case 'number': {
        const { wrap, input, val } = sliderControl(
          opt.label,
          String(opt.min),
          String(opt.max),
          String(opt.step),
          (raw) => setOverride(opt, Number(raw)),
        );
        return {
          node: wrap,
          sync: (value) => {
            const set = typeof value === 'number';
            // Unset — the provider default applies until first interaction; the
            // whole control dims so the parked-at-min thumb doesn't read as one.
            input.value = String(set ? value : opt.min);
            val.textContent = set ? String(value) : 'default';
            wrap.classList.toggle('unset', !set);
          },
        };
      }
      case 'string': {
        const input = document.createElement('input');
        input.placeholder = opt.placeholder ?? '';
        input.setAttribute('aria-label', opt.label);
        input.addEventListener('change', () => setOverride(opt, input.value.trim()));
        return {
          node: input,
          sync: (value) => {
            input.value = typeof value === 'string' ? value : '';
          },
        };
      }
      case 'string-list': {
        const input = document.createElement('input');
        input.placeholder = opt.placeholder ?? 'a, b, c';
        input.setAttribute('aria-label', opt.label);
        input.addEventListener('change', () =>
          setOverride(
            opt,
            input.value.split(',').map((item) => item.trim()).filter(Boolean),
          ),
        );
        return {
          node: input,
          sync: (value) => {
            input.value = Array.isArray(value) ? value.join(', ') : '';
          },
        };
      }
    }
  }

  function buildRow(opt: ProviderOption): HTMLElement {
    const row = el('div', 'opt-row');
    row.dataset.opt = opt.id;

    const info = el('div', 'opt-info');
    info.appendChild(el('span', 'opt-name', opt.label));
    const desc = el('div', 'opt-desc', opt.description);
    const reset = button('opt-default', `default: ${defaultLabel(opt)}`);
    reset.title = 'Reset to default';
    asButton(reset);
    reset.addEventListener('click', () => {
      overrides.delete(opt.id);
      refreshAll();
    });
    desc.appendChild(reset);
    info.appendChild(desc);
    row.appendChild(info);

    const control = buildControl(opt);
    const controlCell = el('div', 'opt-control');
    controlCell.appendChild(control.node);
    row.appendChild(controlCell);

    const danger = opt.danger ? el('div', 'opt-danger', opt.danger) : null;
    if (danger) row.appendChild(danger);

    refreshers.push(() => {
      const overridden = overrides.has(opt.id);
      const effective = overridden ? overrides.get(opt.id) : opt.default;
      control.sync(effective);
      reset.classList.toggle('on', overridden);
      danger?.classList.toggle('hidden', !overridden);
      row.classList.toggle('hidden', !showIfSatisfied(schema, settings(), opt));
    });
    return row;
  }

  // Runs of adjacent toggles compact into a multi-column grid (Claude's Tools
  // group is 11 of them); everything else stays a full-width row, so the
  // declared option order always survives.
  function appendRows(parent: HTMLElement, opts: readonly ProviderOption[]): void {
    let i = 0;
    while (i < opts.length) {
      let j = i;
      while (j < opts.length && opts[j].kind === 'boolean') j += 1;
      if (j - i >= 2) {
        const grid = el('div', 'opt-bool-grid');
        for (let k = i; k < j; k += 1) grid.appendChild(buildRow(opts[k]));
        parent.appendChild(grid);
        i = j;
        continue;
      }
      parent.appendChild(buildRow(opts[i]));
      i += 1;
    }
  }

  // Groups render in first-seen declaration order as titled cards; advanced
  // options collapse into a per-group disclosure (opened when one is already
  // set). Each card tracks its override count for headers and section navs.
  const groups = new Map<string, { plain: ProviderOption[]; advanced: ProviderOption[] }>();
  for (const opt of schema) {
    const group = groups.get(opt.group) ?? { plain: [], advanced: [] };
    (opt.advanced ? group.advanced : group.plain).push(opt);
    groups.set(opt.group, group);
  }
  const rendered: OptionsForm['groups'] = [];
  for (const [name, group] of groups) {
    const slotName = [...group.plain, ...group.advanced][0]?.slot;
    const slot = slotName ? slots[slotName] : undefined;
    let section: HTMLElement;
    let modified: HTMLElement;
    if (slot) {
      // Slotted group: rows join the host card under its existing heading.
      section = el('div', 'opt-slot');
      modified = slot.badge;
    } else {
      section = el('section', 'opt-group ed-card');
      const head = el('div', 'ed-card-head');
      head.appendChild(el('h5', 'opt-group-title', name));
      modified = el('span', 'opt-group-mod');
      head.appendChild(modified);
      section.appendChild(head);
      rendered.push({ name, el: section });
    }
    appendRows(section, group.plain);
    if (group.advanced.length) {
      const details = el('details', 'opt-adv');
      const summary = el('summary', '', 'Advanced');
      summary.appendChild(el('span', 'opt-adv-count', String(group.advanced.length)));
      details.appendChild(summary);
      appendRows(details, group.advanced);
      details.open = group.advanced.some((opt) => overrides.has(opt.id));
      section.appendChild(details);
    }
    const ids = [...group.plain, ...group.advanced].map((opt) => opt.id);
    const marked = slot?.host ?? section;
    refreshers.push(() => {
      const count = ids.filter((id) => overrides.has(id)).length;
      marked.dataset.modified = String(count);
      modified.textContent = count ? `${count} changed` : '';
    });
    (slot?.host ?? container).appendChild(section);
  }
  refreshAll();

  return { values: settings, groups: rendered };
}
