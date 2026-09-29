/**
 * The Board view: the environment's work items as a Kanban board, one
 * column per stage of the item state machine (see board-model.ts).
 *
 * - Cards: `W-n`, the title, the agent, the repository when the
 *   environment has more than one, and the status signals: a question
 *   waiting (gold, prominent), the running clock and latest tool call, the
 *   queue position, attempts, the diff and the pull request with its CI
 *   state, the failure or cancel reason. A click or Enter opens the item
 *   in the side sheet; the open item's card is highlighted.
 * - "…" (or Shift+F10 on a focused card) opens the actions the state
 *   machine allows: Assign (one entry per agent), Unassign, Stop, Accept,
 *   Publish, Retry, Cancel and Delete. Delete, and cancelling started
 *   work, arm on the first click.
 * - Keyboard: one tab stop for the cards; arrows move between cards and
 *   columns, Home and End jump within a column, Alt+↑/↓ reorders Backlog
 *   and Ready.
 * - Drag and drop only where a transition exists: reorder within Backlog
 *   or Ready, Backlog → Ready assigns (an agent picker when several could
 *   take it), Ready → Backlog unassigns. While dragging, the columns that
 *   accept the card are outlined and the rest dim.
 * - Closed (failed and cancelled) is a narrow rail with its counts until
 *   expanded; Done shows its latest 20 until "Show all".
 * - The header: agent capacity, the paused scheduler with Resume, Import
 *   issue (a search popover over the environment's repositories, or
 *   `owner/name#12` and issue URLs) and New item (⌘N: a title field atop
 *   Backlog; Enter adds, ⌘Enter adds and opens).
 *
 * Context in, controller out; no DOM lookups.
 */

import type { IssueHit, ItemPosition, OpArgs, OpResult, RendererOp, WorkItem } from '../harness/daemon-protocol';
import { formatElapsed } from '../harness/lifecycle';
import {
  armsFirst,
  assignable,
  CARD_ACTIONS,
  canDrag,
  capacitySlots,
  capacityText,
  columnItems,
  COLUMNS,
  columnOf,
  diffText,
  dropAction,
  parseIssueRef,
  queueLine,
  type CardAction,
  type ColumnId,
} from './board-model';
import { el } from './dom';
import type { InstanceStore } from './instance-store';
import { closePopup, openMenu, openPopover, popupAnchor, type MenuEntry } from './popup';
import { COLUMN_ICON, statusIcon } from './status-icons';
import { button, errText } from './util';

export interface BoardElements {
  columns: HTMLElement;
  capacity: HTMLElement;
  paused: HTMLElement;
  newBtn: HTMLButtonElement;
  importBtn: HTMLButtonElement;
}

export interface BoardContext {
  els: BoardElements;
  store: InstanceStore;
  daemon<K extends RendererOp>(op: K, args: OpArgs<K>): Promise<OpResult<K>>;
  openItem(itemId: string, tab?: 'details'): void;
  /** The item open in the side sheet (its card is highlighted). */
  selected(): string | null;
  /** Switch to the Chat view (the empty board's "Ask the orchestrator"). */
  toChat(): void;
  /** A card's pull request link. */
  openExternal(url: string): void;
  say(text: string): void;
  /** An optimistic reorder could not be saved: re-read the environment. */
  resync(): void;
  prefs?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Search debounce (tests shorten it). */
  debounceMs?: number;
  now?(): number;
}

const CLOSED_KEY = 'puck.board.closedOpen';
const DONE_LIMIT = 20;

const ACTION_LABEL: Record<Exclude<CardAction, 'assign'>, string> = {
  unassign: 'Unassign',
  stop: 'Stop the turn',
  accept: 'Accept',
  publish: 'Publish a pull request',
  retry: 'Retry',
  cancel: 'Cancel item',
  delete: 'Delete',
};

interface ColumnParts {
  section: HTMLElement;
  list: HTMLElement;
  count: HTMLElement;
  /** New-item field slot (Backlog only). */
  slot: HTMLElement | null;
  built: string;
}

