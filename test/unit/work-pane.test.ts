// @vitest-environment jsdom

/**
 * The work pane groups in-progress items (needs input, running, review),
 * shows capacity and the paused state, and runs the row actions.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Capacity, WorkItem } from '../../src/harness/daemon-protocol';
import { createInstanceStore } from '../../src/renderer/instance-store';
import { capacityText, initWorkPane } from '../../src/renderer/work-pane';
import { ENV, item, snap } from './v2-fixtures';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const NOW = 10_000_000;

function setup(items: WorkItem[], capacity?: Capacity) {
  document.body.innerHTML = `
    <div id="secs">
      <section data-section="needs"><ul id="needs"></ul></section>
      <section data-section="running"><ul id="running"></ul></section>
      <section data-section="review"><ul id="review"></ul></section>
    </div>
    <p id="empty"></p><p id="cap"></p><div id="paused"></div>`;
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const store = createInstanceStore({ requestResync: () => undefined });
  store.reset(ENV);
  store.applySnapshot(snap({ head: 1, items, ...(capacity ? { capacity } : {}) }), ENV);
  const daemon = vi.fn(async () => ({}));
  const openItem = vi.fn();
  const say = vi.fn();
  const pane = initWorkPane({
    els: { needs: byId('needs'), running: byId('running'), review: byId('review'), sections: byId('secs'), empty: byId('empty'), capacity: byId('cap'), paused: byId('paused') },
    store,
    daemon: daemon as never,
    openItem,
    say,
    now: () => NOW,
  });
  pane.render();
  const ids = (list: string) => [...byId(list).querySelectorAll<HTMLElement>('.wp-row')].map((r) => r.dataset.item);
  return { store, pane, daemon, openItem, say, ids, byId };
}

describe('work pane', () => {
  it('groups items into needs input, running (oldest first) and review (newest first)', () => {
    const { ids, byId } = setup([
      item({ number: 1, status: 'running', updatedAt: NOW - 120_000, sessionId: 'ses_1', agent: 'implementer' }),
      item({ number: 2, status: 'running', updatedAt: NOW - 600_000 }),
      item({ number: 3, status: 'needs-input', pendingAsk: { askId: 'a', routedTo: 'user' } }),
      item({ number: 4, status: 'review', updatedAt: 5, result: { summary: '', commits: [], diffStat: { files: 2, insertions: 120, deletions: 30, text: '' }, uncommitted: [], interrupted: false, endedAt: 5 } }),
      item({ number: 5, status: 'review', updatedAt: 9, pr: { number: 45, url: 'u', draft: true, lastPushedSha: 'x', state: 'open', checks: { sha: 'x', state: 'failure', failing: [] } } }),
      item({ number: 6, status: 'backlog' }),
    ]);
    expect(ids('needs')).toEqual(['itm_3']);
    expect(ids('running')).toEqual(['itm_2', 'itm_1']);
    expect(ids('review')).toEqual(['itm_5', 'itm_4']);
    const first = byId('running').querySelector('.wp-row') as HTMLElement;
    expect(first.querySelector('.wp-elapsed')?.textContent).toBe('10m 00s');
    expect(byId('needs').querySelector('.wp-ask')?.textContent).toBe('waiting on you');
    const review = byId('review');
    expect(review.querySelector('[data-item="itm_4"] .wp-diff')?.textContent).toBe('+120 −30');
    expect(review.querySelector('[data-item="itm_5"] .wp-pr')?.textContent).toBe('PR #45');
    expect(review.querySelector('[data-item="itm_5"] .wp-ci')?.className).toBe('wp-ci failure');
    expect(byId('empty').classList.contains('hidden')).toBe(true);
  });

  it('shows the latest tool as the running subtitle and ticks elapsed time', () => {
    const { store, pane, byId } = setup([item({ number: 1, status: 'running', sessionId: 'ses_1', updatedAt: NOW })]);
    store.applyEvent(2, { kind: 'turn.start', sessionId: 'ses_1', turnId: 't' }, ENV);
    store.applyEvent(3, { kind: 'turn.event', sessionId: 'ses_1', turnId: 't', event: { kind: 'tool-start', toolId: 'a', tool: 'Bash', summary: 'npm test', input: '' } }, ENV);
    pane.render();
    expect(byId('running').querySelector('.wp-tool')?.textContent).toBe('Bash · npm test');
    const since = Number((byId('running').querySelector('.wp-elapsed') as HTMLElement).dataset.since);
    pane.tick(since + 65_000);
    expect(byId('running').querySelector('.wp-elapsed')?.textContent).toBe('1m 05s');
    expect(pane.busy()).toBe(true);
  });

  it('hides empty sections and says when nothing is in progress', () => {
    const { byId } = setup([item({ number: 1 })]);
    expect(byId('needs').closest('section')?.classList.contains('hidden')).toBe(true);
    expect(byId('empty').classList.contains('hidden')).toBe(false);
  });

  it('shows capacity and resumes a paused scheduler', async () => {
    const { byId, daemon } = setup([], { agents: { reviewer: { running: 0, max: 1 }, implementer: { running: 2, max: 3 } }, workers: { running: 2, max: 4 }, paused: true });
    expect(byId('cap').textContent).toBe('implementer 2/3 · reviewer 0/1 · workers 2/4');
    expect(byId('paused').querySelector('.wp-paused-badge')?.textContent).toBe('Paused');
    (byId('paused').querySelector('.wp-resume') as HTMLButtonElement).click();
    await flush();
    expect(daemon).toHaveBeenCalledWith('scheduler.resume', {});
    expect(capacityText({ agents: {}, workers: { running: 0, max: 1 } })).toBe('workers 0/1');
  });

  it('opens work detail on click and runs row actions from the menu', async () => {
    const { byId, daemon, openItem } = setup([
      item({ number: 1, status: 'running', sessionId: 'ses_1' }),
      item({ number: 2, status: 'review' }),
    ]);
    const running = byId('running').querySelector('.wp-row') as HTMLElement;
    running.click();
    expect(openItem).toHaveBeenCalledWith('itm_1');
    (running.querySelector('.wp-more') as HTMLButtonElement).click();
    const actions = [...running.querySelectorAll<HTMLButtonElement>('.wp-menu-item')];
    expect(actions.map((a) => a.textContent)).toEqual(['Stop', 'Cancel']);
    actions[1]?.click(); // arms
    expect(daemon).not.toHaveBeenCalled();
    expect(actions[1]?.textContent).toBe('Confirm?');
    actions[0]?.click();
    await flush();
    expect(daemon).toHaveBeenCalledWith('session.interrupt', { sessionId: 'ses_1' });
    const review = byId('review').querySelector('.wp-row') as HTMLElement;
    (review.querySelector('.wp-more') as HTMLButtonElement).click();
    const labels = [...review.querySelectorAll<HTMLButtonElement>('.wp-menu-item')].map((a) => a.textContent);
    expect(labels).toEqual(['Accept', 'Publish', 'Cancel']);
    (review.querySelector('[data-action="publish"]') as HTMLButtonElement).click();
    await flush();
    expect(daemon).toHaveBeenCalledWith('item.publish', { itemId: 'itm_2' });
    expect(openItem).toHaveBeenCalledTimes(1);
  });
});
