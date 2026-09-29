/**
 * The right pane: work in progress.
 *
 * - Needs input (gold halo), Running (gold pulse, elapsed time, and the
 *   latest tool call as a subtitle, oldest first), Review (emerald dot,
 *   `+ins −del`, the pull request with its CI state, newest first).
 * - Footer: capacity per agent ("implementer 2/3 · reviewer 0/1 ·
 *   workers 2/4"), and while the scheduler is paused a Paused badge with
 *   Resume.
 * - A click opens work detail; the row menu offers Stop, Accept, Publish
 *   and Cancel where the item's status allows them (Cancel on a running
 *   item arms on first click).
 *
 * Context in, controller out; no DOM lookups.
 */

import type { OpArgs, OpResult, RendererOp, WorkItem } from '../harness/daemon-protocol';
import { formatElapsed } from '../harness/lifecycle';
import { armDelete, el } from './dom';
import type { InstanceStore } from './instance-store';
import { button, errText } from './util';

export interface WorkPaneElements {
  needs: HTMLElement;
  running: HTMLElement;
  review: HTMLElement;
  /** Wraps each section so empty ones hide: `[data-section="needs"]` etc. */
  sections: HTMLElement;
  empty: HTMLElement;
  capacity: HTMLElement;
  paused: HTMLElement;
}

export interface WorkPaneContext {
  els: WorkPaneElements;
  store: InstanceStore;
  daemon<K extends RendererOp>(op: K, args: OpArgs<K>): Promise<OpResult<K>>;
  openItem(itemId: string): void;
  say(text: string): void;
  now?(): number;
}

/** "implementer 2/3 · reviewer 0/1 · workers 2/4" */
export function capacityText(cap: { agents: Record<string, { running: number; max: number }>; workers: { running: number; max: number } }): string {
  const agents = Object.entries(cap.agents)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, c]) => `${name} ${c.running}/${c.max}`);
  return [...agents, `workers ${cap.workers.running}/${cap.workers.max}`].join(' · ');
}

export function diffText(item: WorkItem): string {
  const d = item.result?.diffStat;
  return d ? `+${d.insertions} −${d.deletions}` : '';
}

type MenuAction = 'stop' | 'accept' | 'publish' | 'cancel';

function actionsFor(item: WorkItem): MenuAction[] {
  switch (item.status) {
    case 'running':
      return ['stop', 'cancel'];
    case 'needs-input':
      return ['cancel'];
    case 'review':
      return ['accept', 'publish', 'cancel'];
    default:
      return [];
  }
}

const LABEL: Record<MenuAction, string> = { stop: 'Stop', accept: 'Accept', publish: 'Publish', cancel: 'Cancel' };

