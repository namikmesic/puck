/**
 * The sidebar roster: one row per agent (title tooltip with context size and
 * recency, running/unread status dot, a stop button for background turns),
 * with sub-agent chats nested under the conversation that spawned them.
 *
 * Renders at most once per animation frame — callers fire `render()` on
 * every event. All app state arrives through `RosterContext`, which is what
 * makes it jsdom-testable.
 */

import type { AgentInfo } from '../harness/bridge';
import { el } from './dom';
import { fmtTokens, relTime } from './format';
import type { Session } from './session-store';
import { button, STOP_ICON } from './util';

export interface RosterContext {
  listEl: HTMLUListElement;
  agents(): AgentInfo[];
  conversationOf(agentId: string): Session | undefined;
  childrenOf(conv: Session): Session[];
  /** Is this session the one on screen? (drives the `active` highlight) */
  isCurrent(session: Session): boolean;
  providerLabel(providerId: string): string;
  openConversation(agentId: string): void;
  openSession(sessionId: number): void;
  interrupt(turnId: string): void;
}

function sessionSnippet(session: Session): string {
  const parts = session.thread.querySelectorAll('.prose, .error-block');
  const last = parts.length ? (parts[parts.length - 1].textContent ?? '') : '';
  return last.split(/\s+/).join(' ').trim().slice(0, 120);
}

function statusDot(state: 'running' | 'done' | 'error' | 'ask'): HTMLElement {
  const dot = el('span', `recent-status ${state}`);
  dot.title =
    state === 'running'
      ? 'Agent working…'
      : state === 'ask'
        ? 'Waiting for your answer'
        : state === 'error'
          ? 'Finished with an error'
          : 'Finished';
  return dot;
}

export function initRoster(ctx: RosterContext) {
  let queued = false;

  /** Coalesced render: at most one DOM rebuild per animation frame. */
  function render(): void {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      renderNow();
    });
  }

  function renderNow(): void {
    ctx.listEl.textContent = '';
    for (const info of ctx.agents()) {
      const conv = ctx.conversationOf(info.id);
      const item = el('li', 'recent-item');
      const btn = button(
        'recent agent-row' + (conv && ctx.isCurrent(conv) ? ' active' : ''),
        info.name,
      );
      btn.title =
        ctx.providerLabel(info.provider) +
        (conv && conv.turns > 0
          ? ` · ctx ${fmtTokens(conv.usage)} · ${relTime(conv.lastActiveAt)}`
          : ' · no messages yet');
      btn.addEventListener('click', () => ctx.openConversation(info.id));
      item.appendChild(btn);
      const state = conv?.running ? 'running' : conv?.unread;
      if (state) item.appendChild(statusDot(state));
      if (conv?.running && conv.turnId) {
        // Background turns are stoppable from the roster, not just when open.
        const stopBtn = button('recent-stop');
        stopBtn.title = `Stop ${info.name}'s turn`;
        stopBtn.innerHTML = STOP_ICON;
        stopBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (conv.turnId) ctx.interrupt(conv.turnId);
        });
        item.appendChild(stopBtn);
      }
      ctx.listEl.appendChild(item);

      // Sub-agent chats, nested under the conversation that spawned them.
      if (!conv) continue;
      for (const child of ctx.childrenOf(conv)) {
        const childItem = el('li', 'recent-item child');
        const childBtn = button('recent' + (ctx.isCurrent(child) ? ' active' : ''), child.title);
        childBtn.title = sessionSnippet(child) || child.title;
        childBtn.addEventListener('click', () => ctx.openSession(child.id));
        childItem.appendChild(childBtn);
        const childState = child.running ? 'running' : child.unread;
        if (childState) childItem.appendChild(statusDot(childState));
        ctx.listEl.appendChild(childItem);
      }
    }
  }

  return { render, renderNow };
}

export type Roster = ReturnType<typeof initRoster>;
