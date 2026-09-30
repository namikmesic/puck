/**
 * The Chat view's Waiting on you stack: every worker question routed to the
 * user, above the orchestrator's composer, so it waits where the user
 * already talks to Puck. One entry per question, grouped by ticket, oldest
 * first; each names its ticket with a W-n chip and answers through
 * `ask.answer` with the same card as the work sheet's banner. Against a
 * daemon that predates the three-column board the lines stay and nothing
 * answers them. At most three
 * entries show. When more than one waits, each is one line until opened.
 * The rest are one `+N waiting` row that opens the Board with In progress
 * narrowed to the tickets that need you.
 *
 * Decisions join the stack with the delivery workflow; this version has
 * questions only. The orchestrator's own questions stay in its thread.
 */

import type { AskQuestion } from '../harness/types';
import type { OpenAsk, WorkItem } from '../harness/daemon-protocol';
import { askCard } from './ask-card';
import { LEGACY_READ_ONLY } from './board-model';
import { el } from './dom';
import { button, errText } from './util';

/** Entries shown before the `+N waiting` row. */
export const WAITING_SHOWN = 3;

export interface WaitingEntry {
  itemId: string;
  number: number;
  title: string;
  agent: string | null;
  sessionId: string;
  askId: string;
  questions: AskQuestion[];
}

/** The user-routed questions of in-progress tickets: grouped by ticket, the ticket asked longest ago first. */
export function waitingEntries(items: readonly WorkItem[], asks: readonly OpenAsk[]): WaitingEntry[] {
  const bySession = new Map<string, WorkItem>();
  for (const item of items) if (item.sessionId && item.status === 'in-progress') bySession.set(item.sessionId, item);
  const groups = new Map<string, { since: number; at: number; entries: WaitingEntry[] }>();
  asks.forEach((ask, at) => {
    if (ask.routedTo !== 'user') return;
    const item = bySession.get(ask.sessionId);
    if (!item) return;
    let group = groups.get(item.id);
    if (!group) {
      group = { since: item.oldestUserAsk?.since ?? item.updatedAt, at, entries: [] };
      groups.set(item.id, group);
    }
    const entry = { itemId: item.id, number: item.number, title: item.title, agent: item.agent, sessionId: ask.sessionId, askId: ask.askId, questions: ask.questions };
    // The ticket's oldest question leads its group.
    if (item.oldestUserAsk?.askId === ask.askId) group.entries.unshift(entry);
    else group.entries.push(entry);
  });
  return [...groups.values()].sort((a, b) => a.since - b.since || a.at - b.at).flatMap((g) => g.entries);
}

export interface WaitingStackContext {
  host: HTMLElement;
  store: { items(): WorkItem[]; asks(): OpenAsk[] };
  /** True against a daemon that predates the three-column board: its tickets' questions show, but are not answered here. */
  readOnly(): boolean;
  daemon(op: 'ask.answer', args: { sessionId: string; askId: string; answers: Record<string, string> | null }): Promise<unknown>;
  openItem(itemId: string): void;
  /** The Board, In progress narrowed to the tickets that need you. */
  showNeedsYou(): void;
  say(text: string): void;
}

export function initWaitingStack(ctx: WaitingStackContext) {
  const { host } = ctx;
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', 'Waiting on you');
  let built = '';
  let shownNow = true;
  /** The entry opened from its one-line form; the only one when a single question waits. */
  let open: string | null = null;
  /** Answers on their way: their entries stay out until the ask closes or the answer fails. */
  const sending = new Set<string>();

  /** `visible`: false while the chat shows an earlier session or a sub-agent, whose composer is not the orchestrator's. */
  function render(visible = true): void {
    shownNow = visible;
    const asks = ctx.store.asks();
    for (const id of sending) if (!asks.some((a) => a.askId === id)) sending.delete(id);
    const all = waitingEntries(ctx.store.items(), asks).filter((e) => !sending.has(e.askId));
    const shown = all.slice(0, WAITING_SHOWN);
    if (open && !shown.some((e) => e.askId === open)) open = null;
    const readOnly = ctx.readOnly();
    if (readOnly) open = null;
    const key = JSON.stringify([visible, readOnly, shown.map((e) => [e.askId, e.number, e.title]), all.length, open]);
    if (key === built) return;
    built = key;
    host.textContent = '';
    host.classList.toggle('hidden', !visible || !all.length);
    if (!visible || !all.length) return;
    const head = el('div', 'oc-wait-head');
    head.append(el('span', 'oc-wait-title', 'Waiting on you'), el('span', 'oc-wait-count', String(all.length)));
    host.appendChild(head);
    const list = el('ul', 'oc-wait-list');
    const single = all.length === 1 && !readOnly;
    for (const entry of shown) list.appendChild(row(entry, single || open === entry.askId, readOnly));
    const rest = all.length - shown.length;
    if (rest > 0) {
      const li = el('li', 'oc-wait-more');
      const more = button('oc-wait-more-btn', `+${rest} waiting`);
      more.addEventListener('click', () => ctx.showNeedsYou());
      li.appendChild(more);
      list.appendChild(li);
    }
    host.appendChild(list);
  }

  function row(entry: WaitingEntry, expanded: boolean, readOnly: boolean): HTMLElement {
    const li = el('li', `oc-wait-entry${expanded ? ' open' : ''}`);
    li.dataset.askId = entry.askId;
    const line = el('div', 'oc-wait-line');
    const chip = button('oc-wait-ticket', `W‑${entry.number}`);
    chip.title = `Open W-${entry.number}: ${entry.title}`;
    chip.addEventListener('click', () => ctx.openItem(entry.itemId));
    line.appendChild(chip);
    const who = `${entry.agent ?? 'The worker'} asks`;
    // Open, the card below carries the question.
    if (expanded) line.appendChild(el('span', 'oc-wait-text', `${who}:`));
    else if (readOnly) {
      const text = el('span', 'oc-wait-text', `${who}: ${entry.questions[0]?.question ?? ''}`);
      text.title = LEGACY_READ_ONLY;
      line.appendChild(text);
    } else {
      const summary = `${who}: ${entry.questions[0]?.question ?? ''}`;
      const toggle = button('oc-wait-text', summary);
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => {
        open = entry.askId;
        render(shownNow);
        host.querySelector<HTMLButtonElement>(`[data-ask-id="${CSS.escape(entry.askId)}"] .ask-option, [data-ask-id="${CSS.escape(entry.askId)}"] .ask button`)?.focus();
      });
      line.appendChild(toggle);
    }
    li.appendChild(line);
    if (expanded) {
      li.appendChild(
        askCard(entry.questions, {
          submit: async (answers) => {
            sending.add(entry.askId);
            try {
              await ctx.daemon('ask.answer', { sessionId: entry.sessionId, askId: entry.askId, answers });
            } catch (err) {
              sending.delete(entry.askId);
              ctx.say(`Couldn't send the answer: ${errText(err)}`);
              throw err;
            } finally {
              render(shownNow);
            }
          },
        }),
      );
    }
    return li;
  }

  return {
    render,
    /** A new environment: nothing is being answered. */
    reset(): void {
      sending.clear();
      open = null;
      built = '';
      render(shownNow);
    },
  };
}

export type WaitingStack = ReturnType<typeof initWaitingStack>;
