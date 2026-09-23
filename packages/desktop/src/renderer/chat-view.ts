/**
 * The chat rendering layer: Slack-style message rows, streaming assistant
 * turns (markdown committer, tool cards, sub-agent links, ask cards), replay
 * of persisted logs, and the full-screen turn overlay.
 *
 * Pure presentation over a Session's live thread node. Everything stateful
 * it needs from the app — persistence, roster refresh, answer delivery,
 * child-session creation — arrives through `ChatViewContext`; this module
 * never touches renderer globals, which is what makes it jsdom-testable.
 */

import type { ConversationEntry } from '../harness/bridge';
import type { AskQuestion, HarnessEvent, TurnStats } from '../harness/types';
import { askCard, askReplayCard, setAskAnswered } from './ask-card';
import { el } from './dom';
import { dayLabel, fmtClock, fmtTime, fmtTokens } from './format';
import { renderMd } from './markdown';
import type { AgentThread, Session } from './session-store';
import { button, errText } from './util';

/** The streaming controller one assistant turn exposes to the turn loop. */
export interface AssistantTurn {
  setThinking(active: boolean, label?: string): void;
  appendText(delta: string, parentId?: string): void;
  showError(message: string): void;
  showAsk(askId: string, questions: AskQuestion[]): void;
  showAskReplay(questions: AskQuestion[], answers: Record<string, string> | null): void;
  startTool(
    toolId: string,
    tool: string,
    summary: string,
    input: string,
    parentId?: string,
    isAgent?: boolean,
    at?: number,
  ): void;
  endTool(toolId: string, ok: boolean, output: string, at?: number): void;
  finish(stats: TurnStats): void;
}

export interface ChatViewContext {
  /** Display label for the human author (persisted entries store 'user'). */
  userName: string;
  /** Scroll the live chat scroller (no-op when the session is off-screen). */
  scrollChat(force?: boolean): void;
  /** Deliver (or dismiss, with null) a mid-turn answer to the agent. */
  answerAsk(turnId: string, askId: string, answers: Record<string, string> | null): Promise<void>;
  toast(message: string): void;
  schedulePersist(session: Session): void;
  /** Roster-visible state changed (running/unread/title/membership). */
  rosterChanged(): void;
  /** Is this session the one on screen? (unread markers skip the current). */
  isCurrent(session: Session): boolean;
  openSession(id: number): void;
  /** Create a sub-agent chat session rooted under `parent` (session-domain). */
  spawnChild(parent: Session): Session;
  /** Drop `session`'s child chats (full-log rebuild re-creates them). */
  pruneChildren(session: Session): void;
  /** Full-screen turn overlay chrome. */
  overlay: {
    body: HTMLElement;
    crumb: HTMLElement;
    title: HTMLElement;
    stage: HTMLElement;
    backButton: HTMLElement;
  };
}

/** Long histories replay only their tail; the rest loads on demand. */
const REPLAY_WINDOW = 150;

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
  );
}

/**
 * Route one harness event to the turn that renders it — shared by the live
 * turn loop and history replay. Replay renders answered questions read-only
 * and skips unanswered ones (the app closed mid-question; they can't be
 * revived); live questions get the interactive card.
 */
export function applyEvent(turn: AssistantTurn, event: HarnessEvent, replay: boolean): void {
  switch (event.kind) {
    case 'thinking':
      turn.setThinking(event.active);
      break;
    case 'text-delta':
      turn.appendText(event.text, event.parentId);
      break;
    case 'tool-start':
      turn.startTool(
        event.toolId,
        event.tool,
        event.summary,
        event.input,
        event.parentId,
        event.agent,
        event.ts,
      );
      break;
    case 'tool-end':
      turn.endTool(event.toolId, event.ok, event.output, event.ts);
      break;
    case 'error':
      turn.showError(event.message);
      break;
    case 'ask':
      if (!replay) turn.showAsk(event.askId, event.questions);
      else if (event.answers !== undefined) turn.showAskReplay(event.questions, event.answers);
      break;
    case 'turn-end':
      turn.finish(event.stats);
      break;
  }
}

