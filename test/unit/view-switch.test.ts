// @vitest-environment jsdom

/**
 * The Chat | Board switch: tabs with the selected one as the tab stop,
 * ←/→ to switch, the needs-input count on Board and the unread dot on Chat.
 */

import { describe, expect, it, vi } from 'vitest';
import { initViewSwitch } from '../../src/renderer/view-switch';

function setup() {
  document.body.innerHTML = `<div id="views"><button id="chat"></button><span id="dot"></span><button id="board"></button><span id="badge"></span></div>`;
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const pick = vi.fn();
  const sw = initViewSwitch({ root: byId('views'), chat: byId('chat'), board: byId('board'), chatDot: byId('dot'), boardBadge: byId('badge') }, pick);
  return { sw, pick, byId };
}

describe('view switch', () => {
  it('is a tablist whose selected tab is the one tab stop', () => {
    const { sw, byId } = setup();
    sw.show({ view: 'board', hidden: false, needs: 0, unread: false });
    expect(byId('views').getAttribute('role')).toBe('tablist');
    expect(byId('board').getAttribute('aria-selected')).toBe('true');
    expect(byId('chat').getAttribute('aria-selected')).toBe('false');
    expect(byId('board').tabIndex).toBe(0);
    expect(byId('chat').tabIndex).toBe(-1);
    sw.show({ view: 'chat', hidden: true, needs: 0, unread: false });
    expect(byId('views').classList.contains('hidden')).toBe(true);
  });

  it('switches on click and with the arrow keys', () => {
    const { pick, byId } = setup();
    byId('board').click();
    expect(pick).toHaveBeenLastCalledWith('board');
    byId('board').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(pick).toHaveBeenLastCalledWith('chat');
    expect(document.activeElement).toBe(byId('chat'));
    byId('chat').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(pick).toHaveBeenLastCalledWith('board');
  });

  it('counts questions waiting on the user, and marks unread chat', () => {
    const { sw, byId } = setup();
    sw.show({ view: 'board', hidden: false, needs: 2, unread: true });
    expect(byId('badge').textContent).toBe('2');
    expect(byId('badge').classList.contains('hidden')).toBe(false);
    expect(byId('board').getAttribute('aria-label')).toBe('Board, 2 waiting on you');
    expect(byId('dot').classList.contains('hidden')).toBe(false);
    expect(byId('chat').getAttribute('aria-label')).toBe('Chat, new messages');
    sw.show({ view: 'chat', hidden: false, needs: 0, unread: false });
    expect(byId('badge').classList.contains('hidden')).toBe(true);
    expect(byId('dot').classList.contains('hidden')).toBe(true);
  });
});
