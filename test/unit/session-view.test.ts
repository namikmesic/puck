// @vitest-environment jsdom

/**
 * Session threads load a history page when first shown, apply live events
 * on top without losing or repeating any, page back through older entries,
 * and keep drafts per environment and session.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DaemonEvent, OpResult } from '../../src/harness/daemon-protocol';
import type { TranscriptEntry } from '../../src/harness/transcript';
import { createInstanceStore } from '../../src/renderer/instance-store';
import { initSessionView, type SessionViewContext } from '../../src/renderer/session-view';
import { ENV, ORCH, session, snap, WORKER } from './v2-fixtures';

type Page = OpResult<'session.history'>;
const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(history: SessionViewContext['history'], over: Partial<SessionViewContext> = {}) {
  const store = createInstanceStore({ requestResync: () => undefined });
  store.reset(ENV);
  store.applySnapshot(snap({ head: 10, sessions: [session(), session({ id: WORKER, kind: 'worker', agent: 'implementer' })] }), ENV);
  const answerAsk = vi.fn(async () => undefined);
  const toast = vi.fn();
  const memory = new Map<string, string>();
  const view = initSessionView({
    store,
    history,
    answerAsk,
    userName: () => 'octocat',
    orchestratorName: () => 'lead',
    toast,
    overlay: {
      body: document.createElement('div'),
      crumb: document.createElement('span'),
      title: document.createElement('span'),
      stage: document.createElement('div'),
      backButton: document.createElement('button'),
    },
    storage: {
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => void memory.set(k, v),
      removeItem: (k) => void memory.delete(k),
    },
    ...over,
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  /** Apply an event the way the app does: the store first, then the view. */
  const live = (seq: number, ev: DaemonEvent): void => {
    store.applyEvent(seq, ev, ENV);
    view.apply(seq, ev);
  };
  return { store, view, host, live, answerAsk, toast, memory };
}

const user = (text: string, ts: number, author: 'user' | 'orchestrator' | 'system' = 'user'): TranscriptEntry => ({ kind: 'user', text, author, ts });
const texts = (host: HTMLElement): string[] => [...host.querySelectorAll('.row-body, .notice-text')].map((n) => (n.textContent ?? '').trim());
const page = (entries: TranscriptEntry[], head: number, total = entries.length): Page => ({ entries, total, hasMore: total > entries.length, head });