export function initChatView(ctx: ChatViewContext) {
  /* ----- Full-screen turn detail: the detail node is MOVED into the overlay
     and returned home on back, so live streaming keeps rendering either way. */
  let fullTurn: { detail: HTMLElement; home: HTMLElement } | null = null;
  let lastFullTrigger: HTMLElement | null = null;

  function openFullTurn(session: Session, detail: HTMLElement, title: string): void {
    closeFullTurn();
    fullTurn = { detail, home: detail.parentElement as HTMLElement };
    ctx.overlay.body.appendChild(detail);
    ctx.overlay.crumb.textContent = session.title;
    ctx.overlay.title.textContent = title;
    ctx.overlay.stage.classList.add('turn-full-open');
    ctx.overlay.backButton.focus();
  }

  function closeFullTurn(): void {
    if (!fullTurn) return;
    fullTurn.home.appendChild(fullTurn.detail);
    fullTurn = null;
    ctx.overlay.stage.classList.remove('turn-full-open');
    lastFullTrigger?.focus();
    lastFullTrigger = null;
  }

  /** Follow live output when the growing turn is the one open full screen. */
  function detailFollow(node: HTMLElement): void {
    if (fullTurn?.detail.contains(node)) {
      ctx.overlay.body.scrollTop = ctx.overlay.body.scrollHeight;
    }
  }

  /** Slack-style day separator, inserted when the calendar day changes. The
   *  last label lives in a dataset attribute — no DOM scan per message. */
  function maybeDayDivider(container: HTMLElement, ts = Date.now()): void {
    const label = dayLabel(ts);
    if (container.dataset.day === label) return;
    container.dataset.day = label;
    const divider = el('li', 'day-divider');
    divider.appendChild(el('span', 'day-chip', label));
    container.appendChild(divider);
  }

  /** One Slack-style message row: avatar gutter, author + time, content below. */
  function messageRow(
    kind: 'user' | 'agent',
    author: string,
    ts = Date.now(),
  ): { item: HTMLLIElement; body: HTMLElement } {
    const item = el('li', `msg-row ${kind}`);
    item.dataset.author = author;
    item.dataset.ts = String(ts);
    item.dataset.groupStart = String(ts); // the header's time never slides
    const main = el('div', 'row-main');
    const head = el('div', 'row-head');
    head.append(el('span', 'row-author', author), el('span', 'row-time', fmtTime(ts)));
    const body = el('div', 'row-body');
    main.append(head, body);
    item.append(el('span', `row-avatar ${kind}`, (author[0] ?? '?').toUpperCase()), main);
    return { item, body };
  }

  /** Keep a sub-agent chat's liveness fresh as its activity streams in. */
  function bumpAgent(child: Session): void {
    child.lastActiveAt = Date.now();
    if (!child.running) {
      child.running = true;
      ctx.rosterChanged();
    }
  }

  function addUserMessage(
    session: Session,
    text: string,
    author = ctx.userName,
    ts = Date.now(),
  ): void {
    // Slack-style grouping: rapid consecutive messages share one header —
    // capped at 15 minutes from the group's start (the sliding 5-minute
    // window alone never breaks), and never across midnight.
    const last = session.thread.lastElementChild as HTMLElement | null;
    const groupStart = Number(last?.dataset.groupStart ?? 0);
    if (
      last?.classList.contains('msg-row') &&
      last.dataset.author === author &&
      ts - Number(last.dataset.ts) < 300_000 &&
      ts - groupStart < 900_000 &&
      sameDay(ts, groupStart)
    ) {
      last.dataset.ts = String(ts);
      const grouped = el('div', 'row-body prose');
      grouped.innerHTML = renderMd(text);
      last.querySelector('.row-main')?.appendChild(grouped);
    } else {
      maybeDayDivider(session.thread, ts);
      const { item, body } = messageRow(author === ctx.userName ? 'user' : 'agent', author, ts);
      body.classList.add('prose');
      body.innerHTML = renderMd(text);
      session.thread.appendChild(item);
    }
    if (session.thread.isConnected) ctx.scrollChat(true);
  }

  /** Builds one assistant turn inside a session's thread (which may be off-screen). */
  function addAssistantTurn(session: Session, turnId: string, ts = Date.now()): AssistantTurn {
    // Only move the visible scroller when this session is the one on screen.
    const scrollToBottom = (force = false): void => {
      if (session.thread.isConnected) ctx.scrollChat(force);
    };
    maybeDayDivider(session.thread, ts);
    const { item, body: content } = messageRow('agent', session.title, ts);
    session.thread.appendChild(item);

    // Text-only turns are just messages. The first tool call reveals ONE dynamic
    // card; clicking it opens the turn's full detail with breadcrumbs back.
    const turnWork = el('div', 'turn-detail');
    const detailTitle = `Turn · ${fmtTime(ts)}`;
    let steps = 0;
    const turnCard = button('turn-card running hidden');
    turnCard.title = 'Open turn detail';
    const cardDot = el('span', 'turn-card-dot');
    const cardLabel = el('span', 'turn-card-label', 'Working…');
    const cardLatest = el('span', 'turn-card-latest', '');
    const cardExpand = el('span', 'turn-card-expand');
    cardExpand.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="m21 3-7 7" /><path d="m3 21 7-7" /></svg>';
    turnCard.append(cardDot, cardLabel, cardLatest, cardExpand);
    turnCard.addEventListener('click', () => {
      lastFullTrigger = turnCard;
      openFullTurn(session, turnWork, detailTitle);
    });
    item.querySelector('.row-main')?.append(turnCard, turnWork);

    const workAppend = (node: HTMLElement, stepLabel?: string): void => {
      turnWork.appendChild(node);
      if (stepLabel) {
        steps += 1;
        cardLabel.textContent = `Working · ${steps} step${steps === 1 ? '' : 's'}`;
        cardLatest.textContent = stepLabel;
      }
      if (turnCard.classList.contains('hidden')) {
        turnCard.classList.remove('hidden');
        scrollToBottom();
      }
      detailFollow(node);
    };

    let prose: HTMLElement | null = null;
    let proseRaw = '';
    let proseCommitted: HTMLElement | null = null;
    let proseTail: HTMLElement | null = null;
    let commitAt = 0;
    let flushQueued = false;

    // Re-parsing the whole reply per token is quadratic. Instead: text before
    // the last completed paragraph renders once into a "committed" node (only
    // when a new paragraph lands, and never inside an open code fence), and
    // each animation frame re-renders just the small trailing chunk.
    const fenceClosed = (s: string): boolean => ((s.match(/```/g) ?? []).length & 1) === 0;
    const flushProse = (): void => {
      flushQueued = false;
      if (!prose || !proseCommitted || !proseTail) return;
      const brk = proseRaw.lastIndexOf('\n\n');
      if (brk >= 0 && brk + 2 > commitAt && fenceClosed(proseRaw.slice(0, brk))) {
        commitAt = brk + 2;
        proseCommitted.innerHTML = renderMd(proseRaw.slice(0, commitAt));
      }
      proseTail.innerHTML = renderMd(proseRaw.slice(commitAt));
      scrollToBottom();
    };

    let thinking: HTMLElement | null = null;
    const tools = session.tools; // session-scoped: resumed sub-agents span turns
    const turnToolIds: string[] = []; // pruned when the turn settles (DOM refs!)
    const openAsks: HTMLElement[] = [];

    function closeAsks(): void {
      for (const card of openAsks.splice(0)) setAskAnswered(card, true);
    }

    return {
      setThinking(active: boolean, label = 'Thinking…') {
        if (active && !thinking) {
          thinking = el('div', 'thinking');
          thinking.append(
            el('span', 'thinking-dot'),
            el('span', 'thinking-dot'),
            el('span', 'thinking-dot'),
            el('span', 'thinking-label', label),
          );
          content.appendChild(thinking);
        } else if (!active && thinking) {
          thinking.remove();
          thinking = null;
        }
        scrollToBottom();
      },

      appendText(delta: string, parentId?: string) {
        // A sub-agent's text belongs in its own chat thread.
        if (parentId) {
          const agentThread = session.agents.get(parentId);
          if (agentThread) {
            agentThread.sawText = true;
            agentThread.childTurn.appendText(delta);
            bumpAgent(agentThread.child);
            return;
          }
        }
        this.setThinking(false);
        if (!prose) {
          prose = el('div', 'prose');
          proseCommitted = el('div', 'prose-part');
          proseTail = el('div', 'prose-part');
          prose.append(proseCommitted, proseTail);
          proseRaw = '';
          commitAt = 0;
          content.appendChild(prose);
        }
        proseRaw += delta;
        if (!flushQueued) {
          flushQueued = true;
          requestAnimationFrame(flushProse);
        }
      },

      showError(message: string) {
        this.setThinking(false);
        flushProse();
        closeAsks();
        // Repeated identical errors collapse into one block with a counter.
        const last = content.lastElementChild as HTMLElement | null;
        if (last?.classList.contains('error-block') && last.dataset.message === message) {
          const count = Number(last.dataset.count ?? 1) + 1;
          last.dataset.count = String(count);
          last.textContent = `${message} (×${count})`;
        } else {
          const block = el('div', 'error-block', message);
          block.dataset.message = message;
          content.appendChild(block);
        }
        scrollToBottom();
      },

      /** Renders the agent's mid-turn question(s); answers flow back over the bridge. */
      showAsk(askId: string, questions: AskQuestion[]) {
        this.setThinking(false);
        flushProse();
        prose = null; // text after the question starts a fresh block
        // The card owns selection/collection/re-arm (ask-card.ts); delivery
        // and the session-side bookkeeping live here.
        const card = askCard(questions, {
          submit: async (answers) => {
            try {
              await ctx.answerAsk(turnId, askId, answers);
            } catch (err) {
              ctx.toast(`Couldn't send the answer: ${errText(err)}`);
              throw err; // the card re-arms itself
            }
            const idx = openAsks.indexOf(card);
            if (idx !== -1) openAsks.splice(idx, 1);
            // Record the outcome so replayed history keeps the question + answer.
            for (const entry of session.log) {
              if (entry.kind !== 'turn') continue;
              const ev = entry.events.find((e) => e.kind === 'ask' && e.askId === askId);
              if (ev && ev.kind === 'ask') ev.answers = answers;
            }
            ctx.schedulePersist(session);
            if (answers) this.setThinking(true);
          },
        });
        content.appendChild(card);
        openAsks.push(card);
        scrollToBottom();
      },

      /** Read-only card for a question answered in a previous run. */
      showAskReplay(questions: AskQuestion[], answers: Record<string, string> | null) {
        flushProse();
        prose = null;
        content.appendChild(askReplayCard(questions, answers));
      },

      startTool(
        toolId: string,
        tool: string,
        summary: string,
        input: string,
        parentId?: string,
        isAgent?: boolean,
        at = Date.now(),
      ) {
        this.setThinking(false);

        // A sub-agent's own tool call: render it inside the agent's chat thread.
        if (parentId) {
          const agentThread = session.agents.get(parentId);
          if (agentThread) {
            agentThread.childTurn.startTool(toolId, tool, summary, input, undefined, undefined, at);
            bumpAgent(agentThread.child);
            return;
          }
          // Parent thread unknown — fall through and render a normal card.
        }

        flushProse();
        prose = null; // next text delta starts a fresh paragraph block

        if (isAgent) {
          // The sub-agent gets its own chat, rooted under this session; the
          // message here is just a live link to it.
          const child = ctx.spawnChild(session);
          addUserMessage(child, input || summary, session.title, ts); // the parent agent authored the task
          child.title = summary;
          const thread: AgentThread = {
            child,
            childTurn: addAssistantTurn(child, turnId),
            sawText: false,
          };
          session.agents.set(toolId, thread);

          const link = button('agent-link');
          link.append(
            el('span', 'tool-status running'),
            el('span', 'agent-chip', 'Sub-agent'),
            el('span', 'agent-link-title', summary),
            el('span', 'tool-stamp', fmtClock(at)),
            el('span', 'agent-link-open', 'Open chat →'),
          );
          link.addEventListener('click', () => ctx.openSession(child.id));
          workAppend(link, `Sub-agent · ${summary}`);
          tools.set(toolId, { card: link, startedAt: at });
          ctx.rosterChanged();
          return;
        }

        const card = el('details', 'tool');
        const head = el('summary', 'tool-head');
        head.append(
          el('span', 'tool-status running'),
          el('span', 'tool-name', tool),
          el('span', 'tool-summary', summary),
          el('span', 'tool-stamp', fmtClock(at)),
          el('span', 'tool-time', ''),
        );
        card.append(head);
        if (input) card.append(el('pre', 'tool-input', input));
        workAppend(card, summary ? `${tool} · ${summary}` : tool);
        tools.set(toolId, { card, startedAt: at });
        turnToolIds.push(toolId);
      },

      endTool(toolId: string, ok: boolean, output: string, at = Date.now()) {
        const entry = tools.get(toolId);
        if (!entry) return;
        const { card, startedAt } = entry;
        const status = card.querySelector('.tool-status') as HTMLElement;
        status.className = `tool-status ${ok ? 'ok' : 'err'}`;
        status.textContent = ok ? '✓' : '✕';
        if (card.classList.contains('agent-link')) {
          // Sub-agent finished: land its report in its chat and settle state.
          const agentThread = session.agents.get(toolId);
          if (agentThread) {
            if (!agentThread.sawText && output) agentThread.childTurn.appendText(output);
            agentThread.child.running = false;
            if (!ctx.isCurrent(agentThread.child) && !agentThread.child.unread) {
              agentThread.child.unread = ok ? 'done' : 'error';
            }
            ctx.rosterChanged();
          }
          detailFollow(card);
          return;
        }
        // Claude delivers tool_use + result almost together, so sub-0.1s
        // receipt gaps are noise — show duration only when it means something.
        const secs = Math.max(0, at - startedAt) / 1000;
        const parts: string[] = [];
        if (secs >= 0.1) parts.push(`${secs.toFixed(1)}s`);
        if (!ok) parts.push('failed');
        (card.querySelector('.tool-time') as HTMLElement).textContent = parts.join(' · ');
        card.appendChild(el('pre', 'tool-output', output));
        detailFollow(card);
      },

      finish(stats: TurnStats) {
        this.setThinking(false);
        flushProse();
        closeAsks();
        // Plain tool cards can't receive events after turn-end — release the
        // map entries (agent-link ids stay: resumed sub-agents span turns).
        for (const toolId of turnToolIds) tools.delete(toolId);
        // Text-only turns stay plain; tool turns settle their dynamic card.
        if (steps > 0) {
          const seconds = (stats.durationMs / 1000).toFixed(1);
          const cost = stats.costUsd !== undefined ? ` · $${stats.costUsd.toFixed(4)}` : '';
          workAppend(
            el(
              'div',
              'turn-stats',
              `${fmtTokens(stats.inputTokens)} in · ` +
                `${fmtTokens(stats.outputTokens)} out · ${seconds}s${cost}`,
            ),
          );
          turnCard.classList.remove('running');
          turnCard.classList.add('done');
          cardLabel.textContent = `${steps} step${steps === 1 ? '' : 's'} · ${seconds}s${cost}`;
          cardLatest.textContent = '';
        }
        scrollToBottom();
      },
    };
  }

  /** Render a stored history lazily: only when its conversation first opens. */
  function hydrate(session: Session): void {
    if (!session.pendingLog) return;
    const log = session.pendingLog;
    session.pendingLog = undefined;
    replayLog(session, log);
  }

  /** Rebuild a conversation's UI (and its sub-agent chats) from stored entries. */
  function replayLog(session: Session, log: ConversationEntry[], full = false): void {
    session.log = log;
    const entries = full || log.length <= REPLAY_WINDOW ? log : log.slice(-REPLAY_WINDOW);
    if (entries.length < log.length) {
      const item = el('li', 'load-earlier');
      const btn = button('btn-ghost', `Show ${log.length - entries.length} earlier messages`);
      btn.addEventListener('click', () => {
        // Rebuild the whole thread from the full log through the same path,
        // detached so the replay doesn't force a layout per message.
        const host = session.thread.parentElement;
        session.thread.remove();
        session.thread.textContent = '';
        delete session.thread.dataset.day;
        session.tools.clear();
        session.agents.clear();
        ctx.pruneChildren(session);
        replayLog(session, log, true);
        host?.appendChild(session.thread);
        ctx.rosterChanged();
        ctx.scrollChat(true);
      });
      item.appendChild(btn);
      session.thread.appendChild(item);
    }
    for (const entry of entries) {
      if (entry.kind === 'user') {
        // Persisted user entries are always the human (children never persist).
        addUserMessage(session, entry.text, ctx.userName, entry.ts);
        continue;
      }
      const turn = addAssistantTurn(session, 'replay', entry.ts);
      for (const event of entry.events) applyEvent(turn, event, true);
      turn.setThinking(false);
    }
  }

  return {
    addUserMessage,
    addAssistantTurn,
    hydrate,
    replayLog,
    openFullTurn,
    closeFullTurn,
    detailFollow,
  };
}

export type ChatView = ReturnType<typeof initChatView>;
