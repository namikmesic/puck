// @vitest-environment jsdom

/**
 * The Board view: one column per stage (Closed as a rail until expanded),
 * cards with their status signals, the card menu, drag and drop only where
 * a transition exists, keyboard navigation, and New item and Import issue.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../../src/harness/daemon-protocol';
import { initBoard } from '../../src/renderer/board';
import { createInstanceStore } from '../../src/renderer/instance-store';
import { closePopup } from '../../src/renderer/popup';
import { ENV, item, session, snap } from './v2-fixtures';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const NOW = 10_000_000;

interface Options {
  agents?: string[];
  repos?: { github: string; dir: string }[];
  paused?: boolean;
  snapshot?: boolean;
}

function setup(items: WorkItem[], opts: Options = {}) {
  document.body.innerHTML = `<div id="cols"></div><div id="cap"></div><div id="paused" class="hidden"></div><button id="new"></button><button id="imp"></button>`;
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const resync = vi.fn();
  const store = createInstanceStore({ requestResync: resync });
  store.reset(ENV);
  const agents = Object.fromEntries((opts.agents ?? ['implementer', 'reviewer']).map((a) => [a, { running: 0, max: 2 }]));
  if (opts.snapshot !== false) {
    store.applySnapshot(
      snap({ head: 1, items, order: items.map((i) => i.id), capacity: { agents, workers: { running: 1, max: 3 }, paused: opts.paused ?? false }, repos: opts.repos ?? [{ github: 'octo/web', dir: 'web' }] }),
      ENV,
    );
  }
  const daemon = vi.fn(async (op: string, args: Record<string, unknown>): Promise<unknown> => {
    if (op === 'item.create') return item({ number: 99, title: String(args.title) });
    if (op === 'issue.import') return item({ number: 50 });
    if (op === 'issue.search')
      return { issues: [{ repo: 'octo/web', number: 12, title: 'Broken link', state: 'open', labels: [], url: 'u', item: null }, { repo: 'octo/web', number: 13, title: 'Taken', state: 'open', labels: [], url: 'u', item: 'W-2 (review)' }] };
    return {};
  });
  const openItem = vi.fn();
  const toChat = vi.fn();
  const openExternal = vi.fn();
  const say = vi.fn();
  const prefs = new Map<string, string>();
  let selected: string | null = null;
  const board = initBoard({
    els: { columns: byId('cols'), capacity: byId('cap'), paused: byId('paused'), newBtn: byId('new'), importBtn: byId('imp') },
    store,
    daemon: daemon as never,
    openItem,
    selected: () => selected,
    toChat,
    openExternal,
    say,
    resync,
    prefs: { getItem: (k) => prefs.get(k) ?? null, setItem: (k, v) => void prefs.set(k, v) },
    debounceMs: 0,
    now: () => NOW,
  });
  board.render();
  store.subscribe(() => board.render());
  const col = (id: string) => document.querySelector<HTMLElement>(`.bd-col[data-col="${id}"]`) as HTMLElement;
  const ids = (id: string) => [...col(id).querySelectorAll<HTMLElement>('.bd-card')].map((c) => c.dataset.item);
  const card = (id: string) => document.querySelector<HTMLElement>(`.bd-card[data-item="${id}"]`) as HTMLElement;
  const select = (id: string | null): void => {
    selected = id;
  };
  return { store, board, daemon, openItem, toChat, openExternal, say, resync, prefs, byId, col, ids, card, select };
}

/** A synthetic drag event (jsdom has no DragEvent) at a pointer height. */
function drag(type: string, target: HTMLElement, clientY = 0): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clientY', { value: clientY });
  target.dispatchEvent(ev);
  return ev;
}

function box(node: HTMLElement, top: number, height = 40): void {
  node.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, right: 200, width: 200, x: 0, y: top, toJSON: () => ({}) });
}

const menuItems = (): string[] => [...document.querySelectorAll<HTMLElement>('.menu .menu-item')].map((b) => b.dataset.action ?? '');

afterEach(() => {
  closePopup();
});