export function initBoard(ctx: BoardContext) {
  const { els, store } = ctx;
  const now = ctx.now ?? Date.now;
  const cols = new Map<ColumnId, ColumnParts>();
  let closedOpen = false;
  try {
    closedOpen = ctx.prefs?.getItem(CLOSED_KEY) === '1';
  } catch {
    closedOpen = false;
  }
  let doneAll = false;
  let active: string | null = null;
  let dragging: WorkItem | null = null;
  let creating: HTMLInputElement | null = null;
  let focusAfter: string | null = null;

  /* ---------- Structure (built once) ---------- */

  for (const c of COLUMNS) {
    const section = el('section', `bd-col col-${c.id}`);
    section.dataset.col = c.id;
    const head = el('header', 'bd-col-head');
    const icon = el('span', `bd-col-icon col-${c.id}`);
    icon.innerHTML = COLUMN_ICON[c.id];
    const title = el('h3', 'bd-col-title', c.title);
    title.id = `bd-col-${c.id}`;
    const count = el('span', 'bd-col-count', '0');
    head.append(icon, title, count);
    section.setAttribute('aria-labelledby', title.id);
    const list = el('ul', 'bd-list');
    list.setAttribute('aria-labelledby', title.id);
    let slot: HTMLElement | null = null;
    if (c.id === 'backlog') {
      slot = el('div', 'bd-slot');
      section.append(head, slot, list);
    } else section.append(head, list);
    if (c.id === 'closed') {
      const fold = button('icon-btn bd-fold');
      fold.innerHTML = '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>';
      fold.setAttribute('aria-label', 'Collapse Closed');
      fold.addEventListener('click', () => setClosed(false));
      head.appendChild(fold);
      const rail = button('bd-rail');
      rail.setAttribute('aria-label', 'Show closed items');
      rail.addEventListener('click', () => setClosed(true));
      section.appendChild(rail);
    }
    wireDrop(section, c.id);
    els.columns.appendChild(section);
    cols.set(c.id, { section, list, count, slot, built: '' });
  }

  function setClosed(open: boolean): void {
    closedOpen = open;
    try {
      ctx.prefs?.setItem(CLOSED_KEY, open ? '1' : '0');
    } catch {
      /* a convenience */
    }
    render();
    if (open) (cols.get('closed')?.list.querySelector<HTMLElement>('.bd-card') ?? cols.get('closed')?.section.querySelector<HTMLElement>('.bd-fold'))?.focus();
    else cols.get('closed')?.section.querySelector<HTMLElement>('.bd-rail')?.focus();
  }

  /* ---------- Data helpers ---------- */

  function agents(): string[] {
    return Object.keys(store.capacity().agents).sort();
  }

  function multiRepo(): boolean {
    return (store.state()?.repos.length ?? 0) > 1;
  }

  function startedAt(item: WorkItem): number {
    const turn = item.sessionId ? store.inflightFor(item.sessionId)[0] : undefined;
    return turn?.startedAt ?? item.updatedAt;
  }

  function latestTool(item: WorkItem): string {
    return (item.sessionId ? store.lastTool(item.sessionId) : null) ?? 'Working…';
  }

  /* ---------- Actions ---------- */

  async function run(item: WorkItem, action: CardAction, agent?: string): Promise<void> {
    try {
      switch (action) {
        case 'assign':
          await ctx.daemon('item.assign', { itemId: item.id, agent: agent ?? null });
          break;
        case 'unassign':
          await ctx.daemon('item.assign', { itemId: item.id, agent: null });
          break;
        case 'stop':
          if (item.sessionId) await ctx.daemon('session.interrupt', { sessionId: item.sessionId });
          break;
        case 'accept':
          await ctx.daemon('item.accept', { itemId: item.id });
          break;
        case 'publish': {
          const res = await ctx.daemon('item.publish', { itemId: item.id });
          ctx.say(`Published: ${res.prUrl}`);
          return;
        }
        case 'retry':
          await ctx.daemon('item.retry', { itemId: item.id });
          break;
        case 'cancel':
          await ctx.daemon('item.cancel', { itemId: item.id });
          break;
        case 'delete':
          await ctx.daemon('item.delete', { itemId: item.id });
          break;
      }
      ctx.say('');
    } catch (err) {
      ctx.say(`W-${item.number}: ${errText(err)}`);
    }
  }

  /** The "…" menu entries for an item: Open, then what its status allows. */
  function menuEntries(item: WorkItem): MenuEntry[] {
    const entries: MenuEntry[] = [{ label: 'Open', hint: '↵', action: 'open', run: () => ctx.openItem(item.id) }];
    let grouped = false;
    for (const action of CARD_ACTIONS[item.status]) {
      if (action === 'assign') {
        for (const agent of assignable(item, agents())) {
          entries.push({ label: `${item.status === 'queued' ? 'Reassign' : 'Assign'} to ${agent}`, action: `assign:${agent}`, group: !grouped, run: () => run(item, 'assign', agent) });
          grouped = true;
        }
        continue;
      }
      const destructive = action === 'cancel' || action === 'delete';
      entries.push({
        label: ACTION_LABEL[action],
        hint: action === 'unassign' ? 'to Backlog' : undefined,
        action,
        danger: destructive,
        confirm: armsFirst(action, item.status) ? `Confirm: ${action === 'delete' ? 'delete' : 'cancel'} W-${item.number}` : undefined,
        group: destructive ? !entries.some((e) => e.danger) : !grouped,
        run: () => run(item, action),
      });
      if (!destructive) grouped = true;
    }
    return entries;
  }

  function openCardMenu(item: WorkItem, anchor: HTMLElement): void {
    if (popupAnchor() === anchor) {
      closePopup();
      return;
    }
    openMenu(anchor, menuEntries(item), { label: `Actions for W-${item.number}` });
  }

  /** Pick an agent for a Backlog item dropped on Ready (or assign straight away when only one can take it). */
  function assignPicked(item: WorkItem, position: ItemPosition | null, at: DOMRect | null): void {
    const choices = assignable(item, agents());
    const finish = async (agent: string): Promise<void> => {
      await run(item, 'assign', agent);
      if (position) await move(item.id, position);
    };
    if (!choices.length) {
      ctx.say(`No agent in this environment can take W-${item.number}.`);
      return;
    }
    if (choices.length === 1) {
      void finish(choices[0] as string);
      return;
    }
    openMenu(
      null,
      choices.map((agent) => ({ label: agent, action: `assign:${agent}`, run: () => finish(agent) })),
      { label: `Assign W-${item.number} to`, title: `Assign W-${item.number} to`, at: at ?? undefined, align: 'start' },
    );
  }

  async function move(itemId: string, position: ItemPosition): Promise<void> {
    store.moveLocal(itemId, position);
    try {
      await ctx.daemon('item.move', { itemId, position });
    } catch (err) {
      ctx.say(`Couldn't move it: ${errText(err)}`);
      ctx.resync();
    }
  }

  /* ---------- Cards ---------- */

  function chip(cls: string, text: string, title?: string): HTMLElement {
    const c = el('span', `bd-chip ${cls}`, text);
    if (title) c.title = title;
    return c;
  }

  function signal(item: WorkItem, all: WorkItem[]): HTMLElement | null {
    switch (item.status) {
      case 'needs-input': {
        const mine = item.pendingAsk?.routedTo === 'user';
        const s = el('div', `bd-signal sig-ask${mine ? ' mine' : ''}`);
        s.append(el('span', 'bd-signal-dot'), el('span', 'bd-signal-text', mine ? 'Needs your input' : 'Asked the orchestrator'));
        return s;
      }
      case 'running': {
        const s = el('div', 'bd-signal sig-running');
        const since = startedAt(item);
        const clock = el('span', 'bd-elapsed', formatElapsed(now() - since));
        clock.dataset.since = String(since);
        s.append(el('span', 'bd-signal-dot'), clock, el('span', 'bd-tool', latestTool(item)));
        return s;
      }
      case 'queued': {
        const s = el('div', 'bd-signal sig-queued');
        s.appendChild(el('span', 'bd-signal-text', queueLine(item, all)));
        return s;
      }
      case 'failed':
      case 'cancelled': {
        const reason = item.status === 'failed' ? item.lastError : item.cancelReason;
        const s = el('div', `bd-signal sig-${item.status}`);
        // A non-breaking hyphen keeps "W-11" on one line.
        s.appendChild(el('span', 'bd-signal-text', `${item.status === 'failed' ? 'Failed' : 'Cancelled'}${reason ? `: ${reason.replace(/\bW-(?=\d)/g, 'W\u2011')}` : ''}`));
        if (reason) s.title = reason;
        return s;
      }
      default:
        return null;
    }
  }

  function card(item: WorkItem, all: WorkItem[]): HTMLLIElement {
    const li = el('li', `bd-card status-${item.status}${item.status === 'needs-input' && item.pendingAsk?.routedTo === 'user' ? ' needs-you' : ''}`);
    li.dataset.item = item.id;
    li.tabIndex = -1;
    li.draggable = canDrag(item.status);
    const agent = item.agent ?? 'Unassigned';
    li.setAttribute('aria-label', `W-${item.number} ${item.title}, ${item.status.replace('-', ' ')}, ${agent}`);

    const top = el('div', 'bd-card-top');
    const id = el('span', 'bd-id', `W-${item.number}`);
    top.appendChild(id);
    if (item.createdBy === 'orchestrator') {
      const mark = el('span', 'bd-by');
      mark.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3 20 12 12 21 4 12Z" /></svg>';
      mark.title = 'Created by the orchestrator';
      top.appendChild(mark);
    }
    if (item.source) top.appendChild(chip('issue', `#${item.source.number}`, `${item.source.repo}#${item.source.number}`));
    top.appendChild(el('span', 'spacer'));
    const more = button('bd-more');
    more.tabIndex = -1;
    more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></svg>';
    more.setAttribute('aria-label', `Actions for W-${item.number}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openCardMenu(item, more);
    });
    top.appendChild(more);

    const title = el('div', 'bd-title', item.title);
    li.append(top, title);
    const sig = signal(item, all);
    if (sig) li.appendChild(sig);

    const meta = el('div', 'bd-meta');
    const who = el('span', `bd-agent${item.agent ? '' : ' none'}`);
    if (item.agent) who.appendChild(el('span', 'bd-agent-mark', item.agent[0]?.toUpperCase() ?? '?'));
    who.appendChild(document.createTextNode(agent));
    meta.appendChild(who);
    if (multiRepo() && item.repo) meta.appendChild(chip('repo', item.repo, 'Repository'));
    if (item.attempts > 1 && item.status !== 'done') meta.appendChild(chip('attempts', `Attempt ${item.attempts}`));
    const diff = diffText(item);
    if (diff && (item.status === 'review' || item.status === 'done')) meta.appendChild(chip('diff', diff, `${item.result?.diffStat.files ?? 0} files changed`));
    if (item.pr) {
      const { url, number, checks } = item.pr;
      const state = item.pr.state === 'merged' ? 'merged' : item.pr.state === 'closed' ? 'closed' : item.pr.draft ? 'draft' : 'open';
      const pr = button(`bd-chip pr ${state}`, `#${number}`);
      pr.tabIndex = -1;
      pr.title = `Open pull request #${number} on GitHub (${state}${checks ? `, checks ${checks.state}` : ''})`;
      pr.prepend(statusIcon('pr'));
      if (checks) pr.appendChild(el('span', `bd-ci ${checks.state}`));
      pr.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ctx.openExternal(url);
      });
      meta.appendChild(pr);
    }
    li.appendChild(meta);

    li.addEventListener('click', () => ctx.openItem(item.id));
    li.addEventListener('focus', () => setActive(item.id));
    li.addEventListener('keydown', (ev) => onCardKey(ev, item, li));
    li.addEventListener('dragstart', (ev) => {
      dragging = item;
      li.classList.add('dragging');
      ev.dataTransfer?.setData('text/plain', `W-${item.number}`);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      for (const [id, parts] of cols) parts.section.dataset.drop = dropAction(item.status, id) ? 'ok' : 'no';
      els.columns.classList.add('dragging');
      closePopup();
    });
    li.addEventListener('dragend', endDrag);
    return li;
  }

  /* ---------- Keyboard ---------- */

  function visibleCards(): HTMLElement[][] {
    return COLUMNS.filter((c) => c.id !== 'closed' || closedOpen).map((c) => [...(cols.get(c.id)?.list.querySelectorAll<HTMLElement>('.bd-card') ?? [])]);
  }

  function setActive(itemId: string): void {
    active = itemId;
    for (const node of els.columns.querySelectorAll<HTMLElement>('.bd-card')) {
      const on = node.dataset.item === itemId;
      node.tabIndex = on ? 0 : -1;
      for (const inner of node.querySelectorAll<HTMLElement>('button')) inner.tabIndex = on ? 0 : -1;
    }
  }

  function focusCard(itemId: string): boolean {
    const node = els.columns.querySelector<HTMLElement>(`.bd-card[data-item="${CSS.escape(itemId)}"]`);
    if (!node) return false;
    setActive(itemId);
    node.focus();
    node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    return true;
  }

  function onCardKey(ev: KeyboardEvent, item: WorkItem, li: HTMLElement): void {
    if (ev.target !== li) return;
    const grid = visibleCards().filter((c) => c.length);
    const col = grid.findIndex((c) => c.includes(li));
    const row = col >= 0 ? (grid[col] as HTMLElement[]).indexOf(li) : -1;
    const to = (c: number, r: number): void => {
      const column = grid[c];
      const target = column?.[Math.max(0, Math.min(r, column.length - 1))];
      if (target?.dataset.item) focusCard(target.dataset.item);
    };
    if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && ev.altKey) {
      ev.preventDefault();
      const column = columnOf(item.status);
      if (column !== 'backlog' && column !== 'ready') return;
      const siblings = grid[col] ?? [];
      const neighbour = siblings[ev.key === 'ArrowUp' ? row - 1 : row + 1]?.dataset.item;
      if (!neighbour) return;
      focusAfter = item.id;
      void move(item.id, ev.key === 'ArrowUp' ? { before: neighbour } : { after: neighbour });
      return;
    }
    switch (ev.key) {
      case 'Enter':
      case ' ':
        ctx.openItem(item.id);
        break;
      case 'ArrowDown':
        to(col, row + 1);
        break;
      case 'ArrowUp':
        to(col, row - 1);
        break;
      case 'ArrowRight':
        if (col < grid.length - 1) to(col + 1, row);
        break;
      case 'ArrowLeft':
        if (col > 0) to(col - 1, row);
        break;
      case 'Home':
        to(col, 0);
        break;
      case 'End':
        to(col, Number.MAX_SAFE_INTEGER);
        break;
      case 'F10':
      case 'ContextMenu':
        if (ev.key === 'F10' && !ev.shiftKey) return;
        openCardMenu(item, li.querySelector<HTMLElement>('.bd-more') ?? li);
        break;
      default:
        return;
    }
    ev.preventDefault();
  }

  /* ---------- Drag and drop ---------- */

  let line: HTMLElement | null = null;

  function clearDropLine(): void {
    line?.remove();
    line = null;
    for (const parts of cols.values()) parts.section.classList.remove('drop-over');
  }

  function endDrag(): void {
    dragging = null;
    clearDropLine();
    els.columns.classList.remove('dragging');
    for (const parts of cols.values()) delete parts.section.dataset.drop;
    for (const n of els.columns.querySelectorAll('.bd-card.dragging')) n.classList.remove('dragging');
  }

  /** The card the drop lands before (null: the end of the column). */
  function dropBefore(list: HTMLElement, y: number): HTMLElement | null {
    for (const node of list.querySelectorAll<HTMLElement>('.bd-card:not(.dragging)')) {
      const box = node.getBoundingClientRect();
      if (y < box.top + box.height / 2) return node;
    }
    return null;
  }

  function wireDrop(section: HTMLElement, column: ColumnId): void {
    section.addEventListener('dragover', (ev) => {
      if (!dragging || !dropAction(dragging.status, column)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      const parts = cols.get(column);
      if (!parts) return;
      for (const other of cols.values()) other.section.classList.toggle('drop-over', other === parts);
      const before = dropBefore(parts.list, ev.clientY);
      if (!line) line = el('li', 'bd-drop-line');
      if (before) parts.list.insertBefore(line, before);
      else parts.list.appendChild(line);
    });
    section.addEventListener('dragleave', (ev) => {
      if (!section.contains(ev.relatedTarget as Node | null)) {
        section.classList.remove('drop-over');
        if (line && section.contains(line)) clearDropLine();
      }
    });
    section.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const item = dragging;
      const parts = cols.get(column);
      if (!item || !parts) return;
      const action = dropAction(item.status, column);
      const before = dropBefore(parts.list, ev.clientY);
      const cards = [...parts.list.querySelectorAll<HTMLElement>('.bd-card:not(.dragging)')];
      const after = before ? cards[cards.indexOf(before) - 1] : cards[cards.length - 1];
      const position: ItemPosition | null = before?.dataset.item ? { before: before.dataset.item } : after?.dataset.item ? { after: after.dataset.item } : null;
      const at = line?.getBoundingClientRect() ?? null;
      endDrag();
      if (action === 'reorder') {
        if (position) {
          focusAfter = item.id;
          void move(item.id, position);
        }
      } else if (action === 'assign') assignPicked(item, position, at);
      else if (action === 'unassign') {
        void (async () => {
          await run(item, 'unassign');
          if (position) await move(item.id, position);
        })();
      }
    });
  }

  /* ---------- Rendering ---------- */

  function key(column: ColumnId, items: WorkItem[], all: WorkItem[]): string {
    return JSON.stringify([
      multiRepo(),
      column === 'done' ? doneAll : null,
      all.length === 0,
      items.map((i) => [
        i.id,
        i.number,
        i.title,
        i.status,
        i.agent,
        i.repo,
        i.createdBy,
        i.source?.number,
        i.attempts,
        i.pendingAsk?.routedTo,
        i.lastError,
        i.cancelReason,
        i.result?.diffStat,
        i.pr,
        column === 'ready' ? queueLine(i, all) : null,
        column === 'progress' ? [startedAt(i), latestTool(i)] : null,
      ]),
    ]);
  }

  function emptyCta(): HTMLElement {
    const li = el('li', 'bd-empty');
    li.appendChild(el('p', 'bd-empty-title', 'No work items yet'));
    li.appendChild(el('p', 'bd-empty-text', 'Add an item, import a GitHub issue, or ask the orchestrator to plan the work.'));
    const row = el('div', 'bd-empty-actions');
    const add = button('btn-primary small', 'New item');
    add.addEventListener('click', () => create());
    const imp = button('btn-ghost', 'Import issue…');
    imp.addEventListener('click', () => importIssue(imp));
    const chat = button('btn-ghost', 'Ask in Chat');
    chat.addEventListener('click', () => ctx.toChat());
    row.append(add, imp, chat);
    li.appendChild(row);
    return li;
  }

  function fill(column: ColumnId, items: WorkItem[], all: WorkItem[]): void {
    const parts = cols.get(column);
    if (!parts) return;
    parts.count.textContent = String(items.length);
    const k = key(column, items, all);
    if (parts.built === k) return;
    parts.built = k;
    parts.list.textContent = '';
    if (!items.length) {
      if (column === 'backlog' && !all.length) parts.list.appendChild(emptyCta());
      else parts.list.appendChild(el('li', 'bd-hint', COLUMNS.find((c) => c.id === column)?.hint ?? ''));
      return;
    }
    const shown = column === 'done' && !doneAll ? items.slice(0, DONE_LIMIT) : items;
    for (const item of shown) parts.list.appendChild(card(item, all));
    if (shown.length < items.length) {
      const li = el('li', 'bd-more-row');
      const all2 = button('btn-ghost', `Show all ${items.length}`);
      all2.addEventListener('click', () => {
        doneAll = true;
        render();
      });
      li.appendChild(all2);
      parts.list.appendChild(li);
    }
  }

  function renderClosedRail(items: WorkItem[]): void {
    const parts = cols.get('closed');
    if (!parts) return;
    parts.section.classList.toggle('collapsed', !closedOpen);
    const rail = parts.section.querySelector<HTMLElement>('.bd-rail');
    if (!rail) return;
    const failed = items.filter((i) => i.status === 'failed').length;
    const cancelled = items.length - failed;
    const railKey = `${failed}/${cancelled}`;
    if (rail.dataset.key === railKey) return;
    rail.dataset.key = railKey;
    rail.textContent = '';
    const open = el('span', 'bd-rail-open');
    open.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>';
    rail.append(open, el('span', 'bd-rail-title', 'Closed'), el('span', 'bd-rail-count', String(items.length)));
    if (failed) rail.appendChild(el('span', 'bd-rail-failed', String(failed)));
    rail.title = `Closed: ${failed} failed, ${cancelled} cancelled. Show them.`;
    rail.setAttribute('aria-label', `Show closed items: ${failed} failed, ${cancelled} cancelled`);
  }

  function renderHeader(): void {
    const ready = store.hasSnapshot();
    els.newBtn.disabled = !ready;
    els.importBtn.disabled = !ready;
    const cap = store.capacity();
    const capKey = JSON.stringify(ready ? cap : null);
    if (els.capacity.dataset.key !== capKey) {
      els.capacity.dataset.key = capKey;
      els.capacity.textContent = '';
      if (ready) {
        for (const slot of capacitySlots(cap)) {
          const c = el('span', `bd-cap${slot.running >= slot.max ? ' full' : ''}`);
          c.appendChild(el('span', 'bd-cap-name', slot.agent));
          const pips = el('span', 'bd-pips');
          for (let i = 0; i < slot.max; i++) pips.appendChild(el('span', `bd-pip${i < slot.running ? ' on' : ''}`));
          c.appendChild(pips);
          c.appendChild(el('span', 'bd-cap-num', `${slot.running}/${slot.max}`));
          els.capacity.appendChild(c);
        }
        // The environment-wide limit across agents, set apart from the per-agent chips.
        els.capacity.appendChild(el('span', 'bd-cap-sep'));
        const total = el('span', 'bd-cap total');
        total.title = `${cap.workers.running} of ${cap.workers.max} workers busy across all agents`;
        total.append(el('span', 'bd-cap-name', 'Workers'), el('span', 'bd-cap-num', `${cap.workers.running}/${cap.workers.max}`));
        els.capacity.appendChild(total);
        els.capacity.title = capacityText(cap);
        els.capacity.setAttribute('aria-label', `Capacity: ${capacityText(cap)}`);
      }
    }
    els.paused.classList.toggle('hidden', !(ready && cap.paused));
    if (ready && cap.paused && !els.paused.childElementCount) {
      els.paused.appendChild(el('span', 'bd-paused-badge', 'Scheduler paused'));
      const resume = button('btn-ghost', 'Resume');
      resume.addEventListener('click', async () => {
        resume.disabled = true;
        try {
          await ctx.daemon('scheduler.resume', {});
        } catch (err) {
          ctx.say(errText(err));
        } finally {
          resume.disabled = false;
        }
      });
      els.paused.appendChild(resume);
    }
  }

  function render(): void {
    renderHeader();
    const ready = store.hasSnapshot();
    if (!ready) {
      // Placeholders until the snapshot lands; the banner says why when it cannot.
      let i = 0;
      for (const parts of cols.values()) {
        parts.count.textContent = '';
        if (parts.built !== 'skeleton') {
          parts.built = 'skeleton';
          parts.list.textContent = '';
          for (let n = 0; n < (i < 3 ? 2 : 1); n++) parts.list.appendChild(el('li', `bd-skel${n ? ' short' : ''}`));
        }
        i++;
      }
      return;
    }
    const all = store.items();
    const focused = document.activeElement instanceof HTMLElement && els.columns.contains(document.activeElement) ? document.activeElement : null;
    const focusedCard = focused?.closest<HTMLElement>('.bd-card')?.dataset.item ?? null;
    for (const c of COLUMNS) fill(c.id, columnItems(all, c.id, startedAt), all);
    renderClosedRail(columnItems(all, 'closed'));
    const selected = ctx.selected();
    for (const node of els.columns.querySelectorAll<HTMLElement>('.bd-card')) node.classList.toggle('selected', node.dataset.item === selected);
    const cards = [...els.columns.querySelectorAll<HTMLElement>('.bd-card')];
    const keep = active && cards.some((n) => n.dataset.item === active) ? active : (cards[0]?.dataset.item ?? null);
    if (keep) setActive(keep);
    // A rebuilt column drops the focused card: focus its replacement.
    const restore = focusAfter ?? focusedCard;
    focusAfter = null;
    if (restore && document.activeElement !== els.columns.querySelector(`.bd-card[data-item="${CSS.escape(restore)}"]`)) focusCard(restore);
  }

  /* ---------- New item and import ---------- */

  function closeCreate(): void {
    creating = null;
    const slot = cols.get('backlog')?.slot;
    if (slot) slot.textContent = '';
  }

  function create(): void {
    if (!store.hasSnapshot()) return;
    if (creating) {
      creating.focus();
      return;
    }
    const slot = cols.get('backlog')?.slot;
    if (!slot) return;
    const box = el('div', 'bd-new');
    const input = el('input', 'bd-new-input');
    input.placeholder = 'Title of the new item';
    input.setAttribute('aria-label', 'New item title');
    input.maxLength = 200;
    const help = el('div', 'bd-new-help');
    help.append(el('span', '', '↵ add'), el('span', '', '⌘↵ add and open'), el('span', '', 'esc close'));
    box.append(input, help);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeCreate();
        els.newBtn.focus();
        return;
      }
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const title = input.value.trim();
      if (!title) return;
      const open = ev.metaKey || ev.ctrlKey;
      input.disabled = true;
      ctx
        .daemon('item.create', { title, position: 'top' })
        .then((made) => {
          ctx.say('');
          if (open) {
            closeCreate();
            ctx.openItem(made.id, 'details');
          } else {
            input.value = '';
            input.disabled = false;
            input.focus();
          }
        })
        .catch((err: unknown) => {
          input.disabled = false;
          ctx.say(errText(err));
        });
    });
    input.addEventListener('blur', () => {
      if (!input.value.trim() && !input.disabled) setTimeout(() => creating === input && document.activeElement !== input && closeCreate(), 0);
    });
    creating = input;
    slot.appendChild(box);
    cols.get('backlog')?.list.scrollTo?.({ top: 0 });
    input.focus();
  }

  function importIssue(anchor: HTMLElement = els.importBtn): void {
    if (!store.hasSnapshot()) return;
    if (popupAnchor() === anchor) {
      closePopup();
      return;
    }
    const panel = el('div', 'bd-import');
    const input = el('input', 'bd-import-query');
    input.placeholder = 'Search issues, or owner/name#12';
    input.setAttribute('aria-label', 'Search issues to import');
    const results = el('ul', 'bd-import-results');
    results.setAttribute('aria-live', 'polite');
    panel.append(input, results);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let token = 0;

    const note = (text: string): void => {
      results.textContent = '';
      results.appendChild(el('li', 'bd-import-note', text));
    };

    const doImport = async (repo: string, number: number): Promise<void> => {
      try {
        const made = await ctx.daemon('issue.import', { repo, number, position: 'top' });
        ctx.say('');
        closePopup();
        ctx.openItem(made.id);
      } catch (err) {
        ctx.say(errText(err));
      }
    };

    const showHits = (hits: IssueHit[]): void => {
      results.textContent = '';
      if (!hits.length) {
        note('No open issues match.');
        return;
      }
      for (const hit of hits.slice(0, 30)) {
        const li = el('li', 'bd-import-hit');
        const pick = button('bd-import-pick');
        pick.append(el('span', 'bd-import-title', hit.title), el('span', 'bd-import-ref', `${hit.repo}#${hit.number}`));
        if (hit.item) {
          pick.appendChild(el('span', 'bd-import-linked', `Already ${hit.item}`));
          pick.disabled = true;
        }
        pick.addEventListener('click', () => void doImport(hit.repo, hit.number));
        pick.addEventListener('keydown', (ev) => {
          const picks = [...results.querySelectorAll<HTMLButtonElement>('.bd-import-pick:not(:disabled)')];
          const at = picks.indexOf(pick);
          if (ev.key === 'ArrowDown') picks[at + 1]?.focus();
          else if (ev.key === 'ArrowUp') (at > 0 ? picks[at - 1] : input)?.focus();
          else return;
          ev.preventDefault();
        });
        li.appendChild(pick);
        results.appendChild(li);
      }
    };

    const search = (): void => {
      const q = input.value.trim();
      const mine = ++token;
      if (!q) {
        note('Type to search the open issues of this environment’s repositories.');
        return;
      }
      if (parseIssueRef(q)) {
        note('Press Enter to import this issue.');
        return;
      }
      note('Searching…');
      ctx
        .daemon('issue.search', { query: q })
        .then((found) => {
          if (mine === token) showHits(found.issues);
        })
        .catch((err: unknown) => {
          if (mine === token) note(errText(err));
        });
    };

    input.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(search, ctx.debounceMs ?? 300);
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        const ref = parseIssueRef(input.value);
        if (ref) void doImport(ref.repo, ref.number);
        else search();
      } else if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        results.querySelector<HTMLButtonElement>('.bd-import-pick:not(:disabled)')?.focus();
      }
    });
    note('Type to search the open issues of this environment’s repositories.');
    openPopover(anchor, panel, { label: 'Import a GitHub issue', align: anchor === els.importBtn ? 'end' : 'start', className: 'bd-import-pop' });
  }

  els.newBtn.addEventListener('click', () => create());
  els.importBtn.addEventListener('click', () => importIssue());

  /** Move the running cards' clocks without a rebuild. */
  function tick(at: number): void {
    for (const node of els.columns.querySelectorAll<HTMLElement>('.bd-elapsed')) {
      node.textContent = formatElapsed(at - Number(node.dataset.since));
    }
  }

  return {
    render,
    tick,
    /** ⌘N. */
    create,
    importIssue: (): void => importIssue(),
    focusCard,
    /** Another environment: close the new-item field and forget focus. */
    reset(): void {
      closeCreate();
      active = null;
      doneAll = false;
      render();
    },
    /** True while something runs (the ticker keeps going). */
    busy: (): boolean => store.items().some((i) => i.status === 'running'),
  };
}

export type Board = ReturnType<typeof initBoard>;
