// @vitest-environment jsdom

/**
 * The Chat view's Waiting on you stack: workers' questions routed to the
 * user, grouped by ticket and oldest first, at most three with the rest as
 * one `+N waiting` row, each answered through `ask.answer`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { OpenAsk, WorkItem } from '../../src/harness/daemon-protocol';
import { initWaitingStack, waitingEntries, WAITING_SHOWN } from '../../src/renderer/waiting-stack';
import { flush, item } from './v2-fixtures';

function ask(n: number, sessionId: string, over: Partial<OpenAsk> = {}): OpenAsk {
  return {
    sessionId,
    turnId: `trn_${n}`,
    askId: `ask_${n}`,
    questions: [{ question: `Question ${n}?`, header: '', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }],
    routedTo: 'user',
    ...over,
  };
}

function asking(number: number, since: number, askId = `ask_${number}`): WorkItem {
  return item({
    number,
    status: 'needs-input',
    pendingAsk: { askId, routedTo: 'user' },
    oldestUserAsk: { askId, kind: 'question', roundId: 'r', stepId: 's', since },
    userAsks: 1,
    openAsks: 1,
  });
}

function setup(items: WorkItem[], asks: OpenAsk[]) {
  document.body.innerHTML = '<div id="host" class="hidden"></div>';
  const host = document.getElementById('host') as HTMLElement;
  const state = { items, asks };
  const daemon = vi.fn(async () => ({}));
  const openItem = vi.fn();
  const showNeedsYou = vi.fn();
  const say = vi.fn();
  const stack = initWaitingStack({ host, store: { items: () => state.items, asks: () => state.asks }, daemon, openItem, showNeedsYou, say });
  stack.render();
  return { host, state, stack, daemon, openItem, showNeedsYou, say };
}

describe('waitingEntries', () => {
  it('keeps user-routed questions of in-progress tickets, grouped by ticket, the one asked longest ago first', () => {
    const a = asking(1, 300);
    const b = asking(2, 100);
    const done = item({ number: 3, status: 'done', sessionId: 'ses_w3' });
    const entries = waitingEntries(
      [a, b, done],
      [
        ask(1, 'ses_w1'),
        ask(9, 'ses_w1', { askId: 'ask_9' }),
        ask(2, 'ses_w2'),
        ask(3, 'ses_w3'),
        ask(4, 'ses_w2', { routedTo: 'orchestrator', askId: 'ask_4' }),
        ask(5, 'ses_orch', { askId: 'ask_5' }),
      ],
    );
    expect(entries.map((e) => [e.number, e.askId])).toEqual([
      [2, 'ask_2'],
      [1, 'ask_1'],
      [1, 'ask_9'],
    ]);
  });
});

describe('the Waiting on you stack', () => {
  it('stays hidden with nothing waiting', () => {
    const { host } = setup([item({ number: 1, status: 'running' })], [ask(1, 'ses_w1', { routedTo: 'orchestrator' })]);
    expect(host.classList.contains('hidden')).toBe(true);
    expect(host.textContent).toBe('');
  });

  it('shows one question open, with its ticket chip, and answers it through ask.answer', async () => {
    const { host, daemon, openItem } = setup([asking(4, 1)], [ask(4, 'ses_w4')]);
    expect(host.classList.contains('hidden')).toBe(false);
    expect(host.querySelector('.oc-wait-title')?.textContent).toBe('Waiting on you');
    const entry = host.querySelector<HTMLElement>('.oc-wait-entry');
    expect(entry?.classList.contains('open')).toBe(true);
    expect(entry?.querySelector('.oc-wait-ticket')?.textContent).toBe('W‑4');
    expect(entry?.querySelector('.oc-wait-text')?.textContent).toBe('implementer asks: Question 4?');
    (entry?.querySelector('.oc-wait-ticket') as HTMLButtonElement).click();
    expect(openItem).toHaveBeenCalledWith('itm_4');
    const yes = [...host.querySelectorAll<HTMLButtonElement>('.ask-option')].find((b) => b.textContent?.includes('Yes'));
    yes?.click();
    await flush();
    expect(daemon).toHaveBeenCalledWith('ask.answer', { sessionId: 'ses_w4', askId: 'ask_4', answers: { 'Question 4?': 'Yes' } });
    // Answered: it leaves the stack at once.
    expect(host.classList.contains('hidden')).toBe(true);
  });

  it('collapses each to one line when several wait, opens one on click, and puts the rest in +N waiting', () => {
    const items = [1, 2, 3, 4, 5].map((n) => asking(n, n));
    const { host, state, stack, showNeedsYou } = setup(items, items.map((i) => ask(i.number, `ses_w${i.number}`)));
    const entries = host.querySelectorAll<HTMLElement>('.oc-wait-entry');
    expect(entries).toHaveLength(WAITING_SHOWN);
    expect([...entries].map((e) => e.querySelector('.oc-wait-ticket')?.textContent)).toEqual(['W‑1', 'W‑2', 'W‑3']);
    expect(host.querySelectorAll('.ask')).toHaveLength(0);
    expect(host.querySelector('.oc-wait-count')?.textContent).toBe('5');
    const more = host.querySelector<HTMLButtonElement>('.oc-wait-more-btn');
    expect(more?.textContent).toBe('+2 waiting');
    more?.click();
    expect(showNeedsYou).toHaveBeenCalled();
    (entries[1]?.querySelector('button.oc-wait-text') as HTMLButtonElement).click();
    const open = host.querySelectorAll<HTMLElement>('.oc-wait-entry.open');
    expect(open).toHaveLength(1);
    expect(open[0]?.dataset.askId).toBe('ask_2');
    expect(open[0]?.querySelector('.ask')).not.toBeNull();
    // The oldest is answered elsewhere: the next moves up, the open one stays open.
    state.asks = state.asks.filter((a) => a.askId !== 'ask_1');
    stack.render();
    expect([...host.querySelectorAll('.oc-wait-entry')].map((e) => (e as HTMLElement).dataset.askId)).toEqual(['ask_2', 'ask_3', 'ask_4']);
    expect(host.querySelector<HTMLElement>('.oc-wait-entry.open')?.dataset.askId).toBe('ask_2');
    expect(host.querySelector('.oc-wait-more-btn')?.textContent).toBe('+1 waiting');
  });

  it('keeps a question whose answer failed, and says why', async () => {
    const { host, daemon, say } = setup([asking(4, 1)], [ask(4, 'ses_w4')]);
    daemon.mockRejectedValueOnce(new Error('The daemon is shutting down.'));
    [...host.querySelectorAll<HTMLButtonElement>('.ask-option')][0]?.click();
    await flush();
    await flush();
    expect(say).toHaveBeenCalledWith("Couldn't send the answer: The daemon is shutting down.");
    expect(host.classList.contains('hidden')).toBe(false);
    expect(host.querySelector('.ask')).not.toBeNull();
  });

  it('hides while the chat shows an earlier session or a sub-agent, and comes back', () => {
    const { host, stack } = setup([asking(4, 1)], [ask(4, 'ses_w4')]);
    stack.render(false);
    expect(host.classList.contains('hidden')).toBe(true);
    stack.render(true);
    expect(host.classList.contains('hidden')).toBe(false);
    expect(host.querySelector('.oc-wait-entry')).not.toBeNull();
  });
});