describe('board', () => {
  it('puts every item in the column for its stage, with counts, and nothing hidden', () => {
    const { ids, col } = setup([
      item({ number: 1, status: 'backlog' }),
      item({ number: 2, status: 'queued', agent: 'implementer' }),
      item({ number: 3, status: 'running', agent: 'implementer', sessionId: 's3' }),
      item({ number: 4, status: 'needs-input', agent: 'implementer', pendingAsk: { askId: 'a', routedTo: 'user' } }),
      item({ number: 5, status: 'review', agent: 'implementer' }),
      item({ number: 6, status: 'done' }),
      item({ number: 7, status: 'failed', lastError: 'tests failed' }),
      item({ number: 8, status: 'cancelled', cancelReason: 'Superseded by W-11.' }),
    ]);
    expect(ids('backlog')).toEqual(['itm_1']);
    expect(ids('ready')).toEqual(['itm_2']);
    expect(ids('progress')).toEqual(['itm_4', 'itm_3']);
    expect(ids('review')).toEqual(['itm_5']);
    expect(ids('done')).toEqual(['itm_6']);
    expect(ids('closed')).toEqual(['itm_8', 'itm_7']);
    expect(col('progress').querySelector('.bd-col-count')?.textContent).toBe('2');
    // Closed is a rail with its counts until expanded; a cancelled item is counted there.
    expect(col('closed').classList.contains('collapsed')).toBe(true);
    const rail = col('closed').querySelector('.bd-rail') as HTMLButtonElement;
    expect(rail.querySelector('.bd-rail-title')?.textContent).toBe('Closed');
    expect(rail.querySelector('.bd-rail-count')?.textContent).toBe('2');
    expect(rail.querySelector('.bd-rail-failed')?.textContent).toBe('1');
    expect(rail.getAttribute('aria-label')).toBe('Show closed items: 1 failed, 1 cancelled');
  });

  it('expands Closed, remembers it, and folds it again', () => {
    const { col, prefs } = setup([item({ number: 7, status: 'cancelled' })]);
    (col('closed').querySelector('.bd-rail') as HTMLButtonElement).click();
    expect(col('closed').classList.contains('collapsed')).toBe(false);
    expect(prefs.get('puck.board.closedOpen')).toBe('1');
    (col('closed').querySelector('.bd-fold') as HTMLButtonElement).click();
    expect(col('closed').classList.contains('collapsed')).toBe(true);
    expect(prefs.get('puck.board.closedOpen')).toBe('0');
  });

  it('shows each card’s signals: questions, the running clock, the queue, the reason it closed', () => {
    const { card, store } = setup(
      [
        item({ number: 1, status: 'needs-input', agent: 'implementer', pendingAsk: { askId: 'a', routedTo: 'user' }, repo: 'api' }),
        item({ number: 2, status: 'needs-input', agent: 'reviewer', pendingAsk: { askId: 'b', routedTo: 'orchestrator' } }),
        item({ number: 3, status: 'running', agent: 'implementer', sessionId: 's3', updatedAt: NOW - 125_000, attempts: 2 }),
        item({ number: 4, status: 'queued', agent: 'implementer', createdBy: 'orchestrator' }),
        item({ number: 5, status: 'queued', agent: 'implementer', source: { kind: 'github-issue', repo: 'octo/web', number: 12, url: 'u', updatedAt: 1 } }),
        item({ number: 6, status: 'review', agent: 'implementer', result: { summary: '', commits: [], diffStat: { files: 2, insertions: 120, deletions: 30, text: '' }, uncommitted: [], interrupted: false, endedAt: 5 }, pr: { number: 45, url: 'u', draft: false, lastPushedSha: 'x', state: 'open', checks: { sha: 'x', state: 'failure', failing: [] } } }),
        item({ number: 7, status: 'cancelled', cancelReason: 'Superseded by W-11.' }),
      ],
      { repos: [{ github: 'octo/web', dir: 'web' }, { github: 'octo/api', dir: 'api' }] },
    );
    expect(card('itm_1').classList.contains('needs-you')).toBe(true);
    expect(card('itm_1').querySelector('.bd-signal')?.textContent).toBe('Needs your input');
    expect(card('itm_2').classList.contains('needs-you')).toBe(false);
    expect(card('itm_2').querySelector('.bd-signal')?.textContent).toBe('Asked the orchestrator');
    expect(card('itm_3').querySelector('.bd-elapsed')?.textContent).toBe('2m 05s');
    expect(card('itm_3').querySelector('.bd-chip.attempts')?.textContent).toBe('Attempt 2');
    expect(card('itm_4').querySelector('.bd-signal')?.textContent).toBe('Next for implementer');
    expect(card('itm_4').querySelector('.bd-by')).not.toBeNull();
    expect(card('itm_5').querySelector('.bd-signal')?.textContent).toBe('2nd for implementer');
    expect(card('itm_5').querySelector('.bd-chip.issue')?.textContent).toBe('#12');
    // The repository shows because the environment has more than one.
    expect(card('itm_1').querySelector('.bd-chip.repo')?.textContent).toBe('api');
    expect(card('itm_6').querySelector('.bd-chip.diff')?.textContent).toBe('+120 −30');
    expect(card('itm_6').querySelector('.bd-chip.pr')?.textContent).toBe('#45');
    expect(card('itm_6').querySelector('.bd-ci.failure')).not.toBeNull();
    expect(card('itm_7').querySelector('.bd-signal')?.textContent).toBe('Cancelled: Superseded by W‑11.');
    // The latest tool call follows the running turn.
    store.applyEvent(2, { kind: 'turn.start', sessionId: 's3', turnId: 't' }, ENV);
    store.applyEvent(3, { kind: 'turn.event', sessionId: 's3', turnId: 't', event: { kind: 'tool-start', toolId: 'x', tool: 'Bash', summary: 'npm test', input: '' } }, ENV);
    expect(card('itm_3').querySelector('.bd-tool')?.textContent).toBe('Bash · npm test');
  });

  it('opens a card’s pull request without opening the item', () => {
    const { card, openItem, openExternal } = setup([item({ number: 6, status: 'review', pr: { number: 45, url: 'https://github.com/octo/web/pull/45', draft: false, lastPushedSha: 'x' } })]);
    (card('itm_6').querySelector('.bd-chip.pr') as HTMLButtonElement).click();
    expect(openExternal).toHaveBeenCalledWith('https://github.com/octo/web/pull/45');
    expect(openItem).not.toHaveBeenCalled();
  });

  it('hides the repository with a single one, and highlights the open item', () => {
    const { card, select, board } = setup([item({ number: 1, repo: 'web' })]);
    expect(card('itm_1').querySelector('.bd-chip.repo')).toBeNull();
    select('itm_1');
    board.render();
    expect(card('itm_1').classList.contains('selected')).toBe(true);
  });

  it('opens an item on click and Enter', () => {
    const { card, openItem } = setup([item({ number: 1 })]);
    card('itm_1').click();
    card('itm_1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(openItem).toHaveBeenCalledTimes(2);
    expect(openItem).toHaveBeenCalledWith('itm_1');
  });

  it('offers the actions the state machine allows in each card’s menu', async () => {
    const { card, daemon } = setup([
      item({ number: 1, status: 'backlog' }),
      item({ number: 2, status: 'queued', agent: 'implementer' }),
      item({ number: 3, status: 'running', sessionId: 's3' }),
      item({ number: 4, status: 'review' }),
      item({ number: 5, status: 'failed' }),
      item({ number: 6, status: 'done' }),
    ]);
    const open = (id: string): void => (card(id).querySelector('.bd-more') as HTMLButtonElement).click();
    open('itm_1');
    expect(menuItems()).toEqual(['open', 'assign:implementer', 'assign:reviewer', 'cancel', 'delete']);
    open('itm_2');
    expect(menuItems()).toEqual(['open', 'assign:reviewer', 'unassign', 'cancel']);
    open('itm_3');
    expect(menuItems()).toEqual(['open', 'stop', 'cancel']);
    open('itm_4');
    expect(menuItems()).toEqual(['open', 'accept', 'publish', 'cancel']);
    open('itm_5');
    expect(menuItems()).toEqual(['open', 'retry', 'delete']);
    open('itm_6');
    expect(menuItems()).toEqual(['open', 'delete']);

    open('itm_1');
    (document.querySelector('.menu [data-action="assign:reviewer"]') as HTMLButtonElement).click();
    await flush();
    expect(daemon).toHaveBeenCalledWith('item.assign', { itemId: 'itm_1', agent: 'reviewer' });
    expect(document.querySelector('.menu')).toBeNull();

    open('itm_2');
    (document.querySelector('.menu [data-action="unassign"]') as HTMLButtonElement).click();
    await flush();
    expect(daemon).toHaveBeenCalledWith('item.assign', { itemId: 'itm_2', agent: null });
  });

  it('does not offer Unassign for a queued item that already has a session, and assigns only that agent', () => {
    const { card, col, daemon, store } = setup([
      item({ number: 1, status: 'backlog', sessionId: 's1' }),
      item({ number: 2, status: 'queued', agent: 'implementer', sessionId: 's2' }),
    ]);
    store.applyEvent(2, { kind: 'session.upsert', session: session({ id: 's1', kind: 'worker', agent: 'reviewer' }) }, ENV);
    drag('dragstart', card('itm_2'));
    expect(col('backlog').dataset.drop).toBe('no');
    expect(col('ready').dataset.drop).toBe('ok');
    expect(drag('dragover', col('backlog').querySelector('.bd-list') as HTMLElement).defaultPrevented).toBe(false);
    drag('drop', col('backlog').querySelector('.bd-list') as HTMLElement, 999);
    expect(daemon).not.toHaveBeenCalled();
    (card('itm_2').querySelector('.bd-more') as HTMLButtonElement).click();
    expect(menuItems()).toEqual(['open', 'cancel']);
    (card('itm_1').querySelector('.bd-more') as HTMLButtonElement).click();
    expect(menuItems()).toEqual(['open', 'assign:reviewer', 'cancel', 'delete']);
  });

  it('arms Delete, and cancelling started work, on the first click', async () => {
    const { card, daemon } = setup([item({ number: 1, status: 'backlog' }), item({ number: 3, status: 'running', sessionId: 's3' })]);
    (card('itm_1').querySelector('.bd-more') as HTMLButtonElement).click();
    const del = document.querySelector('.menu [data-action="delete"]') as HTMLButtonElement;
    del.click();
    expect(del.classList.contains('armed')).toBe(true);
    expect(del.textContent).toBe('Confirm: delete W-1');
    expect(daemon).not.toHaveBeenCalledWith('item.delete', expect.anything());
    del.click();
    await flush();
    expect(daemon).toHaveBeenCalledWith('item.delete', { itemId: 'itm_1' });
    // Cancel on a backlog item runs at once; on running work it arms.
    (card('itm_1').querySelector('.bd-more') as HTMLButtonElement).click();
    (document.querySelector('.menu [data-action="cancel"]') as HTMLButtonElement).click();
    await flush();
    expect(daemon).toHaveBeenCalledWith('item.cancel', { itemId: 'itm_1' });
    (card('itm_3').querySelector('.bd-more') as HTMLButtonElement).click();
    const cancel = document.querySelector('.menu [data-action="cancel"]') as HTMLButtonElement;
    cancel.click();
    expect(daemon).not.toHaveBeenCalledWith('item.cancel', { itemId: 'itm_3' });
    cancel.click();
    await flush();
    expect(daemon).toHaveBeenCalledWith('item.cancel', { itemId: 'itm_3' });
  });

  it('moves between cards with the arrow keys, one tab stop for the board', () => {
    const { card } = setup([
      item({ number: 1, status: 'backlog' }),
      item({ number: 2, status: 'backlog' }),
      item({ number: 3, status: 'queued', agent: 'implementer' }),
    ]);
    const stops = [...document.querySelectorAll<HTMLElement>('.bd-card')].filter((c) => c.tabIndex === 0);
    expect(stops.map((c) => c.dataset.item)).toEqual(['itm_1']);
    card('itm_1').focus();
    card('itm_1').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(card('itm_2'));
    card('itm_2').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(card('itm_3'));
    expect(card('itm_3').tabIndex).toBe(0);
    expect(card('itm_1').tabIndex).toBe(-1);
    card('itm_3').dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    expect(menuItems()[0]).toBe('open');
  });

  it('reorders Backlog and Ready with Alt+arrows, optimistically, and resyncs when refused', async () => {
    const { card, daemon, ids, resync, say } = setup([item({ number: 1 }), item({ number: 2 }), item({ number: 3 })]);
    card('itm_3').focus();
    card('itm_3').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    expect(ids('backlog')).toEqual(['itm_1', 'itm_3', 'itm_2']);
    expect(daemon).toHaveBeenCalledWith('item.move', { itemId: 'itm_3', position: { before: 'itm_2' } });
    expect(document.activeElement).toBe(card('itm_3'));
    daemon.mockRejectedValueOnce(new Error('invalid-state'));
    card('itm_2').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    await flush();
    expect(say).toHaveBeenCalledWith("Couldn't move it: invalid-state");
    expect(resync).toHaveBeenCalled();
  });

  it('allows drops only where a transition exists, and outlines the columns that take the card', () => {
    const { card, col } = setup([item({ number: 1 }), item({ number: 2, status: 'running' })]);
    drag('dragstart', card('itm_1'));
    expect(col('backlog').dataset.drop).toBe('ok');
    expect(col('ready').dataset.drop).toBe('ok');
    expect(col('progress').dataset.drop).toBe('no');
    expect(col('review').dataset.drop).toBe('no');
    expect(drag('dragover', col('ready').querySelector('.bd-list') as HTMLElement).defaultPrevented).toBe(true);
    expect(drag('dragover', col('progress').querySelector('.bd-list') as HTMLElement).defaultPrevented).toBe(false);
    drag('dragend', card('itm_1'));
    expect(col('ready').dataset.drop).toBeUndefined();
    // Work that has started cannot be dragged at all.
    expect(card('itm_2').draggable).toBe(false);
    expect(card('itm_1').draggable).toBe(true);
  });

  it('assigns on a drop into Ready, straight away when one agent can take it', async () => {
    const { card, col, daemon } = setup([item({ number: 1 })], { agents: ['implementer'] });
    drag('dragstart', card('itm_1'));
    drag('drop', col('ready').querySelector('.bd-list') as HTMLElement);
    await flush();
    expect(daemon).toHaveBeenCalledWith('item.assign', { itemId: 'itm_1', agent: 'implementer' });
  });

  it('asks which agent when several could take the dropped item, then places it', async () => {
    const { card, col, daemon } = setup([item({ number: 1 }), item({ number: 2, status: 'queued', agent: 'implementer' })]);
    box(card('itm_2'), 100);
    drag('dragstart', card('itm_1'));
    drag('drop', col('ready').querySelector('.bd-list') as HTMLElement, 110);
    expect(document.querySelector('.menu-title')?.textContent).toBe('Assign W-1 to');
    expect(menuItems()).toEqual(['assign:implementer', 'assign:reviewer']);
    (document.querySelector('.menu [data-action="assign:reviewer"]') as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(daemon).toHaveBeenCalledWith('item.assign', { itemId: 'itm_1', agent: 'reviewer' });
    expect(daemon).toHaveBeenCalledWith('item.move', { itemId: 'itm_1', position: { before: 'itm_2' } });
  });

  it('does not reorder when assign or unassign fails', async () => {
    const { card, col, daemon, ids, say } = setup(
      [item({ number: 1, status: 'queued', agent: 'implementer' }), item({ number: 2 }), item({ number: 3, status: 'queued', agent: 'implementer' })],
      { agents: ['implementer'] },
    );
    box(card('itm_1'), 0);
    daemon.mockRejectedValueOnce(new Error('choose the repo before assigning'));
    drag('dragstart', card('itm_2'));
    drag('drop', col('ready').querySelector('.bd-list') as HTMLElement, 0);
    await flush();
    expect(daemon).toHaveBeenCalledWith('item.assign', { itemId: 'itm_2', agent: 'implementer' });
    expect(daemon).not.toHaveBeenCalledWith('item.move', expect.anything());
    expect(ids('backlog')).toEqual(['itm_2']);
    expect(ids('ready')).toEqual(['itm_1', 'itm_3']);
    expect(say).toHaveBeenCalledWith('W-2: choose the repo before assigning');

    daemon.mockClear();
    daemon.mockRejectedValueOnce(new Error('no'));
    box(card('itm_2'), 0);
    drag('dragstart', card('itm_3'));
    drag('drop', col('backlog').querySelector('.bd-list') as HTMLElement, 0);
    await flush();
    expect(daemon).toHaveBeenCalledWith('item.assign', { itemId: 'itm_3', agent: null });
    expect(daemon).not.toHaveBeenCalledWith('item.move', expect.anything());
    expect(ids('backlog')).toEqual(['itm_2']);
    expect(ids('ready')).toEqual(['itm_1', 'itm_3']);
  });

  it('unassigns on a drop into Backlog, and reorders within a column', async () => {
    const { card, col, daemon, ids } = setup([item({ number: 1 }), item({ number: 2 }), item({ number: 3, status: 'queued', agent: 'implementer' })]);
    drag('dragstart', card('itm_3'));
    drag('drop', col('backlog').querySelector('.bd-list') as HTMLElement, 999);
    await flush();
    expect(daemon).toHaveBeenCalledWith('item.assign', { itemId: 'itm_3', agent: null });
    box(card('itm_1'), 0);
    box(card('itm_2'), 50);
    drag('dragstart', card('itm_1'));
    drag('drop', col('backlog').querySelector('.bd-list') as HTMLElement, 999);
    expect(daemon).toHaveBeenCalledWith('item.move', { itemId: 'itm_1', position: { after: 'itm_2' } });
    expect(ids('backlog')).toEqual(['itm_2', 'itm_1']);
  });

  it('keeps focus on a card control while the board redraws, and restores the card when that control is rebuilt', () => {
    const { card, store } = setup([
      item({
        number: 3,
        status: 'running',
        agent: 'implementer',
        sessionId: 's3',
        pr: { number: 4, url: 'https://github.com/octo/web/pull/4', draft: false, lastPushedSha: 'abc' },
      }),
    ]);
    const pr = () => card('itm_3').querySelector('.bd-chip.pr') as HTMLButtonElement;
    card('itm_3').focus();
    pr().focus();
    store.applyEvent(2, { kind: 'capacity', agents: { implementer: { running: 1, max: 2 } }, workers: { running: 1, max: 3 }, paused: false }, ENV);
    expect(document.activeElement).toBe(pr());
    pr().focus();
    store.applyEvent(3, { kind: 'turn.start', sessionId: 's3', turnId: 't' }, ENV);
    store.applyEvent(4, { kind: 'turn.event', sessionId: 's3', turnId: 't', event: { kind: 'tool-start', toolId: 'x', tool: 'Read', summary: 'a.ts', input: '' } }, ENV);
    expect(document.activeElement).toBe(card('itm_3'));
  });

  it('keeps focus on a card when its column rebuilds', () => {
    const { card, store } = setup([item({ number: 3, status: 'running', agent: 'implementer', sessionId: 's3' })]);
    card('itm_3').focus();
    store.applyEvent(2, { kind: 'turn.start', sessionId: 's3', turnId: 't' }, ENV);
    store.applyEvent(3, { kind: 'turn.event', sessionId: 's3', turnId: 't', event: { kind: 'tool-start', toolId: 'x', tool: 'Read', summary: 'a.ts', input: '' } }, ENV);
    expect(document.activeElement).toBe(card('itm_3'));
  });

  it('creates items atop Backlog, and opens one with ⌘Enter', async () => {
    const { board, daemon, openItem, byId } = setup([]);
    expect(document.querySelector('.bd-empty')).not.toBeNull();
    board.create();
    const input = document.querySelector('.bd-new-input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    input.value = 'Add a usage section';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(daemon).toHaveBeenCalledWith('item.create', { title: 'Add a usage section', position: 'top' });
    expect(input.value).toBe('');
    input.value = 'Fix typos';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    await flush();
    expect(openItem).toHaveBeenCalledWith('itm_99', 'details');
    expect(document.querySelector('.bd-new-input')).toBeNull();
    byId('new').click();
    const again = document.querySelector('.bd-new-input') as HTMLInputElement;
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.bd-new-input')).toBeNull();
    expect(document.activeElement).toBe(byId('new'));
  });

  it('imports an issue from a search, or straight from a reference', async () => {
    const { board, daemon, openItem } = setup([]);
    board.importIssue();
    const input = document.querySelector('.bd-import-query') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    input.value = 'broken';
    input.dispatchEvent(new Event('input'));
    await flush();
    await flush();
    expect(daemon).toHaveBeenCalledWith('issue.search', { query: 'broken' });
    const picks = [...document.querySelectorAll<HTMLButtonElement>('.bd-import-pick')];
    expect(picks.map((p) => p.disabled)).toEqual([false, true]);
    expect(picks[1]?.textContent).toContain('Already W-2 (review)');
    picks[0]?.click();
    await flush();
    expect(daemon).toHaveBeenCalledWith('issue.import', { repo: 'octo/web', number: 12, position: 'top' });
    expect(openItem).toHaveBeenCalledWith('itm_50');
    expect(document.querySelector('.bd-import')).toBeNull();
    board.importIssue();
    const again = document.querySelector('.bd-import-query') as HTMLInputElement;
    again.value = 'https://github.com/octo/web/issues/7';
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(daemon).toHaveBeenCalledWith('issue.import', { repo: 'octo/web', number: 7, position: 'top' });
  });

  it('offers the next steps on an empty board, and placeholders before the environment loads', () => {
    const { toChat } = setup([]);
    const empty = document.querySelector('.bd-empty') as HTMLElement;
    expect(empty.textContent).toContain('No work items yet');
    ([...empty.querySelectorAll('button')].find((b) => b.textContent === 'Ask in Chat') as HTMLButtonElement).click();
    expect(toChat).toHaveBeenCalled();
    expect(document.querySelectorAll('.bd-hint')).toHaveLength(5);
    const loading = setup([], { snapshot: false });
    expect(document.querySelectorAll('.bd-skel').length).toBeGreaterThan(0);
    expect(loading.byId<HTMLButtonElement>('new').disabled).toBe(true);
  });

  it('shows capacity per agent, and Resume while the scheduler is paused', async () => {
    const { byId, daemon } = setup([], { paused: true });
    const caps = [...byId('cap').querySelectorAll('.bd-cap')].map((c) => c.textContent);
    expect(caps).toEqual(['implementer0/2', 'reviewer0/2', 'Workers1/3']);
    expect(byId('cap').title).toBe('implementer 0 of 2 · reviewer 0 of 2 · 1 of 3 workers busy');
    expect(byId('paused').classList.contains('hidden')).toBe(false);
    (byId('paused').querySelector('button') as HTMLButtonElement).click();
    await flush();
    expect(daemon).toHaveBeenCalledWith('scheduler.resume', {});
  });

  it('keeps Done to the latest twenty until Show all', () => {
    const done = Array.from({ length: 23 }, (_, i) => item({ number: i + 1, status: 'done', updatedAt: i }));
    const { ids } = setup(done);
    expect(ids('done')).toHaveLength(20);
    (document.querySelector('.bd-more-row button') as HTMLButtonElement).click();
    expect(ids('done')).toHaveLength(23);
  });
});
