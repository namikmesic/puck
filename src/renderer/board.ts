/**
 * The Board view: the environment's tickets in three columns, Todo, In
 * progress and Done (see board-model.ts). Every step of a ticket happens
 * inside its card.
 *
 * - Cards: `W-n`, the title, the agent, the repository when the
 *   environment has more than one, and the signals: the stage line (a
 *   question for you, gold and prominent; the running clock and latest
 *   tool call; the queue position; waiting for you to accept or merge),
 *   the gold halo and a badge with the count of asks routed to you,
 *   attempts, the diff, the pull request with its CI state, a Done card's
 *   outcome chip, the failure or cancel reason. A click or Enter opens the
 *   ticket in the side sheet; the open ticket's card is highlighted.
 * - "…" (or Shift+F10 on a focused card) opens `cardActions`: Assign (one
 *   entry per agent, or only the session's agent once a session exists),
 *   Stop, Publish, Accept, Retry, Cancel and Delete. Delete, and
 *   cancelling a started ticket, arm on the first click.
 * - Keyboard: one tab stop for the cards; arrows move between cards and
 *   columns, Home and End jump within a column, Alt+↑/↓ reorders Todo.
 * - Drag only reorders within Todo. While dragging, Todo is outlined and
 *   the rest dim.
 * - Done has a filter with counts: Delivered (the default), Failed,
 *   Cancelled, All, remembered per environment; the Failed count shows in
 *   red even while filtered out. Done shows its latest 20 until "Show all".
 *   In progress can be narrowed to the tickets that need you (the Chat
 *   view's "+N waiting").
 * - The header: agent capacity, the paused scheduler with Resume, Import
 *   issue (a search popover over the environment's repositories, or
 *   `owner/name#12` and issue URLs) and New item (⌘N: a title field atop
 *   Todo; Enter adds, ⌘Enter adds and opens). An environment whose daemon
 *   predates the three-column board is read-only.
 *
 * Context in, controller out; no DOM lookups.
 */

