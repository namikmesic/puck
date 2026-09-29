/**
 * The chat rendering layer: Slack-style message rows, streaming assistant
 * turns (markdown committer, tool cards, sub-agent links, ask cards), Puck
 * notice rows, and the full-screen turn overlay. `W-n` references in
 * messages and notices render as chips that open the item. A turn that
 * used tools shows one quiet step card above its reply ("4 steps · 38s");
 * the card opens the steps full screen.
 *
 * Pure presentation over a Session's live thread node. Everything stateful
 * it needs from the app — answer delivery, child-session creation — arrives
 * through `ChatViewContext`; the environment's daemon keeps the transcript.
 * This module never touches renderer globals, which is what makes it
 * jsdom-testable.
 */

import type { ProviderCapabilities } from '../harness/bridge';
import type { Notice, NoticeKind } from '../harness/transcript';
import type { AskQuestion, HarnessEvent, TurnStats } from '../harness/types';
import { askCard, askReplayCard, setAskAnswered } from './ask-card';
import { el } from './dom';
import { dayKey, dayLabel, fmtClock, fmtDuration, fmtTime, fmtTokens, fmtUsd } from './format';
import { renderMd } from './markdown';
import { button, errText } from './util';

/** One chat on screen: a session's live thread node and its streaming state. */
export interface Session {
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
  /** Scroll the scroller showing `session` (no-op when it is off-screen). */
  scrollChat(force?: boolean, session?: Session): void;
  /** Deliver (or dismiss, with null) a mid-turn answer to the agent. */
  answerAsk(turnId: string, askId: string, answers: Record<string, string> | null): Promise<void>;
  toast(message: string): void;
  /** Roster-visible state changed (running/unread/title/membership). */
  rosterChanged(): void;
  /** Is this session the one on screen? (unread markers skip the current). */
  isCurrent(session: Session): boolean;
  /** Open a sub-agent chat where `from` (its parent) is showing. */
  openSession(id: number, from?: Session): void;
  /** Create a sub-agent chat session rooted under `parent` (session-domain). */
  spawnChild(parent: Session): Session;
  /** Capabilities of the provider behind `session` (undefined = unknown). */
  capabilities(session: Session): ProviderCapabilities | undefined;
  /** Drop `session`'s child chats (full-log rebuild re-creates them). */
  pruneChildren(session: Session): void;
  /** A `W-n` reference chip was clicked. */
  openRef?(ref: string): void;
  /** The chip's tooltip for a reference ("W-12 · Fix login redirect · running"), or null when unknown. */
  describeRef?(ref: string): string | null;
  /** Full-screen turn overlay chrome. */
  overlay: {
    body: HTMLElement;
    crumb: HTMLElement;
    title: HTMLElement;
    stage: HTMLElement;
    backButton: HTMLElement;
  };
}

/** How a notice row's dot is toned, by what the notice reports. */
export type NoticeTone = 'ok' | 'bad' | 'ask' | 'busy' | 'info';

export function noticeTone(kind: NoticeKind): NoticeTone {
  switch (kind) {
    case 'item.review':
    case 'pr.published':
    case 'pr.merged':
    case 'definition.applied':
      return 'ok';
    case 'item.failed':
    case 'github.auth':
      return 'bad';
    case 'item.needs-input':
    case 'pr.review':
      return 'ask';
    case 'item.requeued':
    case 'environment.restarted':
      return 'busy';
    default:
      return 'info';
  }
}

/** Split text into plain runs and `W-n` references (the refs become links). */
export function refRuns(text: string): { text: string; ref: boolean }[] {
  const runs: { text: string; ref: boolean }[] = [];
  const re = /\bW-\d{1,9}\b/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) runs.push({ text: text.slice(at, m.index), ref: false });
    runs.push({ text: m[0], ref: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at), ref: false });
  return runs;
}

/**
 * Turn `W-n` references in rendered text into chips that open the item.
 * Code, links and buttons keep their text as it is.
 */
export function linkRefs(root: HTMLElement, open: ((ref: string) => void) | undefined, describe?: (ref: string) => string | null): void {
  if (!open) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!/\bW-\d/.test(text.data)) continue;
    if (text.parentElement?.closest('code, pre, a, button, .ref-chip')) continue;
    hits.push(text);
  }
  for (const text of hits) {
    const frag = document.createDocumentFragment();
    for (const run of refRuns(text.data)) {
      if (!run.ref) {
        frag.appendChild(document.createTextNode(run.text));
        continue;
      }
      const chip = button('ref-chip', run.text);
      const title = describe?.(run.text);
      if (title) chip.title = title;
      chip.addEventListener('click', () => open(run.text));
      frag.appendChild(chip);
    }
    text.replaceWith(frag);
  }
}

/**
 * Shown at the top of a sub-agent chat when the provider reports only the
 * child's lifecycle (Codex over exec), so an empty transcript is not read
 * as a stalled agent.
 */
