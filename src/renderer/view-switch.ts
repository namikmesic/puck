/**
 * The Chat | Board switch in the top bar: a two-tab segmented control
 * (⌘1 and ⌘2 from anywhere). ←/→ move between the tabs. The Board tab
 * counts the questions waiting on the user; the Chat tab gets a dot when
 * the orchestrator says something while the Board is showing. Elements
 * and callbacks in, controller out.
 */

import type { View } from './view-nav';

export interface ViewSwitchElements {
  root: HTMLElement;
  chat: HTMLButtonElement;
  board: HTMLButtonElement;
  /** The unread dot on Chat. */
  chatDot: HTMLElement;
  /** The needs-input count on Board. */
  boardBadge: HTMLElement;
}

export interface ViewSwitchState {
  view: View;
  /** No environment on screen: the switch hides. */
  hidden: boolean;
  /** Questions waiting on the user. */
  needs: number;
  /** The orchestrator said something the user has not seen. */
  unread: boolean;
}

export function initViewSwitch(els: ViewSwitchElements, pick: (view: View) => void) {
  const tabs: [View, HTMLButtonElement][] = [
    ['chat', els.chat],
    ['board', els.board],
  ];
  els.root.setAttribute('role', 'tablist');
  els.root.setAttribute('aria-label', 'Views');
  for (const [view, tab] of tabs) {
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', () => pick(view));
    tab.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const next = view === 'chat' ? 'board' : 'chat';
      pick(next);
      (next === 'chat' ? els.chat : els.board).focus();
    });
  }

  return {
    show(state: ViewSwitchState): void {
      els.root.classList.toggle('hidden', state.hidden);
      for (const [view, tab] of tabs) {
        const on = view === state.view;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
      }
      els.boardBadge.textContent = state.needs ? String(state.needs) : '';
      els.boardBadge.classList.toggle('hidden', !state.needs);
      els.board.setAttribute('aria-label', state.needs ? `Board, ${state.needs} waiting on you` : 'Board');
      els.chatDot.classList.toggle('hidden', !state.unread);
      els.chat.setAttribute('aria-label', state.unread ? 'Chat, new messages' : 'Chat');
    },
  };
}

export type ViewSwitch = ReturnType<typeof initViewSwitch>;