import type { ClientResult, IssueHit, ItemPosition, OpArgs, RendererOp, WorkItem } from '../harness/daemon-protocol';
import { formatElapsed } from '../harness/lifecycle';
import { deliveryPull, sourceIssue } from '../harness/references';
import {
  armsFirst,
  assignable,
  cardActions,
  canDrag,
  capacitySlots,
  capacityText,
  columnItems,
  COLUMNS,
  columnOf,
  diffText,
  DONE_FILTERS,
  doneCounts,
  doneEmptyText,
  dropAction,
  isRunning,
  outcomeChip,
  parseIssueRef,
  queueLine,
  readDoneFilter,
  saveDoneFilter,
  stageLine,
  type CardAction,
  type ColumnId,
  type DoneFilter,
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
  daemon<K extends RendererOp>(op: K, args: OpArgs<K>): Promise<ClientResult<K>>;
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

const DONE_LIMIT = 20;

const ACTION_LABEL: Record<Exclude<CardAction, 'assign'>, string> = {
  stop: 'Stop the turn',
  accept: 'Accept',
  publish: 'Publish a pull request',
  retry: 'Retry',
  cancel: 'Cancel ticket',
  delete: 'Delete',
};

interface ColumnParts {
  section: HTMLElement;
  list: HTMLElement;
  count: HTMLElement;
  /** New-item field slot (Todo only). */
  slot: HTMLElement | null;
  /** The Done filter (Done only). */
  filter: HTMLElement | null;
  built: string;
}

export function initBoard(ctx: BoardContext) {
  const { els, store } = ctx;
  const now = ctx.now ?? Date.now;
  const cols = new Map<ColumnId, ColumnParts>();
  let filterEnv: string | null = store.envId();
  let doneFilter: DoneFilter = readDoneFilter(ctx.prefs, filterEnv);
  /** In progress narrowed to the tickets that need you. */
  let onlyNeeds = false;
  let doneAll = false;
  let active: string | null = null;
  let dragging: WorkItem | null = null;
  let creating: HTMLInputElement | null = null;
  let focusAfter: string | null = null;

  /* ---------- Structure (built once) ---------- */

  const legacy = el('p', 'bd-legacy hidden', "This environment's daemon predates the three-column board. Update it to work here.");
  legacy.setAttribute('role', 'status');
  els.columns.before(legacy);

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
    let filter: HTMLElement | null = null;
    if (c.id === 'todo') {
      slot = el('div', 'bd-slot');
      section.append(head, slot, list);
    } else if (c.id === 'done') {
      filter = el('div', 'bd-filter');
      filter.setAttribute('role', 'radiogroup');
      filter.setAttribute('aria-label', 'Show done tickets');
      section.append(head, filter, list);
    } else section.append(head, list);
    if (c.id === 'progress') {
      const needs = button('bd-needs-filter hidden');
      needs.addEventListener('click', () => setOnlyNeeds(false));
      head.appendChild(needs);
    }
    wireDrop(section, c.id);
    els.columns.appendChild(section);
    cols.set(c.id, { section, list, count, slot, filter, built: '' });
  }

  function setDoneFilter(next: DoneFilter): void {
    doneFilter = next;
    doneAll = false;
    saveDoneFilter(ctx.prefs, store.envId(), next);
    render();
    cols.get('done')?.filter?.querySelector<HTMLElement>(`[data-filter="${next}"]`)?.focus();
  }

  function setOnlyNeeds(on: boolean): void {
    onlyNeeds = on;
    render();
  }

  /** True while the environment's daemon predates protocol 2: the board is read-only. */
  function readOnly(): boolean {
    return (store.state()?.daemon.protocol ?? 2) < 2;
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

  async function run(item: WorkItem, action: CardAction, agent?: string): Promise<boolean> {
    try {
      switch (action) {
        case 'assign':
          await ctx.daemon('item.assign', { itemId: item.id, agent: agent ?? null });
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
          return true;
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
      return true;
    } catch (err) {
      ctx.say(`W-${item.number}: ${errText(err)}`);
      return false;
    }
  }

  function choicesFor(item: WorkItem): string[] {
    return assignable(item, agents(), item.sessionId ? (store.session(item.sessionId)?.agent ?? null) : null);
  }

  /** The "…" menu entries for a ticket: Open, then what its status and steps allow. */
  function menuEntries(item: WorkItem): MenuEntry[] {
    const entries: MenuEntry[] = [{ label: 'Open', hint: '↵', action: 'open', run: () => ctx.openItem(item.id) }];
    if (readOnly()) return entries;
    let grouped = false;
    for (const action of cardActions(item)) {
      if (action === 'assign') {
        for (const agent of choicesFor(item)) {
          entries.push({
            label: `${item.agent ? 'Reassign' : 'Assign'} to ${agent}`,
            action: `assign:${agent}`,
            group: !grouped,
            run: () => {
              void run(item, 'assign', agent);
            },
          });
          grouped = true;
        }
        continue;
      }
      const destructive = action === 'cancel' || action === 'delete';
      entries.push({
        label: ACTION_LABEL[action],
        action,
        danger: destructive,
        confirm: armsFirst(action, item) ? `Confirm: ${action === 'delete' ? 'delete' : 'cancel'} W-${item.number}` : undefined,
        group: destructive ? !entries.some((e) => e.danger) : !grouped,
        run: () => {
          void run(item, action);
        },
      });
      if (!destructive) grouped = true;
    }
    return entries;
  }

  /** The entries come from the item as it is now, not as the card was built (a rebuild dismisses the menu anyway). */
  function openCardMenu(itemId: string, anchor: HTMLElement): void {
    if (popupAnchor() === anchor) {
      closePopup();
      return;
    }
    const item = store.items().find((i) => i.id === itemId);
    if (!item) return;
    openMenu(anchor, menuEntries(item), { label: `Actions for W-${item.number}` });
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

  /** The card's stage line: the queue position in Todo, where the work is In progress, why it ended in Done. */
  function signal(item: WorkItem, all: WorkItem[]): HTMLElement | null {
    if (item.status === 'todo') {
      const s = el('div', 'bd-signal sig-queued');
      s.appendChild(el('span', 'bd-signal-text', queueLine(item, all)));
      return s;
    }
    if (item.status === 'in-progress') {
      const line = stageLine(item, all);
      if (line.tone === 'busy' && isRunning(item) && item.openAsks === 0) {
        const s = el('div', 'bd-signal bd-stage sig-running');
        const since = startedAt(item);
        const clock = el('span', 'bd-elapsed', formatElapsed(now() - since));
        clock.dataset.since = String(since);
        s.append(el('span', 'bd-signal-dot'), clock, el('span', 'bd-tool', latestTool(item)));
        s.title = line.text;
        return s;
      }
      const s = el('div', `bd-signal bd-stage ${line.tone === 'ask' ? 'sig-ask mine' : line.tone === 'wait' && item.openAsks > 0 ? 'sig-ask' : `sig-${line.tone}`}`);
      if (line.tone === 'ask' || item.openAsks > 0) s.appendChild(el('span', 'bd-signal-dot'));
      s.appendChild(el('span', 'bd-signal-text', line.text));
      return s;
    }
    if (item.outcome === 'failed' || item.outcome === 'cancelled') {
      const reason = item.outcome === 'failed' ? item.lastError : item.cancelReason;
      const s = el('div', `bd-signal sig-${item.outcome}`);
      // A non-breaking hyphen keeps "W-11" on one line.
      s.appendChild(el('span', 'bd-signal-text', `${item.outcome === 'failed' ? 'Failed' : 'Cancelled'}${reason ? `: ${reason.replace(/\bW-(?=\d)/g, 'W\u2011')}` : ''}`));
      if (reason) s.title = reason;
      return s;
    }
    return null;
  }

  function card(item: WorkItem, all: WorkItem[]): HTMLLIElement {
    const li = el('li', `bd-card status-${item.status}${item.outcome ? ` outcome-${item.outcome}` : ''}${item.userAsks > 0 ? ' needs-you' : ''}`);
    li.dataset.item = item.id;
    li.tabIndex = -1;
    li.draggable = canDrag(item.status) && !readOnly();
    const agent = item.agent ?? 'Unassigned';
    const place = item.status === 'done' ? `done, ${item.outcome ?? ''}` : item.status === 'in-progress' ? 'in progress' : 'todo';
    li.setAttribute('aria-label', `W-${item.number} ${item.title}, ${place}${item.userAsks > 0 ? `, ${item.userAsks} waiting on you` : ''}, ${agent}`);

    const top = el('div', 'bd-card-top');
    const id = el('span', 'bd-id', `W-${item.number}`);
    top.appendChild(id);
    if (item.createdBy === 'orchestrator' || item.createdBy === 'pipeline') {
      const mark = el('span', 'bd-by');
      mark.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 3 20 12 12 21 4 12Z" /></svg>';
      mark.title = item.createdBy === 'pipeline' ? 'Created by Puck' : 'Created by the orchestrator';
      top.appendChild(mark);
    }
    const src = sourceIssue(item);
    if (src) top.appendChild(chip('issue', `#${src.number}`, `${src.repo}#${src.number}`));
    top.appendChild(el('span', 'spacer'));
    const more = button('bd-more');
    more.tabIndex = -1;
    more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></svg>';
    more.setAttribute('aria-label', `Actions for W-${item.number}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openCardMenu(item.id, more);
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
    if (diff && (item.stage === 'merge' || item.status === 'done')) meta.appendChild(chip('diff', diff, `${item.result?.diffStat.files ?? 0} files changed`));
    const pull = deliveryPull(item);
    const outcome = item.status === 'done' ? outcomeChip(item, pull?.number ?? null) : null;
    if (outcome) meta.appendChild(chip(`outcome ${outcome.tone}`, outcome.text, outcome.tone === 'merged' ? 'Merged on GitHub' : undefined));
    if (pull) {
      const { url, number, checks } = pull;
      const state = pull.state === 'merged' ? 'merged' : pull.state === 'closed' ? 'closed' : pull.draft ? 'draft' : 'open';
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
    if (item.userAsks > 0) {
      const badge = el('span', 'bd-needs', String(item.userAsks));
      badge.title = `${item.userAsks} waiting on you`;
      badge.setAttribute('aria-hidden', 'true');
      meta.appendChild(badge);
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
    return COLUMNS.map((c) => [...(cols.get(c.id)?.list.querySelectorAll<HTMLElement>('.bd-card') ?? [])]);
  }

  function setActive(itemId: string): void {
    active = itemId;
    for (const node of els.columns.querySelectorAll<HTMLElement>('.bd-card')) {
      const on = node.dataset.item === itemId;
      node.tabIndex = on ? 0 : -1;
      for (const inner of node.querySelectorAll<HTMLElement>('button')) inner.tabIndex = on ? 0 : -1;
    }
  }

  /** Focus a card; false when there is none (a Done card behind the filter has none). */
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
      if (columnOf(item.status) !== 'todo' || readOnly()) return;
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
        openCardMenu(item.id, li.querySelector<HTMLElement>('.bd-more') ?? li);
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
      endDrag();
      if (action === 'reorder' && position) {
        focusAfter = item.id;
        void move(item.id, position);
      }
    });
  }

  /* ---------- Rendering ---------- */

  function key(column: ColumnId, items: WorkItem[], all: WorkItem[]): string {
    return JSON.stringify([
      multiRepo(),
      readOnly(),
      column === 'done' ? [doneAll, doneFilter] : null,
      column === 'progress' ? onlyNeeds : null,
      all.length === 0,
      items.map((i) => [
        i.id,
        i.number,
        i.title,
        i.status,
        i.outcome,
        i.stage,
        i.agent,
        i.repo,
        i.createdBy,
        i.references,
        i.attempts,
        i.sessionId,
        i.openAsks,
        i.userAsks,
        i.lastError,
        i.cancelReason,
        i.result?.diffStat,
        i.workflow,
        column === 'todo' || column === 'progress' ? queueLine(i, all) : null,
        column === 'progress' ? startedAt(i) : null,
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

  /** Empty a column; a card menu open on one of its cards goes with the card (its actions were that card's). */
  function clearList(list: HTMLElement): void {
    const anchor = popupAnchor();
    if (anchor && list.contains(anchor)) closePopup();
    list.textContent = '';
  }

  function fill(column: ColumnId, items: WorkItem[], all: WorkItem[]): void {
    const parts = cols.get(column);
    if (!parts) return;
    parts.count.textContent = String(items.length);
    const k = key(column, items, all);
    if (parts.built === k) {
      if (column === 'progress') {
        for (const item of items) {
          if (!isRunning(item)) continue;
          const tool = parts.list.querySelector<HTMLElement>(`.bd-card[data-item="${CSS.escape(item.id)}"] .bd-tool`);
          if (tool) tool.textContent = latestTool(item);
        }
      }
      return;
    }
    const scroll = parts.list.scrollTop;
    parts.built = k;
    clearList(parts.list);
    if (!items.length) {
      const hidden = column === 'done' ? doneEmptyText(doneFilter, doneCounts(all)) : null;
      if (column === 'todo' && !all.length) parts.list.appendChild(emptyCta());
      else if (column === 'progress' && onlyNeeds) parts.list.appendChild(el('li', 'bd-hint', 'Nothing is waiting on you.'));
      else parts.list.appendChild(el('li', 'bd-hint', hidden ?? COLUMNS.find((c) => c.id === column)?.hint ?? ''));
    } else {
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
    parts.list.scrollTop = scroll;
  }

  /** The Done column's filter: each choice with its count; Failed in red whenever there are failures. */
  function renderDoneFilter(all: WorkItem[]): void {
    const parts = cols.get('done');
    const host = parts?.filter;
    if (!parts || !host) return;
    const counts = doneCounts(all);
    const filterKey = JSON.stringify([doneFilter, counts]);
    parts.section.classList.toggle('has-failed', counts.failed > 0);
    if (host.dataset.key === filterKey) return;
    host.dataset.key = filterKey;
    host.textContent = '';
    for (const f of DONE_FILTERS) {
      const on = f.id === doneFilter;
      const b = button(`bd-filter-btn${on ? ' on' : ''}${f.id === 'failed' && counts.failed > 0 ? ' failed' : ''}`);
      b.dataset.filter = f.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      b.append(el('span', 'bd-filter-label', f.label), el('span', 'bd-filter-count', String(counts[f.id])));
      b.setAttribute('aria-label', `${f.label}: ${counts[f.id]}`);
      b.addEventListener('click', () => setDoneFilter(f.id));
      b.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        ev.preventDefault();
        const at = DONE_FILTERS.findIndex((x) => x.id === doneFilter);
        const next = DONE_FILTERS[(at + (ev.key === 'ArrowRight' ? 1 : DONE_FILTERS.length - 1)) % DONE_FILTERS.length];
        if (next) setDoneFilter(next.id);
      });
      host.appendChild(b);
    }
    const failedBadge = parts.section.querySelector<HTMLElement>('.bd-col-failed');
    const badge = failedBadge ?? el('span', 'bd-col-failed');
    badge.textContent = counts.failed ? String(counts.failed) : '';
    badge.title = `${counts.failed} failed`;
    badge.classList.toggle('hidden', !counts.failed);
    if (!failedBadge) parts.section.querySelector('.bd-col-head')?.insertBefore(badge, parts.count.nextSibling);
  }

  function renderNeedsFilter(all: WorkItem[]): void {
    const b = cols.get('progress')?.section.querySelector<HTMLButtonElement>('.bd-needs-filter');
    if (!b) return;
    b.classList.toggle('hidden', !onlyNeeds);
    b.textContent = onlyNeeds ? `Need you: ${all.filter((i) => i.userAsks > 0).length} · show all` : '';
  }

  function renderHeader(): void {
    const ready = store.hasSnapshot();
    legacy.classList.toggle('hidden', !ready || !readOnly());
    els.newBtn.disabled = !ready || readOnly();
    els.importBtn.disabled = !ready || readOnly();
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
          clearList(parts.list);
          for (let n = 0; n < (i < 3 ? 2 : 1); n++) parts.list.appendChild(el('li', `bd-skel${n ? ' short' : ''}`));
        }
        i++;
      }
      return;
    }
    if (store.envId() !== filterEnv) {
      filterEnv = store.envId();
      doneFilter = readDoneFilter(ctx.prefs, filterEnv);
    }
    const all = store.items();
    const focused = document.activeElement instanceof HTMLElement && els.columns.contains(document.activeElement) ? document.activeElement : null;
    const focusedCard = focused?.closest<HTMLElement>('.bd-card')?.dataset.item ?? null;
    for (const c of COLUMNS) {
      let items = columnItems(all, c.id, startedAt, doneFilter);
      if (c.id === 'progress' && onlyNeeds) items = items.filter((i) => i.userAsks > 0);
      fill(c.id, items, all);
    }
    renderDoneFilter(all);
    renderNeedsFilter(all);
    const selected = ctx.selected();
    for (const node of els.columns.querySelectorAll<HTMLElement>('.bd-card')) node.classList.toggle('selected', node.dataset.item === selected);
    // The tab stop stays on a card that can be seen.
    const cards = visibleCards().flat();
    const keep = active && cards.some((n) => n.dataset.item === active) ? active : (cards[0]?.dataset.item ?? null);
    if (keep) setActive(keep);
    // Keyboard reorder asks for the card back. A rebuild drops whatever was
    // focused; a control that is still in the card keeps the focus it has.
    const pending = focusAfter;
    focusAfter = null;
    if (pending) focusCard(pending);
    else if (focused && !focused.isConnected && focusedCard) focusCard(focusedCard);
  }

  /* ---------- New item and import ---------- */

  function closeCreate(): void {
    creating = null;
    const slot = cols.get('todo')?.slot;
    if (slot) slot.textContent = '';
  }

  function create(): void {
    if (!store.hasSnapshot() || readOnly()) return;
    if (creating) {
      creating.focus();
      return;
    }
    const slot = cols.get('todo')?.slot;
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
    input.focus();
  }

  function importIssue(anchor: HTMLElement = els.importBtn): void {
    if (!store.hasSnapshot() || readOnly()) return;
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
      onlyNeeds = false;
      render();
    },
    /** In progress narrowed to the tickets that need you (the Chat view's "+N waiting"). */
    showNeedsYou(): void {
      setOnlyNeeds(true);
    },
    /** True while something runs (the ticker keeps going). */
    busy: (): boolean => store.items().some(isRunning),
  };
}

export type Board = ReturnType<typeof initBoard>;
