// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { initPaneLayout, readPanes } from '../../src/renderer/pane-layout';

function setup(stored: string | null = null, narrow = false) {
  document.body.innerHTML = '<div id="root"><div id="l"></div><div id="r"></div></div>';
  const byId = (id: string) => document.getElementById(id) as HTMLElement;
  const memory = new Map<string, string>();
  if (stored) memory.set('puck.panes', stored);
  let isNarrow = narrow;
  const layout = initPaneLayout({
    els: { root: byId('root'), leftHandle: byId('l'), rightHandle: byId('r') },
    storage: { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v) },
    narrow: () => isNarrow,
  });
  return { layout, root: byId('root'), left: byId('l'), right: byId('r'), memory, setNarrow: (n: boolean) => (isNarrow = n) };
}

describe('pane layout', () => {
  it('reads saved widths within bounds, and defaults the rest', () => {
    expect(readPanes(null)).toEqual({ left: 280, right: 300, leftCollapsed: false, rightCollapsed: false });
    expect(readPanes('{"left":900,"right":10,"leftCollapsed":true}')).toEqual({ left: 420, right: 240, leftCollapsed: true, rightCollapsed: false });
    expect(readPanes('not json').left).toBe(280);
    const { root } = setup('{"left":300}');
    expect(root.style.getPropertyValue('--bl-w')).toBe('300px');
    expect(root.style.getPropertyValue('--wp-w')).toBe('300px');
  });

  it('resizes with arrow keys on a handle and remembers it', () => {
    const { left, right, root, memory } = setup();
    left.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(root.style.getPropertyValue('--bl-w')).toBe('296px');
    right.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(root.style.getPropertyValue('--wp-w')).toBe('316px');
    expect(JSON.parse(memory.get('puck.panes') as string)).toMatchObject({ left: 296, right: 316 });
  });

  it('collapses panes, and in a narrow window opens the right pane as a drawer', () => {
    const { layout, root, setNarrow } = setup();
    layout.toggleLeft();
    expect(root.classList.contains('bl-collapsed')).toBe(true);
    layout.toggleRight();
    expect(root.classList.contains('wp-collapsed')).toBe(true);
    layout.toggleRight();
    setNarrow(true);
    layout.toggleRight();
    expect(root.classList.contains('wp-drawer-open')).toBe(true);
    expect(layout.closeDrawer()).toBe(true);
    expect(layout.closeDrawer()).toBe(false);
  });
});
