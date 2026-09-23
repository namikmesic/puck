/**
 * The session model behind the chat UI.
 *
 * Slack-style: each configured agent has ONE long-lived conversation. Every
 * conversation owns a LIVE detached thread node — turns keep streaming into
 * it while other conversations are on screen; mounting just swaps which
 * thread is attached to the chat scroller. Sub-agent chats are child
 * sessions nested under the conversation that spawned them.
 *
 * This module owns the collections and the domain operations on them
 * (spawning children, agent-removal teardown, rename sync, persistence);
 * presentation — mounting, rendering, scrolling — stays with the caller.
 */

import type { AgentInfo, ConversationData, ConversationEntry } from '../harness/bridge';
import { el } from './dom';
import type { AssistantTurn } from './chat-view';

export interface Session {
  /** Set on agent conversations: which configured agent this chat belongs to. */
  agentId?: string;
  /** Structured history — the persisted source of truth for this chat. */
  log: ConversationEntry[];
  id: number;
  title: string;
  thread: HTMLOListElement;
  usage: number;
  turns: number;
  createdAt: number;
  lastActiveAt: number;
  running: boolean;
  /** In-flight turn id, for routing interrupt / question answers. */
  turnId: string | null;
  /** Something happened while this session was in the background. */
  unread: 'done' | 'error' | 'ask' | null;
  /** Unrendered history — replayed lazily on first open (boot stays fast). */
  pendingLog?: ConversationEntry[];
  /** Composer draft, private to this conversation. */
  draft?: string;
  /** Scroll state, restored when the conversation is remounted. */
  scrollPos?: number;
  stick?: boolean;
  /**
   * Tool cards across ALL turns in this session, so a sub-agent resumed in a
   * later turn (SendMessage) streams into its original card.
   */
  tools: Map<string, ToolCard>;
  /** Set on sub-agent chats: the session this agent was spawned from. */
  parentSessionId?: number;
  /** Sub-agent chats spawned from this session, keyed by their Task toolId. */
  agents: Map<string, AgentThread>;
}

export interface ToolCard {
  card: HTMLElement;
  startedAt: number;
}

export interface AgentThread {
  child: Session;
  childTurn: AssistantTurn;
  /** True once the sub-agent's own text streamed in (avoids double reports). */
  sawText: boolean;
}

export interface SessionStoreContext {
  /** Interrupt an in-flight turn (agent deletion kills its conversation). */
  interrupt(turnId: string): void;
  /** Persist one conversation; absent bridge = resolved no-op. */
  save(agentId: string, data: ConversationData): Promise<void>;
  onSaveError(session: Session, err: Error): void;
  /** The mounted conversation's live composer text, for draft capture. */
  currentDraft(): string;
}

export function createSessionStore(ctx: SessionStoreContext) {
  /** Sub-agent chats (children). Agent conversations live in `conversations`. */
  const sessions: Session[] = [];
  const conversations = new Map<string, Session>();
  let nextSessionId = 1;
  /** Which session the composer/scroller is showing (may be a child). */
  let mounted: Session | null = null;

  function freshSession(): Session {
    const now = Date.now();
    return {
      id: nextSessionId++,
      title: 'Untitled session',
      thread: el('ol', 'thread'),
      usage: 0,
      turns: 0,
      createdAt: now,
      lastActiveAt: now,
      running: false,
      turnId: null,
      unread: null,
      tools: new Map(),
      agents: new Map(),
      log: [],
    };
  }

  /** The one permanent conversation for a configured agent. */
  function conversationFor(info: AgentInfo): Session {
    let conv = conversations.get(info.id);
    if (!conv) {
      conv = freshSession();
      conv.agentId = info.id;
      conversations.set(info.id, conv);
    }
    conv.title = info.name; // follows renames in Settings
    return conv;
  }

  /**
   * A sub-agent gets its own chat rooted under its parent, sharing the
   * parent's tool registries so tool-ends resolve across threads.
   */
  function spawnChild(parent: Session): Session {
    const child = freshSession();
    child.parentSessionId = parent.id;
    child.turns = 1;
    child.running = true;
    child.tools = parent.tools;
    sessions.push(child);
    return child;
  }

  function childrenOf(parent: Session): Session[] {
    return sessions.filter((c) => c.parentSessionId === parent.id);
  }

  function dropChildren(parent: Session): void {
    for (const child of childrenOf(parent)) {
      sessions.splice(sessions.indexOf(child), 1);
    }
  }

  /**
   * An agent was deleted: its conversation dies with it — stop its turn,
   * drop it and its sub-agent chats. Returns the dead conversation when the
   * caller may need to move the UI off it (presentation's job).
   */
  function removeAgent(agentId: string): Session | null {
    const conv = conversations.get(agentId);
    if (!conv) return null;
    if (conv.turnId) ctx.interrupt(conv.turnId);
    conversations.delete(agentId);
    dropChildren(conv);
    return conv;
  }

  /**
   * Agents refreshed from Settings: retitle live conversations so renames
   * show up everywhere (roster, chat head) without remounting. Returns the
   * renamed sessions so the caller can refresh any mounted chrome.
   */
  function syncAgentNames(infos: AgentInfo[]): Session[] {
    const renamed: Session[] = [];
    for (const info of infos) {
      const conv = conversations.get(info.id);
      if (conv && conv.title !== info.name) {
        conv.title = info.name;
        renamed.push(conv);
      }
    }
    return renamed;
  }

  /** Persist a conversation's structured log; failures surface via ctx. */
  function persist(session: Session): void {
    if (!session.agentId) return;
    if (session === mounted) session.draft = ctx.currentDraft();
    void ctx
      .save(session.agentId, {
        v: 1,
        log: session.log,
        lastTurnTokens: session.usage,
        lastActiveAt: session.lastActiveAt,
        turns: session.turns,
        draft: session.draft ?? '',
      })
      .catch((err: Error) => ctx.onSaveError(session, err));
  }

  const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Debounced mid-turn save so a crash loses seconds, not the whole exchange. */
  function schedulePersist(session: Session): void {
    if (!session.agentId) return;
    const key = session.agentId;
    const existing = persistTimers.get(key);
    if (existing) return;
    persistTimers.set(
      key,
      setTimeout(() => {
        persistTimers.delete(key);
        persist(session);
      }, 2000),
    );
  }

  return {
    sessions,
    conversations,
    freshSession,
    conversationFor,
    spawnChild,
    childrenOf,
    dropChildren,
    removeAgent,
    syncAgentNames,
    persist,
    schedulePersist,
    setMounted(session: Session | null): void {
      mounted = session;
    },
    getMounted(): Session | null {
      return mounted;
    },
    findSession(id: number): Session | undefined {
      return sessions.find((s) => s.id === id);
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