export function initWorkPane(ctx: WorkPaneContext) {
  const { els, store } = ctx;
  const now = ctx.now ?? Date.now;
  let openMenu: HTMLElement | null = null;

  function closeMenu(): boolean {
    if (!openMenu) return false;
    openMenu.remove();
    openMenu = null;
    return true;
  }

  async function run(item: WorkItem, action: MenuAction): Promise<void> {
    closeMenu();
    try {
      if (action === 'stop') {
        if (item.sessionId) await ctx.daemon('session.interrupt', { sessionId: item.sessionId });
      } else if (action === 'accept') await ctx.daemon('item.accept', { itemId: item.id });
      else if (action === 'publish') await ctx.daemon('item.publish', { itemId: item.id });
      else await ctx.daemon('item.cancel', { itemId: item.id });
      ctx.say('');
    } catch (err) {
      ctx.say(`W-${item.number}: ${errText(err)}`);
    }
  }

  function menu(item: WorkItem, anchor: HTMLElement): void {
    closeMenu();
    const box = el('div', 'wp-menu');
    box.setAttribute('role', 'menu');
    for (const action of actionsFor(item)) {
      const b = button('wp-menu-item', LABEL[action]);
      b.setAttribute('role', 'menuitem');
      b.dataset.action = action;
      if (action === 'cancel' && item.status === 'running') armDelete(b, () => run(item, action));
      else
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          void run(item, action);
        });
      box.appendChild(b);
    }
    anchor.appendChild(box);
    openMenu = box;
    (box.querySelector('button') as HTMLButtonElement | null)?.focus();
  }

  function startedAt(item: WorkItem): number {
    const turn = item.sessionId ? store.inflightFor(item.sessionId)[0] : undefined;
    return turn?.startedAt ?? item.updatedAt;
  }

  function row(item: WorkItem, kind: 'needs' | 'running' | 'review'): HTMLLIElement {
    const li = el('li', `wp-row ${kind}`);
    li.dataset.item = item.id;
    li.tabIndex = 0;
    li.appendChild(el('span', `wp-dot ${kind}`));
    const main = el('div', 'wp-main');
    const top = el('div', 'wp-top');
    top.append(el('span', 'wp-id', `W-${item.number}`), el('span', 'wp-title', item.title));
    main.appendChild(top);
    const sub = el('div', 'wp-sub');
    if (kind === 'running') {
      const elapsed = el('span', 'wp-elapsed', formatElapsed(now() - startedAt(item)));
      elapsed.dataset.since = String(startedAt(item));
      sub.appendChild(elapsed);
      const tool = item.sessionId ? store.lastTool(item.sessionId) : null;
      sub.appendChild(el('span', 'wp-tool', tool ?? `${item.agent ?? ''} working…`.trim()));
    } else if (kind === 'needs') {
      sub.appendChild(el('span', 'wp-ask', item.pendingAsk?.routedTo === 'user' ? 'waiting on you' : 'waiting on the orchestrator'));
    } else {
      const diff = diffText(item);
      if (diff) sub.appendChild(el('span', 'wp-diff', diff));
      if (item.pr) {
        const pr = el('span', `wp-pr${item.pr.state ? ` ${item.pr.state}` : ''}`, `PR #${item.pr.number}`);
        if (item.pr.checks) {
          const ci = el('span', `wp-ci ${item.pr.checks.state}`);
          ci.title = `Checks: ${item.pr.checks.state}`;
          pr.appendChild(ci);
        }
        sub.appendChild(pr);
      }
    }
    main.appendChild(sub);
    li.appendChild(main);
    if (actionsFor(item).length) {
      const more = button('icon-btn small wp-more', '⋯');
      more.setAttribute('aria-label', `Actions for W-${item.number}`);
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (openMenu && li.contains(openMenu)) closeMenu();
        else menu(item, li);
      });
      li.appendChild(more);
    }
    li.addEventListener('click', () => ctx.openItem(item.id));
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && ev.target === li) ctx.openItem(item.id);
    });
    return li;
  }

  function fill(list: HTMLElement, items: WorkItem[], kind: 'needs' | 'running' | 'review'): void {
    list.textContent = '';
    for (const item of items) list.appendChild(row(item, kind));
    const section = list.closest<HTMLElement>('[data-section]');
    section?.classList.toggle('hidden', items.length === 0);
  }

  function render(): void {
    closeMenu();
    const items = store.items();
    const needs = items.filter((i) => i.status === 'needs-input');
    const running = items.filter((i) => i.status === 'running').sort((a, b) => startedAt(a) - startedAt(b));
    const review = items.filter((i) => i.status === 'review').sort((a, b) => b.updatedAt - a.updatedAt);
    fill(els.needs, needs, 'needs');
    fill(els.running, running, 'running');
    fill(els.review, review, 'review');
    const ready = store.hasSnapshot();
    els.empty.classList.toggle('hidden', !ready || needs.length + running.length + review.length > 0);
    const cap = store.capacity();
    els.capacity.textContent = ready ? capacityText(cap) : '';
    els.paused.textContent = '';
    els.paused.classList.toggle('hidden', !(ready && cap.paused));
    if (ready && cap.paused) {
      els.paused.appendChild(el('span', 'wp-paused-badge', 'Paused'));
      const resume = button('btn-ghost wp-resume', 'Resume');
      resume.addEventListener('click', async () => {
        resume.disabled = true;
        try {
          await ctx.daemon('scheduler.resume', {});
        } catch (err) {
          ctx.say(errText(err));
          resume.disabled = false;
        }
      });
      els.paused.appendChild(resume);
    }
  }

  /** Move the running rows' elapsed times without a rebuild. */
  function tick(at: number): void {
    for (const node of els.running.querySelectorAll<HTMLElement>('.wp-elapsed')) {
      node.textContent = formatElapsed(at - Number(node.dataset.since));
    }
  }

  return {
    render,
    tick,
    closeMenu,
    /** True while something runs (the ticker keeps going). */
    busy: (): boolean => store.items().some((i) => i.status === 'running'),
  };
}

export type WorkPane = ReturnType<typeof initWorkPane>;
