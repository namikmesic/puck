// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, ConversationData } from '../../src/harness/bridge';
import { createSessionStore } from '../../src/renderer/session-store';

function info(id: string, name: string): AgentInfo {
  return {
    id,
    name,
    provider: 'claude-code',
    model: 'auto',
    systemPrompt: '',
    effort: 'auto',
    options: {},
    advanced: '',
    active: false,
  };
}

function makeStore() {
  const interrupt = vi.fn();
  const save = vi.fn<(agentId: string, data: ConversationData) => Promise<undefined>>(
    async () => undefined,
  );
  const store = createSessionStore({
    interrupt,
    save,
    onSaveError: () => undefined,
    currentDraft: () => 'draft-text',
  });
  return { store, interrupt, save };
}

describe('session store', () => {
  it('conversationFor creates once, retitles on every call', () => {
    const { store } = makeStore();
    const a = store.conversationFor(info('a1', 'Claude'));
    const again = store.conversationFor(info('a1', 'Renamed'));
    expect(again).toBe(a);
    expect(a.title).toBe('Renamed');
  });

  it('spawnChild shares the parent tool registries and registers as a child', () => {
    const { store } = makeStore();
    const parent = store.conversationFor(info('a1', 'Claude'));
    const child = store.spawnChild(parent);
    expect(child.tools).toBe(parent.tools);
    expect(child.parentSessionId).toBe(parent.id);
    expect(store.childrenOf(parent)).toEqual([child]);
  });

  it('removeAgent interrupts the running turn and tears down the family', () => {
    const { store, interrupt } = makeStore();
    const conv = store.conversationFor(info('a1', 'Claude'));
    conv.turnId = 'turn-9';
    const child = store.spawnChild(conv);
    const dead = store.removeAgent('a1');
    expect(dead).toBe(conv);
    expect(interrupt).toHaveBeenCalledWith('turn-9');
    expect(store.conversations.has('a1')).toBe(false);
    expect(store.sessions.includes(child)).toBe(false);
    expect(store.removeAgent('missing')).toBeNull();
  });

  it('syncAgentNames retitles only changed conversations', () => {
    const { store } = makeStore();
    const a = store.conversationFor(info('a1', 'Claude'));
    store.conversationFor(info('a2', 'Codex'));
    const renamed = store.syncAgentNames([info('a1', 'Claude Prime'), info('a2', 'Codex')]);
    expect(renamed).toEqual([a]);
    expect(a.title).toBe('Claude Prime');
  });

  describe('persistence', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('persist snapshots the mounted draft and ships the v1 payload', () => {
      const { store, save } = makeStore();
      const conv = store.conversationFor(info('a1', 'Claude'));
      conv.usage = 500;
      conv.turns = 2;
      store.setMounted(conv);
      store.persist(conv);
      expect(save).toHaveBeenCalledTimes(1);
      const [agentId, data] = save.mock.calls[0];
      expect(agentId).toBe('a1');
      expect(data.v).toBe(1);
      expect(data.lastTurnTokens).toBe(500);
      expect(data.draft).toBe('draft-text');
    });

    it('schedulePersist debounces to one save per conversation', async () => {
      const { store, save } = makeStore();
      const conv = store.conversationFor(info('a1', 'Claude'));
      store.schedulePersist(conv);
      store.schedulePersist(conv);
      store.schedulePersist(conv);
      await vi.advanceTimersByTimeAsync(2100);
      expect(save).toHaveBeenCalledTimes(1);
    });

    it('never persists child sessions (they have no agentId)', () => {
      const { store, save } = makeStore();
      const child = store.spawnChild(store.conversationFor(info('a1', 'Claude')));
      store.persist(child);
      store.schedulePersist(child);
      expect(save).not.toHaveBeenCalled();
    });
  });
});
