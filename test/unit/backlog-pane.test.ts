// @vitest-environment jsdom

/**
 * The backlog pane lists backlog, queued and failed items in order,
 * reorders optimistically (drag and drop, Alt+arrows), creates items
 * inline, and imports GitHub issues.
 */

import { describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../../src/harness/daemon-protocol';
import { initBacklogPane, ordinal, parseIssueRef, statusLine } from '../../src/renderer/backlog-pane';
import { createInstanceStore } from '../../src/renderer/instance-store';
import { ENV, item, snap } from './v2-fixtures';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setup(items: WorkItem[], order = items.map((i) => i.id)) {
  document.body.innerHTML = `<div id="tray"></div><ul id="list"></ul><button id="add"></button><button id="imp"></button><button id="fin"></button>`;
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const resync = vi.fn();
  const store = createInstanceStore({ requestResync: resync });
  store.reset(ENV);
  store.applySnapshot(snap({ head: 1, items, order }), ENV);
  const daemon = vi.fn(async (op: string, args: Record<string, unknown>): Promise<unknown> => {
    if (op === 'item.create') return item({ number: 99, title: String(args.title) });
    if (op === 'issue.import') return item({ number: 50 });
    if (op === 'issue.search')
      return { issues: [{ repo: 'octo/web', number: 12, title: 'Broken link', state: 'open', labels: [], url: 'u', item: null }, { repo: 'octo/web', number: 13, title: 'Taken', state: 'open', labels: [], url: 'u', item: 'W-2 (review)' }] };
    return {};
  });
  const openItem = vi.fn();
  const say = vi.fn();
  const prefs = new Map<string, string>();
  const pane = initBacklogPane({
    els: { list: byId('list'), add: byId('add'), importBtn: byId('imp'), finished: byId('fin'), tray: byId('tray') },
    store,
    daemon: daemon as never,
    openItem,
    say,
    resync,
    prefs: { getItem: (k) => prefs.get(k) ?? null, setItem: (k, v) => void prefs.set(k, v) },
    debounceMs: 0,
  });
  pane.render();
  store.subscribe(() => pane.render());
  const ids = () => [...document.querySelectorAll<HTMLElement>('.bl-row')].map((r) => r.dataset.item);
  const rowOf = (id: string) => document.querySelector<HTMLElement>(`[data-item="${id}"]`) as HTMLElement;
  return { store, pane, daemon, openItem, say, resync, prefs, ids, rowOf, byId };
}

describe('backlog pane', () => {
  it('lists backlog, queued and failed items in order with their status lines', () => {
    const { ids, rowOf } = setup([
      item({ number: 1, status: 'queued', agent: 'implementer' }),
      item({ number: 2, status: 'running', agent: 'implementer' }),
      item({ number: 3, status: 'queued', agent: 'implementer', createdBy: 'orchestrator' }),
      item({ number: 4, status: 'failed', lastError: 'tests failed', agent: 'implementer' }),
      item({ number: 5, status: 'done' }),
      item({ number: 6, source: { kind: 'github-issue', repo: 'octo/web', number: 12, url: 'u', updatedAt: 1 } }),
    ]);
    expect(ids()).toEqual(['itm_1', 'itm_3', 'itm_4', 'itm_6']);
    expect(rowOf('itm_3').querySelector('.bl-status')?.textContent).toBe('queued · 2nd for implementer');
    expect(rowOf('itm_3').querySelector('.bl-mark')).not.toBeNull();
    const failed = rowOf('itm_4').querySelector('.bl-status') as HTMLElement;
    expect(failed.textContent).toBe('failed');
    expect(failed.title).toBe('tests failed');
    expect(rowOf('itm_6').querySelector('.bl-agent')?.textContent).toBe('Unassigned');
    expect(rowOf('itm_6').querySelector('.bl-issue')?.textContent).toBe('#12');
  });

  it('shows finished items on request and remembers it', () => {
    const { ids, byId, prefs } = setup([item({ number: 1 }), item({ number: 2, status: 'cancelled' })]);
    (byId('fin') as HTMLButtonElement).click();
    expect(ids()).toEqual(['itm_1', 'itm_2']);
    expect(prefs.get('puck.backlog.showFinished')).toBe('1');
  });

  it('moves the focused row with Alt+arrows, optimistically', async () => {
    const { ids, rowOf, daemon } = setup([item({ number: 1 }), item({ number: 2 }), item({ number: 3 })]);
    rowOf('itm_3').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    expect(ids()).toEqual(['itm_1', 'itm_3', 'itm_2']);
    expect(daemon).toHaveBeenCalledWith('item.move', { itemId: 'itm_3', position: { before: 'itm_2' } });
    expect(document.activeElement).toBe(rowOf('itm_3'));
    rowOf('itm_1').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    expect(daemon).toHaveBeenCalledTimes(1); // already first
  });

  it('drops a dragged row before or after the target', () => {
    const { ids, rowOf, daemon } = setup([item({ number: 1 }), item({ number: 2 }), item({ number: 3 })]);
    rowOf('itm_1').dispatchEvent(new Event('dragstart'));
    const target = rowOf('itm_3');
    target.getBoundingClientRect = () => ({ top: 0, height: 20, bottom: 20, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) });
    const drop = new Event('drop', { cancelable: true }) as Event & { clientY: number };
    Object.defineProperty(drop, 'clientY', { value: 15 });
    target.dispatchEvent(drop);
    expect(daemon).toHaveBeenCalledWith('item.move', { itemId: 'itm_1', position: { after: 'itm_3' } });
    expect(ids()).toEqual(['itm_2', 'itm_3', 'itm_1']);
  });

  it('resyncs when a move is refused', async () => {
    const { rowOf, daemon, resync, say } = setup([item({ number: 1 }), item({ number: 2 })]);
    daemon.mockRejectedValueOnce(new Error('invalid-state'));
    rowOf('itm_2').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    await flush();
    expect(say).toHaveBeenCalledWith("Couldn't move it: invalid-state");
    expect(resync).toHaveBeenCalled();
  });

  it('creates items inline, and opens one with ⌘Enter', async () => {
    const { pane, daemon, openItem } = setup([]);
    expect(document.querySelector('.bl-empty')).not.toBeNull();
    pane.create();
    const input = document.querySelector('.bl-new') as HTMLInputElement;
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
    expect(document.querySelector('.bl-new')).toBeNull();
  });

  it('imports an issue from a search, or straight from a reference', async () => {
    const { pane, daemon, openItem } = setup([]);
    pane.importIssue();
    const input = document.querySelector('.bl-import-query') as HTMLInputElement;
    input.value = 'broken';
    input.dispatchEvent(new Event('input'));
    await flush();
    await flush();
    expect(daemon).toHaveBeenCalledWith('issue.search', { query: 'broken' });
    const picks = [...document.querySelectorAll<HTMLButtonElement>('.bl-import-pick')];
    expect(picks.map((p) => p.disabled)).toEqual([false, true]);
    picks[0]?.click();
    await flush();
    expect(daemon).toHaveBeenCalledWith('issue.import', { repo: 'octo/web', number: 12, position: 'top' });
    expect(openItem).toHaveBeenCalledWith('itm_50');
    pane.importIssue();
    const again = document.querySelector('.bl-import-query') as HTMLInputElement;
    again.value = 'https://github.com/octo/web/issues/7';
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(daemon).toHaveBeenCalledWith('issue.import', { repo: 'octo/web', number: 7, position: 'top' });
  });

  it('parses issue references and ordinals', () => {
    expect(parseIssueRef('octo/web#12')).toEqual({ repo: 'octo/web', number: 12 });
    expect(parseIssueRef('octo/web # 3')).toEqual({ repo: 'octo/web', number: 3 });
    expect(parseIssueRef('https://github.com/octo/web/issues/9#issuecomment-1')).toEqual({ repo: 'octo/web', number: 9 });
    expect(parseIssueRef('fix the login')).toBeNull();
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
    expect(statusLine(item({ status: 'queued' }), [])).toBe('queued');
  });
});
