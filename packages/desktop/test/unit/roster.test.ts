// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '../../src/harness/bridge';
import { initRoster } from '../../src/renderer/roster';
import type { Session } from '../../src/renderer/session-store';

const frame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    id: 1,
    title: 'Coder',
    thread: document.createElement('ol'),
    running: false,
    unread: null,
    turnId: null,
    turns: 3,
    usage: 12_000,
    lastActiveAt: Date.now(),
    ...over,
  } as Session;
}

const agents = [{ id: 'a1', name: 'Coder', provider: 'codex' }] as AgentInfo[];

function mount(over: Partial<Parameters<typeof initRoster>[0]> = {}) {
  const listEl = document.createElement('ul');
  const ctx = {
    listEl,
    agents: () => agents,
    conversationOf: () => undefined as Session | undefined,
    childrenOf: () => [] as Session[],
    isCurrent: () => false,
    providerLabel: (id: string) => `label:${id}`,
    openConversation: vi.fn(),
    openSession: vi.fn(),
    interrupt: vi.fn(),
    ...over,
  };
  return { roster: initRoster(ctx), listEl, ctx };
}

describe('roster', () => {
  it('renders one row per agent; empty conversations read "no messages yet"', () => {
    const { roster, listEl, ctx } = mount();
    roster.renderNow();
    const btn = listEl.querySelector('.recent.agent-row') as HTMLButtonElement;
    expect(btn.textContent).toBe('Coder');
    expect(btn.title).toBe('label:codex · no messages yet');
    btn.click();
    expect(ctx.openConversation).toHaveBeenCalledWith('a1');
  });

  it('shows context size and recency for conversations with turns, and the active highlight', () => {
    const conv = fakeSession();
    const { roster, listEl } = mount({
      conversationOf: () => conv,
      isCurrent: (s: Session) => s === conv,
    });
    roster.renderNow();
    const btn = listEl.querySelector('.recent.agent-row') as HTMLButtonElement;
    expect(btn.classList.contains('active')).toBe(true);
    expect(btn.title).toContain('ctx 12k');
  });

  it('running turns get a status dot and a stop button wired to interrupt', () => {
    const conv = fakeSession({ running: true, turnId: 'ipc-7' });
    const { roster, listEl, ctx } = mount({ conversationOf: () => conv });
    roster.renderNow();
    expect(listEl.querySelector('.recent-status.running')).toBeTruthy();
    (listEl.querySelector('.recent-stop') as HTMLButtonElement).click();
    expect(ctx.interrupt).toHaveBeenCalledWith('ipc-7');
  });

  it('nests sub-agent chats under their parent with unread dots', () => {
    const conv = fakeSession();
    const child = fakeSession({ id: 2, title: 'Sub task', unread: 'done' });
    const { roster, listEl, ctx } = mount({
      conversationOf: () => conv,
      childrenOf: () => [child],
    });
    roster.renderNow();
    const childItem = listEl.querySelector('.recent-item.child') as HTMLElement;
    expect(childItem.querySelector('.recent')?.textContent).toBe('Sub task');
    expect(childItem.querySelector('.recent-status.done')).toBeTruthy();
    (childItem.querySelector('.recent') as HTMLButtonElement).click();
    expect(ctx.openSession).toHaveBeenCalledWith(2);
  });

  it('render() coalesces bursts into one rebuild per frame', async () => {
    const agentsSpy = vi.fn(() => agents);
    const { roster } = mount({ agents: agentsSpy });
    roster.render();
    roster.render();
    roster.render();
    expect(agentsSpy).not.toHaveBeenCalled(); // nothing until the frame fires
    await frame();
    expect(agentsSpy).toHaveBeenCalledTimes(1);
  });
});
