// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ProviderOption } from '../../src/harness/options';
import { renderOptionsForm, type OptionSlot } from '../../src/renderer/options';

const schema: readonly ProviderOption[] = [
  {
    kind: 'enum',
    id: 'sandbox_mode',
    label: 'Sandbox',
    description: 'sandbox levels',
    group: 'Sandbox',
    slot: 'identity',
    values: ['read-only', 'workspace-write', 'danger-full-access'],
    labels: ['read-only', 'workspace', 'full access'],
    default: 'danger-full-access',
  },
  {
    kind: 'boolean',
    id: 'sandbox_workspace_write.network_access',
    label: 'Network access',
    description: 'allow network',
    group: 'Sandbox',
    slot: 'identity',
    default: false,
    showIf: { optionId: 'sandbox_mode', equals: 'workspace-write' },
  },
  {
    kind: 'number',
    id: 'maxTurns',
    label: 'Max turns',
    description: 'turn cap',
    group: 'Limits',
    min: 1,
    max: 200,
    step: 1,
    default: null,
  },
  {
    kind: 'enum',
    id: 'effortish',
    label: 'Effort',
    description: 'ordinal scale',
    group: 'Limits',
    values: ['low', 'medium', 'high'],
    ordinal: true,
    default: 'medium',
  },
  {
    kind: 'string-list',
    id: 'betas',
    label: 'Betas',
    description: 'beta headers',
    group: 'Limits',
    advanced: true,
    default: [],
  },
  {
    kind: 'boolean',
    id: 'danger_thing',
    label: 'Danger thing',
    description: 'risky',
    group: 'Limits',
    default: false,
    danger: 'careful now',
  },
];

function mount(
  initial: Record<string, unknown> = {},
  opts: { schema?: readonly ProviderOption[]; slots?: { identity: OptionSlot } } = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const form = renderOptionsForm(container, opts.schema ?? schema, initial, opts.slots);
  return { container, form };
}

