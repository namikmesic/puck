import { describe, expect, it } from 'vitest';
import { escapeTarget, INITIAL_NAV, navTransition, readView, saveView } from '../../src/renderer/view-nav';

describe('view nav', () => {
  it('starts on Chat and switches between Chat and Board', () => {
    expect(INITIAL_NAV).toMatchObject({ center: 'env', view: 'chat', itemId: null });
    const board = navTransition(INITIAL_NAV, { view: 'board' });
    expect(board).toMatchObject({ center: 'env', view: 'board' });
    expect(navTransition(board, { view: 'chat' }).view).toBe('chat');
    expect(escapeTarget(board)).toBeNull();
  });

  it('opens an item in the sheet over either view, and Esc closes it', () => {
    const sheet = navTransition(navTransition(INITIAL_NAV, { view: 'board' }), { view: 'item', itemId: 'itm_1' });
    expect(sheet).toMatchObject({ view: 'board', itemId: 'itm_1', tab: 'conversation' });
    expect(escapeTarget(sheet)).toEqual({ view: 'close-item' });
    const closed = navTransition(sheet, { view: 'close-item' });
    expect(closed).toMatchObject({ view: 'board', itemId: null });
    // Switching views keeps the sheet open on the same item.
    expect(navTransition(sheet, { view: 'chat' })).toMatchObject({ view: 'chat', itemId: 'itm_1' });
  });

  it('keeps the tab when reopening the same item and resets it for another', () => {
    const changes = navTransition(INITIAL_NAV, { view: 'item', itemId: 'itm_1', tab: 'changes' });
    expect(navTransition(changes, { view: 'item', itemId: 'itm_1' }).tab).toBe('changes');
    expect(navTransition(changes, { view: 'item', itemId: 'itm_2' }).tab).toBe('conversation');
  });

  it('closes modals before the sheet, and keeps the view under them', () => {
    const sheet = navTransition(INITIAL_NAV, { view: 'item', itemId: 'itm_1' });
    const settings = navTransition(sheet, { view: 'settings', section: 'runners' });
    expect(settings).toMatchObject({ view: 'chat', itemId: 'itm_1', modal: 'settings', section: 'runners' });
    expect(escapeTarget(settings)).toEqual({ view: 'close-modal' });
    const closed = navTransition(settings, { view: 'close-modal' });
    expect(closed).toMatchObject({ itemId: 'itm_1', modal: null });
    expect(navTransition(closed, { view: 'settings' }).section).toBe('runners');
    expect(navTransition(closed, { view: 'start' }).modal).toBe('start');
    expect(navTransition(settings, { view: 'first-run' })).toMatchObject({ center: 'first-run', modal: null, itemId: null });
    expect(navTransition(navTransition(settings, { view: 'first-run' }), { view: 'board' })).toMatchObject({ center: 'env', view: 'board' });
  });

  it('remembers the view per environment, defaulting to Chat, and survives broken storage', () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) };
    expect(readView(storage, 'env_a')).toBe('chat');
    saveView(storage, 'env_a', 'board');
    saveView(storage, 'env_b', 'chat');
    expect(readView(storage, 'env_a')).toBe('board');
    expect(readView(storage, 'env_b')).toBe('chat');
    expect(memory.get('puck.view.env_a')).toBe('board');
    memory.set('puck.view.env_c', 'something else');
    expect(readView(storage, 'env_c')).toBe('chat');
    const broken = {
      getItem: (): string => {
        throw new Error('denied');
      },
      setItem: (): void => {
        throw new Error('denied');
      },
    };
    expect(readView(broken, 'env_a')).toBe('chat');
    expect(() => saveView(broken, 'env_a', 'board')).not.toThrow();
    expect(readView(null, 'env_a')).toBe('chat');
  });
});
