/**
 * Session threads for the environment on screen: one live thread node per
 * session id (the orchestrator, and each worker), rendered through
 * chat-view.
 *
 * - A thread loads when it is first mounted: the newest page of
 *   `session.history`, then "Show earlier" pages back through older ones.
 * - Live events apply as they arrive. While a page loads they wait in the
 *   node; the page reports the last event seq it reflects (`head`), so
 *   the waiting events at or below it are dropped and the rest apply on
 *   top. When an older daemon omits `head`, that seq is the store cursor
 *   from before the request, so events that land during the request stay.
 *   A failed load keeps them and offers Retry: nothing that arrived
 *   is lost, and nothing is shown twice.
 * - A turn still running when its page loaded keeps streaming into the
 *   same row; its open questions get live cards.
 * - Sub-agent chats open in place of their parent, with Back.
 * - Composer drafts are per environment and session, in localStorage
 *   (`puck.draft.<envId>.<sessionId>`), a per-machine convenience.
 *
 * Everything the app owns (history reads, answers, the store) arrives
 * through the context. Context in, controller out.
 */

import type { ProviderCapabilities } from '../harness/bridge';
import type { DaemonEvent, OpResult, SessionSummary } from '../harness/daemon-protocol';
import type { EntryAuthor, TranscriptEntry } from '../harness/transcript';
import type { HarnessEvent } from '../harness/types';
import { setAskAnswered } from './ask-card';
import { applyEvent, initChatView, type AssistantTurn, type Session } from './chat-view';
import { el } from './dom';
import type { InstanceStore } from './instance-store';
import { button, errText } from './util';

type HistoryPage = OpResult<'session.history'>;

export interface SessionViewContext {
  store: InstanceStore;
  history(sessionId: string, before?: number): Promise<HistoryPage>;
  answerAsk(sessionId: string, askId: string, answers: Record<string, string> | null): Promise<void>;
  /** The signed-in user's display name (their messages). */
  userName(): string;
  /** The orchestrator's agent name, for its follow-ups in worker threads. */
  orchestratorName(): string;
  capabilities?(harness: string): ProviderCapabilities | undefined;
  openRef?(ref: string): void;
  /** A sub-agent chat opened (its title) or closed (null): the host shows Back. */
  onChild?(title: string | null): void;
  toast(message: string): void;
  overlay: {
    body: HTMLElement;
    crumb: HTMLElement;
    title: HTMLElement;
    stage: HTMLElement;
    backButton: HTMLElement;
  };
  /** Draft storage; absent or throwing storage just forgets drafts. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

interface ThreadNode {
  sessionId: string;
  session: Session;
  state: 'idle' | 'loading' | 'loaded' | 'failed';
  /** Live events that arrived while the page loaded (or after it failed). */
  waiting: { seq: number; ev: DaemonEvent }[];
  turns: Map<string, AssistantTurn>;
  /** Index of the oldest rendered entry (the next "Show earlier" ends there). */
  firstIndex: number;
  hasMore: boolean;
  status: HTMLLIElement | null;
  earlier: HTMLLIElement | null;
}

function freshSession(id: number, title: string): Session {
  const thread = el('ol', 'thread');
  return {
    id,
    title,
    thread,
    usage: 0,
    turns: 0,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    running: false,
    turnId: null,
    unread: null,
    tools: new Map(),
    agents: new Map(),
  };
}

const hasTurnEnd = (events: HarnessEvent[]): boolean => events.some((e) => e.kind === 'turn-end');

