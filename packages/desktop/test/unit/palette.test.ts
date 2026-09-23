// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, ConversationEntry } from '../../src/harness/bridge';
import { initPalette } from '../../src/renderer/palette';

const agents: AgentInfo[] = [
  { id: 'a1', name: 'Coder', provider: 'claude-code' } as AgentInfo,
  { id: 'a2', name: 'Reviewer', provider: 'codex' } as AgentInfo,
];

const logs: Record<string, ConversationEntry[]> = {
  a1: [{ kind: 'user', text: 'refactor the parser please', author: 'user', ts: 1 }],
  a2: [
    {
      kind: 'turn',
      ts: 2,
      events: [{ kind: 'text-delta', text: 'the flux capacitor is charged' }],
    },
  ],
};

function mount() {
  const openConversation = vi.fn();
  const palette = initPalette({
    agents: () => agents,
    logOf: (id) => logs[id],
    providerLabel: (id) => `label:${id}`,
    openConversation,
  });
  return { palette, openConversation };
}

const overlay = () => document.querySelector('.palette-overlay');
const input = () => document.querySelector('.palette-input') as HTMLInputElement;
const items = () => [...document.querySelectorAll('.palette-item')];
const type = (q: string) => {
  input().value = q;
  input().dispatchEvent(new Event('input'));
};

afterEach(() => {
  document.body.textContent = '';
});

describe('command palette', () => {
  it('open() lists every agent with its provider label; toggle() closes again', () => {
    const { palette } = mount();
    expect(palette.isOpen()).toBe(false);
    palette.toggle();
    expect(palette.isOpen()).toBe(true);
    expect(items().map((n) => n.querySelector('.palette-label')?.textContent)).toEqual([
      'Coder',
      'Reviewer',
    ]);
    expect(items()[0].querySelector('.palette-sub')?.textContent).toBe('label:claude-code');
    palette.toggle();
    expect(palette.isOpen()).toBe(false);
    expect(overlay()).toBeNull();
  });

  it('filters agents by name and searches conversation text from two characters', () => {
    const { palette } = mount();
    palette.open();
    type('cod');
    // "Coder" matches by name; a1's log contains no "cod", a2's does not either.
    expect(items().map((n) => n.querySelector('.palette-label')?.textContent)).toEqual(['Coder']);

    type('flux capacitor');
    const [hit] = items();
    expect(hit.querySelector('.palette-label')?.textContent).toContain('flux capacitor');
    expect(hit.querySelector('.palette-sub')?.textContent).toBe('in Reviewer');
  });

  it('clicking a result navigates and closes', () => {
    const { palette, openConversation } = mount();
    palette.open();
    type('parser');
    (items()[0] as HTMLElement).click();
    expect(openConversation).toHaveBeenCalledWith('a1');
    expect(palette.isOpen()).toBe(false);
  });

  it('Enter activates the first result; Escape and backdrop click close', () => {
    const { palette, openConversation } = mount();
    palette.open();
    type('review');
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(openConversation).toHaveBeenCalledWith('a2');

    palette.open();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(palette.isOpen()).toBe(false);

    palette.open();
    (overlay() as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(palette.isOpen()).toBe(false);
  });

  it('caps the list at 12 rows', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      name: `Agent ${i}`,
      provider: 'codex',
    })) as AgentInfo[];
    const palette = initPalette({
      agents: () => many,
      logOf: () => undefined,
      providerLabel: () => '',
      openConversation: vi.fn(),
    });
    palette.open();
    expect(items().length).toBe(12);
  });
});