function lifecycleNote(): HTMLElement {
  const item = el('li', 'thread-note');
  item.append(
    el('span', 'thread-note-title', 'Lifecycle only'),
    el(
      'span',
      'thread-note-text',
      "This provider does not deliver the sub-agent's own transcript. " +
        'This chat shows when it started, the follow-up input it received, and its final status.',
    ),
  );
  return item;
}

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
   *  last day lives in a dataset attribute — no DOM scan per message. */
  function maybeDayDivider(container: HTMLElement, ts = Date.now()): void {
    const day = dayKey(ts);
    if (container.dataset.day === day) return;
    container.dataset.day = day;
    const divider = el('li', 'day-divider');
    divider.setAttribute('role', 'separator');
    divider.appendChild(el('span', 'day-chip', dayLabel(ts)));
    container.appendChild(divider);
  }

  function refs(root: HTMLElement): void {
    linkRefs(root, ctx.openRef, ctx.describeRef);
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
    const time = el('time', 'row-time', fmtTime(ts));
    time.dateTime = new Date(ts).toISOString();
    time.title = new Date(ts).toLocaleString();
    head.append(el('span', 'row-author', author), time);
    const body = el('div', 'row-body');
    main.append(head, body);
    const avatar = el('span', `row-avatar ${kind}`, (author[0] ?? '?').toUpperCase());
    avatar.setAttribute('aria-hidden', 'true');
    item.append(avatar, main);
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
    kind: 'user' | 'agent' = author === ctx.userName ? 'user' : 'agent',
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
      refs(grouped);
      last.querySelector('.row-main')?.appendChild(grouped);
    } else {
      maybeDayDivider(session.thread, ts);
      const { item, body } = messageRow(kind, author, ts);
      body.classList.add('prose');
      body.innerHTML = renderMd(text);
      refs(body);
      session.thread.appendChild(item);
    }
    if (session.thread.isConnected) ctx.scrollChat(true, session);
  }

  /** Builds one assistant turn inside a session's thread (which may be off-screen). */
  function addAssistantTurn(session: Session, turnId: string, ts = Date.now()): AssistantTurn {
    // Only move the visible scroller when this session is the one on screen.
    const scrollToBottom = (force = false): void => {
      if (session.thread.isConnected) ctx.scrollChat(force, session);
    };
    maybeDayDivider(session.thread, ts);
    const { item, body: content } = messageRow('agent', session.title, ts);
    session.thread.appendChild(item);

    // Text-only turns are just messages. The first tool call reveals ONE quiet
    // step card above the reply; clicking it opens the turn's steps full screen.
    const turnWork = el('div', 'turn-detail');
    const detailTitle = `Steps · ${fmtTime(ts)}`;
    let steps = 0;
    const turnCard = button('turn-card running hidden');
    turnCard.title = 'Show the steps';
    const cardDot = el('span', 'turn-card-dot');
    const cardLabel = el('span', 'turn-card-label', 'Working…');
    const cardLatest = el('span', 'turn-card-latest', '');
    const cardExpand = el('span', 'turn-card-expand');
    cardExpand.innerHTML = '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>';
    turnCard.append(cardDot, cardLabel, cardLatest, cardExpand);
    turnCard.addEventListener('click', () => {
      lastFullTrigger = turnCard;
      openFullTurn(session, turnWork, detailTitle);
    });
    // Between the author line and the reply, outside the body (whose text is the message).
    item.querySelector('.row-main')?.insertBefore(turnCard, content);
    item.querySelector('.row-main')?.append(turnWork);

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
        refs(proseCommitted);
      }
      proseTail.innerHTML = renderMd(proseRaw.slice(commitAt));
      refs(proseTail);
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
            if (answers) this.setThinking(true);
          },
        });
        card.dataset.askId = askId;
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
          const lifecycleOnly = ctx.capabilities(session)?.subAgentTranscript === false;
          if (lifecycleOnly) child.thread.appendChild(lifecycleNote());
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
            el('span', 'agent-link-open', lifecycleOnly ? 'Open status →' : 'Open chat →'),
          );
          link.addEventListener('click', () => ctx.openSession(child.id, session));
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
        const ms = Math.max(0, at - startedAt);
        const parts: string[] = [];
        if (ms >= 100) parts.push(fmtDuration(ms));
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
          const took = fmtDuration(stats.durationMs);
          const cost = stats.costUsd !== undefined ? ` · ${fmtUsd(stats.costUsd)}` : '';
          workAppend(
            el(
              'div',
              'turn-stats',
              `${fmtTokens(stats.inputTokens)} tokens in · ${fmtTokens(stats.outputTokens)} out · ${took}${cost}`,
            ),
          );
          turnCard.classList.remove('running');
          turnCard.classList.add('done');
          cardLabel.textContent = `${steps} step${steps === 1 ? '' : 's'}`;
          cardLatest.textContent = took;
        }
        scrollToBottom();
      },
    };
  }

  /**
   * A system row authored "Puck" (a small Puck mark in the avatar gutter):
   * one line per notice, each with a dot toned by kind; `W-n` references
   * are chips that open the item.
   */
  function addNotice(session: Session, notices: Pick<Notice, 'kind' | 'text'>[], ts = Date.now()): void {
    maybeDayDivider(session.thread, ts);
    const item = el('li', 'msg-row notice');
    item.dataset.author = 'Puck';
    item.dataset.ts = String(ts);
    const main = el('div', 'row-main');
    const head = el('div', 'row-head');
    const time = el('time', 'row-time', fmtTime(ts));
    time.dateTime = new Date(ts).toISOString();
    time.title = new Date(ts).toLocaleString();
    head.append(el('span', 'row-author', 'Puck'), time);
    main.appendChild(head);
    for (const notice of notices) {
      const line = el('div', 'notice-line');
      line.dataset.kind = notice.kind;
      line.appendChild(el('span', `notice-dot tone-${noticeTone(notice.kind)}`));
      const text = el('span', 'notice-text', notice.text);
      refs(text);
      line.appendChild(text);
      main.appendChild(line);
    }
    const avatar = el('span', 'row-avatar puck', 'P');
    avatar.setAttribute('aria-hidden', 'true');
    item.append(avatar, main);
    session.thread.appendChild(item);
    if (session.thread.isConnected) ctx.scrollChat(false, session);
  }

  return {
    addUserMessage,
    addNotice,
    addAssistantTurn,
    openFullTurn,
    closeFullTurn,
    detailFollow,
  };
}

export type ChatView = ReturnType<typeof initChatView>;