export function initSessionView(ctx: SessionViewContext) {
  const { store } = ctx;
  const nodes = new Map<string, ThreadNode>();
  /** Sub-agent chats by their numeric id, with the node they belong to. */
  const children = new Map<number, { session: Session; parent: ThreadNode }>();
  const turnSession = new Map<string, string>();
  let nextId = 1;
  let gen = 0;
  let scroller: HTMLElement | null = null;
  let mounted: ThreadNode | null = null;
  let mountedChild: Session | null = null;
  let stick = true;

  function onScroll(): void {
    if (scroller) stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
  }

  function scrollChat(force = false): void {
    if (!scroller || (!force && !stick)) return;
    scroller.scrollTop = scroller.scrollHeight;
  }

  function summary(sessionId: string): SessionSummary | undefined {
    return store.session(sessionId);
  }

  function titleOf(sessionId: string): string {
    return summary(sessionId)?.agent ?? 'Agent';
  }

  const chat = initChatView({
    get userName() {
      return ctx.userName();
    },
    scrollChat,
    answerAsk: async (turnId, askId, answers) => {
      const sessionId = turnSession.get(turnId) ?? store.ask(askId)?.sessionId;
      if (!sessionId) throw new Error('That question is no longer open.');
      await ctx.answerAsk(sessionId, askId, answers);
    },
    toast: ctx.toast,
    rosterChanged: () => undefined,
    isCurrent: (session) => session === mountedChild || session === mounted?.session,
    openSession: (id) => openChild(id),
    spawnChild: (parent) => {
      const session = freshSession(nextId++, 'Sub-agent');
      session.parentSessionId = parent.id;
      const owner = [...nodes.values()].find((n) => n.session === parent) ?? children.get(parent.id)?.parent;
      if (owner) children.set(session.id, { session, parent: owner });
      return session;
    },
    capabilities: (session) => {
      const owner = [...nodes.values()].find((n) => n.session === session) ?? children.get(session.id)?.parent;
      const harness = owner ? summary(owner.sessionId)?.harness : undefined;
      return harness ? ctx.capabilities?.(harness) : undefined;
    },
    pruneChildren: () => undefined,
    openRef: ctx.openRef,
    overlay: ctx.overlay,
  });

  function nodeFor(sessionId: string): ThreadNode {
    let node = nodes.get(sessionId);
    if (!node) {
      node = {
        sessionId,
        session: freshSession(nextId++, titleOf(sessionId)),
        state: 'idle',
        waiting: [],
        turns: new Map(),
        firstIndex: 0,
        hasMore: false,
        status: null,
        earlier: null,
      };
      node.session.thread.dataset.session = sessionId;
      nodes.set(sessionId, node);
    }
    return node;
  }

  function authorOf(author: EntryAuthor): { name: string; kind: 'user' | 'agent' } {
    if (author === 'user') return { name: ctx.userName(), kind: 'user' };
    if (author === 'orchestrator') return { name: ctx.orchestratorName(), kind: 'agent' };
    return { name: 'Puck', kind: 'agent' };
  }

  function setStatus(node: ThreadNode, text: string | null, retry = false): void {
    node.status?.remove();
    node.status = null;
    if (text === null) return;
    const row = el('li', `thread-status${retry ? ' failed' : ''}`);
    row.appendChild(el('span', 'thread-status-text', text));
    if (retry) {
      const again = button('btn-ghost', 'Retry');
      again.addEventListener('click', () => void load(node));
      row.appendChild(again);
    }
    node.status = row;
    node.session.thread.appendChild(row);
  }

  /** Render one history entry into `session`; unfinished turns stay live in `turns`. */
  function renderEntry(session: Session, entry: TranscriptEntry, sessionId: string, turns: Map<string, AssistantTurn> | null): void {
    if (entry.kind === 'user') {
      const who = authorOf(entry.author);
      chat.addUserMessage(session, entry.text, who.name, entry.ts, who.kind);
      return;
    }
    if (entry.kind === 'notice') {
      chat.addNotice(session, entry.notices, entry.ts);
      return;
    }
    turnSession.set(entry.turnId, sessionId);
    const turn = chat.addAssistantTurn(session, entry.turnId, entry.ts);
    for (const event of entry.events) {
      if (event.kind === 'ask' && store.ask(event.askId)) turn.showAsk(event.askId, event.questions);
      else applyEvent(turn, event, true);
    }
    // A turn the page caught mid-stream keeps taking the events after it.
    if (turns && !hasTurnEnd(entry.events)) turns.set(entry.turnId, turn);
    turn.setThinking(turns !== null && !!store.inflight(entry.turnId));
  }

  function applyLive(node: ThreadNode, ev: DaemonEvent): void {
    const { session } = node;
    switch (ev.kind) {
      case 'turn.user': {
        const who = authorOf(ev.entry.author);
        chat.addUserMessage(session, ev.entry.text, who.name, ev.entry.ts, who.kind);
        return;
      }
      case 'turn.notice':
        chat.addNotice(session, ev.entry.notices, ev.entry.ts);
        return;
      case 'turn.start': {
        turnSession.set(ev.turnId, node.sessionId);
        const turn = chat.addAssistantTurn(session, ev.turnId);
        turn.setThinking(true);
        node.turns.set(ev.turnId, turn);
        return;
      }
      case 'turn.event': {
        const turn = node.turns.get(ev.turnId);
        if (!turn) return;
        applyEvent(turn, ev.event, false);
        if (ev.event.kind === 'turn-end') node.turns.delete(ev.turnId);
        return;
      }
      case 'turn.end': {
        const turn = node.turns.get(ev.turnId);
        if (turn) {
          turn.finish(ev.stats);
          node.turns.delete(ev.turnId);
        }
        return;
      }
      case 'ask.closed': {
        const card = session.thread.querySelector<HTMLElement>(`[data-ask-id="${CSS.escape(ev.askId)}"]`);
        if (card) setAskAnswered(card, true);
        return;
      }
      default:
        return;
    }
  }

  function earlierRow(node: ThreadNode): void {
    node.earlier?.remove();
    node.earlier = null;
    if (!node.hasMore) return;
    const row = el('li', 'load-earlier');
    const btn = button('btn-ghost', 'Show earlier');
    btn.addEventListener('click', () => void loadEarlier(node, btn));
    row.appendChild(btn);
    node.earlier = row;
    node.session.thread.insertBefore(row, node.session.thread.firstChild);
  }

  async function load(node: ThreadNode): Promise<void> {
    if (node.state === 'loading' || node.state === 'loaded') return;
    const mine = gen;
    const cursorBefore = store.cursor();
    node.state = 'loading';
    setStatus(node, 'Loading the conversation…');
    let page: HistoryPage;
    try {
      page = await ctx.history(node.sessionId);
    } catch (err) {
      if (mine !== gen) return;
      node.state = 'failed';
      setStatus(node, `Couldn't load this conversation: ${errText(err)}`, true);
      return;
    }
    if (mine !== gen) return;
    setStatus(node, null);
    const { session } = node;
    session.thread.textContent = '';
    delete session.thread.dataset.day;
    session.tools.clear();
    session.agents.clear();
    node.turns.clear();
    for (const entry of page.entries) renderEntry(session, entry, node.sessionId, node.turns);
    node.firstIndex = Math.max(0, page.total - page.entries.length);
    node.hasMore = page.hasMore;
    earlierRow(node);
    // Without a head (an older daemon), only what the store already had before the request is in the page.
    const head = page.head ?? cursorBefore ?? -1;
    const waiting = node.waiting.splice(0);
    node.state = 'loaded';
    for (const w of waiting) if (w.seq > head) applyLive(node, w.ev);
    if (mounted === node) scrollChat(true);
  }

  async function loadEarlier(node: ThreadNode, btn: HTMLButtonElement): Promise<void> {
    const mine = gen;
    btn.disabled = true;
    try {
      const page = await ctx.history(node.sessionId, node.firstIndex);
      if (mine !== gen) return;
      const temp = freshSession(nextId++, node.session.title);
      for (const entry of page.entries) renderEntry(temp, entry, node.sessionId, null);
      const thread = node.session.thread;
      const anchor = node.earlier?.nextSibling ?? thread.firstChild;
      const keep = scroller && mounted === node ? scroller.scrollHeight - scroller.scrollTop : null;
      for (const child of [...temp.thread.children]) thread.insertBefore(child, anchor);
      node.firstIndex = Math.max(0, node.firstIndex - page.entries.length);
      node.hasMore = page.hasMore && node.firstIndex > 0;
      earlierRow(node);
      if (scroller && keep !== null) scroller.scrollTop = scroller.scrollHeight - keep;
    } catch (err) {
      btn.disabled = false;
      ctx.toast(`Couldn't load earlier messages: ${errText(err)}`);
    }
  }

  let attached: HTMLElement | null = null;

  function attach(thread: HTMLElement): void {
    if (!scroller) return;
    // A thread shown elsewhere before leaves it, so its events never scroll this one.
    if (attached && attached !== thread) attached.remove();
    attached = thread;
    scroller.textContent = '';
    scroller.appendChild(thread);
    stick = true;
    scrollChat(true);
  }

  function openChild(id: number): void {
    const child = children.get(id);
    if (!child || !scroller) return;
    mountedChild = child.session;
    attach(child.session.thread);
    ctx.onChild?.(child.session.title);
  }

  function draftKey(sessionId: string): string | null {
    const envId = store.envId();
    return envId ? `puck.draft.${envId}.${sessionId}` : null;
  }

  return {
    /** Show a session's thread in `host` (loading it the first time). */
    mount(sessionId: string, host: HTMLElement): void {
      if (scroller !== host) {
        scroller?.removeEventListener('scroll', onScroll);
        scroller = host;
        host.addEventListener('scroll', onScroll);
      }
      const node = nodeFor(sessionId);
      mounted = node;
      mountedChild = null;
      ctx.onChild?.(null);
      attach(node.session.thread);
      if (node.state === 'idle' || node.state === 'failed') void load(node);
    },
    /** Back from a sub-agent chat to its parent thread. */
    closeChild(): boolean {
      if (!mountedChild || !mounted) return false;
      mountedChild = null;
      attach(mounted.session.thread);
      ctx.onChild?.(null);
      return true;
    },
    mountedSession: (): string | null => mounted?.sessionId ?? null,
    /** A daemon event, in seq order (the store already applied it). */
    apply(seq: number, ev: DaemonEvent): void {
      if (ev.kind === 'session.upsert') {
        const node = nodes.get(ev.session.id);
        if (node) node.session.title = ev.session.agent;
        return;
      }
      if (!('sessionId' in ev)) return;
      const node = nodes.get(ev.sessionId);
      if (!node) return;
      if (node.state === 'loaded') applyLive(node, ev);
      else if (node.state !== 'idle') node.waiting.push({ seq, ev });
    },
    /**
     * Another environment, or a resync: every thread reloads when next shown.
     * Returns the session that was on screen, for the caller to mount again.
     */
    reset(): string | null {
      gen++;
      chat.closeFullTurn();
      const was = mounted?.sessionId ?? null;
      nodes.clear();
      children.clear();
      turnSession.clear();
      mounted = null;
      mountedChild = null;
      if (scroller) scroller.textContent = '';
      return was;
    },
    closeFullTurn: (): void => chat.closeFullTurn(),
    draft(sessionId: string): string {
      const key = draftKey(sessionId);
      if (!key) return '';
      try {
        return ctx.storage?.getItem(key) ?? '';
      } catch {
        return '';
      }
    },
    saveDraft(sessionId: string, text: string): void {
      const key = draftKey(sessionId);
      if (!key) return;
      try {
        if (text) ctx.storage?.setItem(key, text);
        else ctx.storage?.removeItem(key);
      } catch {
        /* drafts are a convenience */
      }
    },
  };
}

export type SessionView = ReturnType<typeof initSessionView>;
