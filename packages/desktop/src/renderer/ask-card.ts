/**
 * The ask card: the agent's mid-turn question(s) as an interactive widget
 * (option buttons, multi-select, a free-text escape hatch, dismiss), plus the
 * read-only replay variant for questions answered in a previous run.
 *
 * Pure card construction — delivery, session-log recording, and open-card
 * bookkeeping stay with the caller (chat-view). The submit hook may reject
 * to signal failed delivery; the card re-arms itself so the user can retry.
 */

import type { AskOption, AskQuestion } from '../harness/types';
import { el } from './dom';
import { button } from './util';

/** Shared ask-card scaffolding: header chip + question line. */
function askHead(q: AskQuestion): HTMLElement {
  const head = el('div', 'ask-head');
  if (q.header) head.appendChild(el('span', 'ask-chip', q.header));
  head.appendChild(el('span', 'ask-question', q.question));
  return head;
}

/** Freeze (or re-arm) an ask card: answered styling plus every control disabled. */
export function setAskAnswered(card: HTMLElement, answered: boolean): void {
  card.classList.toggle('answered', answered);
  card.querySelectorAll('button, input').forEach((n) => {
    (n as HTMLButtonElement | HTMLInputElement).disabled = answered;
  });
}

function askOptionButton(option: AskOption): HTMLButtonElement {
  const btn = button('ask-option');
  btn.appendChild(el('span', 'ask-option-label', option.label));
  if (option.description) btn.appendChild(el('span', 'ask-option-desc', option.description));
  return btn;
}

export interface AskCardHooks {
  /** Deliver the answers (null = dismissed). Reject to re-arm the card. */
  submit(answers: Record<string, string> | null): Promise<void>;
}

/** Interactive card for a live question; answers flow back through `hooks`. */
export function askCard(questions: AskQuestion[], hooks: AskCardHooks): HTMLElement {
  const card = el('div', 'ask');
  const chosen = new Map<string, Set<string>>();
  const typed = new Map<string, string>();
  // A lone single-select question answers on click; anything richer
  // collects selections and submits via the footer button.
  const instant = questions.length === 1 && !questions[0].multiSelect;
  let submitted = false;

  const answered = (q: AskQuestion) =>
    Boolean(typed.get(q.question)?.trim() || chosen.get(q.question)?.size);
  const collect = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const q of questions) {
      const text = typed.get(q.question)?.trim();
      const picks = [...(chosen.get(q.question) ?? [])];
      if (text) out[q.question] = text;
      else if (picks.length) out[q.question] = picks.join(', ');
    }
    return out;
  };
  const submit = async (answers: Record<string, string> | null) => {
    if (submitted) return;
    submitted = true;
    setAskAnswered(card, true);
    try {
      await hooks.submit(answers);
    } catch {
      // Delivery failed — the agent is still waiting. Re-arm the card.
      submitted = false;
      setAskAnswered(card, false);
    }
  };

  const sendBtn = button('btn-primary', 'Send answer');
  sendBtn.disabled = true;
  sendBtn.addEventListener('click', () => void submit(collect()));
  const refresh = () => {
    sendBtn.disabled = !questions.every(answered);
  };

  for (const q of questions) {
    const sec = el('div', 'ask-q');
    sec.appendChild(askHead(q));

    const opts = el('div', 'ask-options');
    for (const option of q.options) {
      const btn = askOptionButton(option);
      btn.addEventListener('click', () => {
        let set = chosen.get(q.question);
        if (!set) chosen.set(q.question, (set = new Set()));
        if (q.multiSelect) {
          if (set.has(option.label)) set.delete(option.label);
          else set.add(option.label);
          btn.classList.toggle('selected');
        } else {
          set.clear();
          set.add(option.label);
          opts.querySelectorAll('.ask-option').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          if (instant) return void submit(collect());
        }
        refresh();
      });
      opts.appendChild(btn);
    }
    sec.appendChild(opts);

    const other = document.createElement('input');
    other.className = 'ask-other';
    other.placeholder = 'Something else…';
    other.addEventListener('input', () => {
      typed.set(q.question, other.value);
      refresh();
    });
    other.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && questions.every(answered)) void submit(collect());
    });
    sec.appendChild(other);
    card.appendChild(sec);
  }

  const foot = el('div', 'ask-foot');
  const dismiss = button('btn-ghost', 'Dismiss');
  dismiss.title = 'Let the agent decide on its own';
  dismiss.addEventListener('click', () => void submit(null));
  foot.append(sendBtn, dismiss);
  card.appendChild(foot);
  return card;
}

/** Read-only card for a question answered in a previous run. */
export function askReplayCard(
  questions: AskQuestion[],
  answers: Record<string, string> | null,
): HTMLElement {
  const card = el('div', 'ask answered');
  for (const q of questions) {
    const sec = el('div', 'ask-q');
    sec.appendChild(askHead(q));
    const opts = el('div', 'ask-options');
    const chosen = answers?.[q.question]?.split(', ') ?? [];
    for (const option of q.options) {
      const btn = askOptionButton(option);
      btn.disabled = true;
      if (chosen.includes(option.label)) btn.classList.add('selected');
      opts.appendChild(btn);
    }
    // Free-text answers that aren't one of the options.
    const free = answers?.[q.question];
    if (free && !q.options.some((o) => chosen.includes(o.label))) {
      opts.appendChild(el('div', 'ask-option selected ask-free', free));
    }
    sec.appendChild(opts);
    card.appendChild(sec);
  }
  if (!answers) {
    card.appendChild(el('div', 'ask-dismissed', 'Dismissed — the agent decided on its own.'));
  }
  return card;
}