describe('session view', () => {
  it('loads the newest page when first shown, with authors and notices', async () => {
    const history = vi.fn(async () =>
      page(
        [
          user('Create two items', 1),
          { kind: 'notice', ts: 2, notices: [{ id: 'n1', kind: 'item.review', at: 2, text: 'W-1 is ready for review' }] },
          { kind: 'turn', turnId: 't1', ts: 3, events: [{ kind: 'text-delta', text: 'Done.' }, { kind: 'turn-end', stats: { inputTokens: 1, outputTokens: 1, durationMs: 5 } }] },
        ],
        10,
      ),
    );
    const { view, host } = setup(history);
    view.mount(ORCH, host);
    expect(host.querySelector('.thread-status')?.textContent).toBe('Loading the conversation…');
    await flush();
    await nextFrame();
    expect(history).toHaveBeenCalledWith(ORCH);
    expect(texts(host)).toEqual(['Create two items', 'W-1 is ready for review', 'Done.']);
    expect(host.querySelector('.msg-row.user .row-author')?.textContent).toBe('octocat');
    expect(host.querySelector('.msg-row.notice .row-author')?.textContent).toBe('Puck');
  });

  it('applies events that arrive while loading only when the page does not have them', async () => {
    let resolve: (p: Page) => void = () => undefined;
    const { view, host, live } = setup(() => new Promise((r) => (resolve = r)));
    view.mount(ORCH, host);
    live(11, { kind: 'turn.user', sessionId: ORCH, entry: { kind: 'user', text: 'in the page', author: 'user', ts: 5 } });
    live(12, { kind: 'turn.user', sessionId: ORCH, entry: { kind: 'user', text: 'after the page', author: 'user', ts: 999_999_999 } });
    resolve(page([user('in the page', 5)], 11));
    await flush();
    expect(texts(host)).toEqual(['in the page', 'after the page']);
  });

  // Follow-up v2-history-failure-drops-replay: a failed history load keeps
  // the events that arrived meanwhile, and a retry shows the page plus them.
  it('v2-history-failure-drops-replay: a failed load keeps waiting events and Retry renders page plus tail', async () => {
    const pages: (Page | Error)[] = [new Error('connection dropped'), page([user('earlier', 1)], 11)];
    const history = vi.fn(async () => {
      const next = pages.shift();
      if (next instanceof Error) throw next;
      return next as Page;
    });
    const { view, host, live, store } = setup(history);
    view.mount(ORCH, host);
    live(11, { kind: 'turn.user', sessionId: ORCH, entry: { kind: 'user', text: 'earlier', author: 'user', ts: 1 } });
    await flush();
    const failed = host.querySelector('.thread-status.failed');
    expect(failed?.textContent).toContain("Couldn't load this conversation: connection dropped");
    // The store's cursor moves on with the stream; the thread keeps what it has not shown.
    live(12, { kind: 'turn.start', sessionId: ORCH, turnId: 't2' });
    live(13, { kind: 'turn.event', sessionId: ORCH, turnId: 't2', event: { kind: 'text-delta', text: 'Working on it' } });
    expect(store.cursor()).toBe(13);
    (failed?.querySelector('button') as HTMLButtonElement).click();
    await flush();
    await nextFrame();
    expect(history).toHaveBeenCalledTimes(2);
    expect(texts(host)).toEqual(['earlier', 'Working on it']);
    expect(host.querySelector('.thread-status')).toBeNull();
  });

  it('keeps streaming into a turn the page caught mid-stream, with live question cards', async () => {
    const q = [{ question: 'Ship it?', header: '', options: [{ label: 'Yes', description: '' }], multiSelect: false }];
    const { view, host, live, store, answerAsk } = setup(async () =>
      page([{ kind: 'turn', turnId: 't1', ts: 3, events: [{ kind: 'text-delta', text: 'Part one. ' }, { kind: 'ask', askId: 'a1', questions: q }] }], 12),
    );
    store.applyEvent(11, { kind: 'turn.start', sessionId: ORCH, turnId: 't1' }, ENV);
    store.applyEvent(12, { kind: 'turn.event', sessionId: ORCH, turnId: 't1', event: { kind: 'ask', askId: 'a1', questions: q } }, ENV);
    view.mount(ORCH, host);
    await flush();
    const card = host.querySelector('[data-ask-id="a1"]') as HTMLElement;
    expect(card.classList.contains('answered')).toBe(false);
    (card.querySelector('.ask-option') as HTMLButtonElement).click();
    await flush();
    expect(answerAsk).toHaveBeenCalledWith(ORCH, 'a1', { 'Ship it?': 'Yes' });
    live(13, { kind: 'turn.event', sessionId: ORCH, turnId: 't1', event: { kind: 'text-delta', text: 'Part two.' } });
    live(14, { kind: 'turn.end', sessionId: ORCH, turnId: 't1', stats: { inputTokens: 1, outputTokens: 1, durationMs: 1 } });
    await nextFrame();
    expect(host.querySelectorAll('.msg-row')).toHaveLength(1);
    expect(host.querySelector('.msg-row')?.textContent).toContain('Part two.');
  });

  it('closes a question card the orchestrator answered', async () => {
    const q = [{ question: 'Which?', header: '', options: [{ label: 'A', description: '' }], multiSelect: false }];
    const { view, host, live } = setup(async () => page([], 10));
    view.mount(WORKER, host);
    await flush();
    live(11, { kind: 'turn.start', sessionId: WORKER, turnId: 'tw' });
    live(12, { kind: 'turn.event', sessionId: WORKER, turnId: 'tw', event: { kind: 'ask', askId: 'aw', questions: q } });
    live(13, { kind: 'ask.closed', sessionId: WORKER, askId: 'aw', answers: { 'Which?': 'A' }, by: 'orchestrator' });
    expect(host.querySelector('[data-ask-id="aw"]')?.classList.contains('answered')).toBe(true);
  });

  it('shows orchestrator follow-ups in worker threads under the orchestrator name', async () => {
    const { view, host } = setup(async () => page([user('Please add tests', 1, 'orchestrator')], 10));
    view.mount(WORKER, host);
    await flush();
    const row = host.querySelector('.msg-row') as HTMLElement;
    expect(row.classList.contains('agent')).toBe(true);
    expect(row.querySelector('.row-author')?.textContent).toBe('lead');
  });

  it('pages back through older entries', async () => {
    const history = vi.fn(async (_id: string, before?: number) =>
      before === undefined ? page([user('new', 3 * 86_400_000)], 10, 3) : { entries: [user('old 1', 1), user('old 2', 2)], total: 3, hasMore: false, head: 10 },
    );
    const { view, host } = setup(history);
    view.mount(ORCH, host);
    await flush();
    const more = host.querySelector('.load-earlier button') as HTMLButtonElement;
    expect(more.textContent).toBe('Show earlier');
    more.click();
    await flush();
    expect(history).toHaveBeenLastCalledWith(ORCH, 2);
    expect(texts(host)).toEqual(['old 1', 'old 2', 'new']);
    expect(host.querySelector('.load-earlier')).toBeNull();
  });

  it('ignores events for threads never shown, and reloads after a reset', async () => {
    const history = vi.fn(async () => page([user('hello', 1)], 10));
    const { view, host, live } = setup(history);
    live(11, { kind: 'turn.user', sessionId: WORKER, entry: { kind: 'user', text: 'x', author: 'user', ts: 2 } });
    view.mount(ORCH, host);
    await flush();
    expect(view.reset()).toBe(ORCH);
    expect(host.textContent).toBe('');
    view.mount(ORCH, host);
    await flush();
    expect(history).toHaveBeenCalledTimes(2);
  });

  it('keeps drafts per environment and session, and survives broken storage', () => {
    const { view, memory } = setup(async () => page([], 1));
    view.saveDraft(ORCH, 'half a thought');
    expect(memory.get(`puck.draft.${ENV}.${ORCH}`)).toBe('half a thought');
    expect(view.draft(ORCH)).toBe('half a thought');
    view.saveDraft(ORCH, '');
    expect(view.draft(ORCH)).toBe('');
    const broken = setup(async () => page([], 1), {
      storage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
        removeItem: () => undefined,
      },
    });
    broken.view.saveDraft(ORCH, 'x');
    expect(broken.view.draft(ORCH)).toBe('');
  });
});