function row(container: HTMLElement, id: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[data-opt="${CSS.escape(id)}"]`);
  if (!node) throw new Error(`row ${id} not rendered`);
  return node;
}

function q<T extends Element>(root: Element, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`missing ${selector}`);
  return node;
}

/** Click the segment labeled `label` under `root`; returns it for assertions. */
function clickSeg(root: Element, label: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll<HTMLButtonElement>('button.seg-btn')].find(
    (b) => b.textContent === label,
  );
  if (!btn) throw new Error(`segment ${label} missing`);
  btn.click();
  return btn;
}

describe('renderOptionsForm', () => {
  it('returns {} for an untouched form', () => {
    const { form } = mount();
    expect(form.values()).toEqual({});
  });

  it('renders groups in declaration order with advanced in a disclosure', () => {
    const { container } = mount();
    const titles = [...container.querySelectorAll('.opt-group-title')].map((n) => n.textContent);
    expect(titles).toEqual(['Sandbox', 'Limits']);
    expect(row(container, 'betas').closest('details.opt-adv')).toBeTruthy();
  });

  it('toggle changes produce sparse values; flipping back removes them', () => {
    const { container, form } = mount();
    const box = q<HTMLInputElement>(row(container, 'danger_thing'), 'input');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(form.values()).toEqual({ danger_thing: true });
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(form.values()).toEqual({});
  });

  it('shows danger text only while overridden', () => {
    const { container } = mount();
    const danger = q(row(container, 'danger_thing'), '.opt-danger');
    expect(danger.classList.contains('hidden')).toBe(true);
    const box = q<HTMLInputElement>(row(container, 'danger_thing'), 'input');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(danger.classList.contains('hidden')).toBe(false);
  });

  it('segmented control moves aria-pressed and drives showIf visibility', () => {
    const { container, form } = mount();
    const netRow = row(container, 'sandbox_workspace_write.network_access');
    expect(netRow.classList.contains('hidden')).toBe(true);
    const workspaceBtn = clickSeg(row(container, 'sandbox_mode'), 'workspace');
    expect(workspaceBtn.getAttribute('aria-pressed')).toBe('true');
    expect(netRow.classList.contains('hidden')).toBe(false);
    expect(form.values()).toEqual({ sandbox_mode: 'workspace-write' });
  });

  it('hidden showIf rows keep their overrides in values()', () => {
    const { container, form } = mount({
      sandbox_mode: 'workspace-write',
      'sandbox_workspace_write.network_access': true,
    });
    clickSeg(row(container, 'sandbox_mode'), 'full access');
    // sandbox_mode returned to default → dropped; hidden network override kept.
    expect(form.values()).toEqual({ 'sandbox_workspace_write.network_access': true });
  });

  it('number slider starts unset and returns no value until interacted', () => {
    const { container, form } = mount();
    const turnsRow = row(container, 'maxTurns');
    expect(q(turnsRow, '.slider-val').textContent).toBe('default');
    expect(form.values()).toEqual({});
    const slider = q<HTMLInputElement>(turnsRow, 'input[type="range"]');
    slider.value = '30';
    slider.dispatchEvent(new Event('input'));
    expect(form.values()).toEqual({ maxTurns: 30 });
    expect(q(turnsRow, '.slider-val').textContent).toBe('30');
  });

  it('ordinal enum slider maps index to value', () => {
    const { container, form } = mount();
    const slider = q<HTMLInputElement>(row(container, 'effortish'), 'input[type="range"]');
    expect(slider.value).toBe('1'); // default 'medium'
    slider.value = '2';
    slider.dispatchEvent(new Event('input'));
    expect(form.values()).toEqual({ effortish: 'high' });
  });

  it('reset chip clears an override and re-syncs the control', () => {
    const { container, form } = mount({ effortish: 'high' });
    const chip = q<HTMLButtonElement>(row(container, 'effortish'), '.opt-default');
    expect(chip.classList.contains('on')).toBe(true);
    chip.click();
    expect(form.values()).toEqual({});
    expect(chip.classList.contains('on')).toBe(false);
    expect(q<HTMLInputElement>(row(container, 'effortish'), 'input[type="range"]').value).toBe('1');
  });

  it('string-list input parses comma-separated values', () => {
    const { container, form } = mount();
    const input = q<HTMLInputElement>(row(container, 'betas'), 'input');
    input.value = ' a, , b ';
    input.dispatchEvent(new Event('change'));
    expect(form.values()).toEqual({ betas: ['a', 'b'] });
    input.value = '';
    input.dispatchEvent(new Event('change'));
    expect(form.values()).toEqual({});
  });

  it('seeds only schema-valid initial values', () => {
    const { form } = mount({ bogus: 1, maxTurns: 500, effortish: 'high' });
    expect(form.values()).toEqual({ maxTurns: 200, effortish: 'high' });
  });

  it('tracks per-group override counts on the section element', () => {
    const { container } = mount();
    const section = row(container, 'danger_thing').closest<HTMLElement>('.opt-group');
    if (!section) throw new Error('group section missing');
    expect(section.dataset.modified).toBe('0');
    expect(q(section, '.opt-group-mod').textContent).toBe('');
    const box = q<HTMLInputElement>(row(container, 'danger_thing'), 'input');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(section.dataset.modified).toBe('1');
    expect(q(section, '.opt-group-mod').textContent).toBe('1 changed');
  });

  it('packs runs of two or more adjacent booleans into a grid, keeping order', () => {
    const runSchema: readonly ProviderOption[] = [
      { kind: 'boolean', id: 'a', label: 'A', description: '', group: 'G', default: true },
      { kind: 'boolean', id: 'b', label: 'B', description: '', group: 'G', default: false },
      {
        kind: 'enum',
        id: 'c',
        label: 'C',
        description: '',
        group: 'G',
        values: ['x', 'y'],
        default: 'x',
      },
      { kind: 'boolean', id: 'd', label: 'D', description: '', group: 'G', default: false },
    ];
    const { container } = mount({}, { schema: runSchema });
    expect(row(container, 'a').closest('.opt-bool-grid')).toBeTruthy();
    expect(row(container, 'b').closest('.opt-bool-grid')).toBeTruthy();
    expect(row(container, 'c').closest('.opt-bool-grid')).toBeNull();
    expect(row(container, 'd').closest('.opt-bool-grid')).toBeNull(); // lone boolean
    const ids = [...container.querySelectorAll<HTMLElement>('[data-opt]')].map((n) => n.dataset.opt);
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('renders slotted groups into their host card and tracks its change count', () => {
    const host = document.createElement('section');
    const badge = document.createElement('span');
    host.appendChild(badge);
    document.body.appendChild(host);
    const slots = { identity: { host, badge } };

    const { container, form } = mount({}, { slots });
    expect(host.querySelector('[data-opt="sandbox_mode"]')).toBeTruthy();
    expect(container.querySelector('[data-opt="sandbox_mode"]')).toBeNull();
    // The slotted group gets no card title of its own — only Limits remains.
    const titles = [...container.querySelectorAll('.opt-group-title')].map((n) => n.textContent);
    expect(titles).toEqual(['Limits']);
    expect(host.dataset.modified).toBe('0');

    clickSeg(host, 'workspace');
    expect(host.dataset.modified).toBe('1');
    expect(badge.textContent).toBe('1 changed');
    expect(form.values()).toEqual({ sandbox_mode: 'workspace-write' });

    // A re-render replaces the previous slot content instead of stacking it.
    renderOptionsForm(container, schema, {}, slots);
    expect(host.querySelectorAll('.opt-slot').length).toBe(1);
    expect(host.dataset.modified).toBe('0');

    // A schema without the slotted group (provider switch) clears everything —
    // stale badge text must not survive.
    clickSeg(host, 'workspace');
    renderOptionsForm(
      container,
      [{ kind: 'boolean', id: 'x', label: 'X', description: '', group: 'Other', default: false }],
      {},
      slots,
    );
    expect(host.querySelector('.opt-slot')).toBeNull();
    expect(host.dataset.modified).toBeUndefined();
    expect(badge.textContent).toBe('');
  });
});
