// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { initCommandPalette, paletteRows, type CommandPaletteContext } from '../../src/renderer/command-palette';
import { ENV, ENV2, instance, item } from './v2-fixtures';

function ctx(over: Partial<CommandPaletteContext> = {}): CommandPaletteContext {
  return {
    instances: () => [instance(), instance({ id: ENV2, name: 'website', runnerName: 'This Mac' })],
    currentEnv: () => ENV,
    items: () => [item({ number: 12, title: 'Fix login redirect', status: 'running' }), item({ number: 3, title: 'Usage docs' })],
    history: () => ['Create two items please', 'Both are queued for implementer'],
    commands: () => [{ label: 'New item', hint: '⌘N', run: vi.fn() }, { label: 'Settings', hint: '⌘,', run: vi.fn() }],
    openEnv: vi.fn(),
    openItem: vi.fn(),
    openHistory: vi.fn(),
    ...over,
  };
}

describe('command palette', () => {
  it('finds items by W-n or title, commands, other environments and chat history', () => {
    const c = ctx();
    expect(paletteRows(c, 'w-12').map((r) => r.label)).toEqual(['W-12 Fix login redirect']);
    expect(paletteRows(c, '12').map((r) => r.label)).toEqual([]);
    expect(paletteRows(c, 'usage').map((r) => r.label)).toEqual(['W-3 Usage docs']);
    expect(paletteRows(c, '').map((r) => r.label)).toEqual(['New item', 'Settings', 'Switch to website']);
    expect(paletteRows(c, 'queued').map((r) => r.sub)).toEqual(['in the orchestrator chat']);
  });

  it('opens, runs the first row on Enter, and closes on Escape', () => {
    const c = ctx();
    const p = initCommandPalette(c);
    p.open();
    const input = document.querySelector('.palette-input') as HTMLInputElement;
    input.value = 'webs';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(c.openEnv).toHaveBeenCalledWith(ENV2);
    expect(p.isOpen()).toBe(false);
    p.toggle();
    expect(p.isOpen()).toBe(true);
    (document.querySelector('.palette-input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(p.isOpen()).toBe(false);
  });
});
