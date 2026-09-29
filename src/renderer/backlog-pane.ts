/**
 * The left pane: the environment's backlog, in priority order.
 *
 * - Rows: items in backlog, queued and failed (done and cancelled behind
 *   "Show finished"): drag handle, `W-n`, title, the assignee chip, and a
 *   status line ("queued · 2nd for implementer", or failed in red with the
 *   reason on hover). Items the orchestrator created carry a small mark,
 *   and items from a GitHub issue show its number.
 * - Reorder by drag and drop, or Alt+↑/↓ on the focused row: the move shows
 *   at once and `backlog.order` from the daemon settles it.
 * - "+" (⌘N) opens a title field at the top: Enter creates the item, ⌘Enter
 *   creates it and opens it in work detail, Esc cancels.
 * - "Import issue…" searches the environment's repositories on GitHub
 *   (through its daemon), or takes `owner/name#n` or an issue URL.
 * - A click opens the item in the center.
 *
 * Context in, controller out; no DOM lookups.
 */

import type { IssueHit, ItemPosition, OpArgs, OpResult, RendererOp, WorkItem } from '../harness/daemon-protocol';
import { el } from './dom';
import type { InstanceStore } from './instance-store';
import { button, errText } from './util';

export interface BacklogElements {
  list: HTMLElement;
  add: HTMLButtonElement;
  importBtn: HTMLButtonElement;
  finished: HTMLButtonElement;
  /** The inline create field and the import panel mount here, above the list. */
  tray: HTMLElement;
}

export interface BacklogContext {
  els: BacklogElements;
  store: InstanceStore;
  daemon<K extends RendererOp>(op: K, args: OpArgs<K>): Promise<OpResult<K>>;
  openItem(itemId: string, tab?: 'details'): void;
  say(text: string): void;
  /** The optimistic order could not be saved: re-read the environment. */
  resync(): void;
  prefs?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Search debounce (tests shorten it). */
  debounceMs?: number;
}

const PANE_STATUSES = new Set(['backlog', 'queued', 'failed']);
const FINISHED = new Set(['done', 'cancelled']);
const FINISHED_KEY = 'puck.backlog.showFinished';

export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** "queued · 2nd for implementer", "failed", or '' for a plain backlog item. */
export function statusLine(item: WorkItem, all: readonly WorkItem[]): string {
  if (item.status === 'queued') {
    const line = all.filter((i) => i.status === 'queued' && i.agent === item.agent);
    const at = line.findIndex((i) => i.id === item.id) + 1;
    return item.agent ? `queued · ${ordinal(at)} for ${item.agent}` : 'queued';
  }
  if (item.status === 'failed') return 'failed';
  if (item.status === 'done' || item.status === 'cancelled') return item.status;
  return '';
}

/** `owner/name#12`, `owner/name 12`, or a github.com issue URL. */
export function parseIssueRef(text: string): { repo: string; number: number } | null {
  const t = text.trim();
  const url = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/issues\/(\d{1,9})(?:[/?#].*)?$/.exec(t);
  if (url) return { repo: url[1] as string, number: Number(url[2]) };
  const short = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\s*#\s*(\d{1,9})$/.exec(t);
  if (short) return { repo: short[1] as string, number: Number(short[2]) };
  return null;
}

export function initBacklogPane(ctx: BacklogContext) {
  const { els, store } = ctx;
  let showFinished = false;
  try {
    showFinished = ctx.prefs?.getItem(FINISHED_KEY) === '1';
  } catch {
    showFinished = false;
  }
  let dragging: string | null = null;
  let creating: HTMLInputElement | null = null;
  let importPanel: HTMLElement | null = null;
  let focusAfterRender: string | null = null;
  let builtRows = '';

  function visible(): WorkItem[] {
    return store.items().filter((i) => PANE_STATUSES.has(i.status) || (showFinished && FINISHED.has(i.status)));
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

  function row(item: WorkItem, all: WorkItem[]): HTMLLIElement {
    const li = el('li', `bl-row status-${item.status}`);
    li.dataset.item = item.id;
    li.tabIndex = 0;
    li.draggable = !FINISHED.has(item.status);
    li.setAttribute('aria-label', `W-${item.number} ${item.title}`);
    const grip = el('span', 'bl-grip', '⋮⋮');
    grip.setAttribute('aria-hidden', 'true');
    const top = el('div', 'bl-top');
    top.append(el('span', 'bl-id', `W-${item.number}`), el('span', 'bl-title', item.title));
    if (item.createdBy === 'orchestrator') {
      const mark = el('span', 'bl-mark', '◆');
      mark.title = 'Created by the orchestrator';
      top.appendChild(mark);
    }
    if (item.source) {
      const issue = el('span', 'bl-issue', `#${item.source.number}`);
      issue.title = `${item.source.repo}#${item.source.number}`;
      top.appendChild(issue);
    }
    const meta = el('div', 'bl-meta');
    meta.appendChild(el('span', `bl-agent${item.agent ? '' : ' none'}`, item.agent ?? 'Unassigned'));
    const line = statusLine(item, all);
    if (line) {
      const status = el('span', `bl-status ${item.status}`, line);
      if (item.status === 'failed' && item.lastError) status.title = item.lastError;
      meta.appendChild(status);
    }
    const body = el('div', 'bl-body');
    body.append(top, meta);
    li.append(grip, body);

    li.addEventListener('click', () => ctx.openItem(item.id));
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ctx.openItem(item.id);
        return;
      }
      if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
      ev.preventDefault();
      const rows = visible();
      const at = rows.findIndex((r) => r.id === item.id);
      const neighbour = rows[ev.key === 'ArrowUp' ? at - 1 : at + 1];
      if (!neighbour) return;
      focusAfterRender = item.id;
      void move(item.id, ev.key === 'ArrowUp' ? { before: neighbour.id } : { after: neighbour.id });
    });
    li.addEventListener('dragstart', (ev) => {
      dragging = item.id;
      li.classList.add('dragging');
      ev.dataTransfer?.setData('text/plain', item.id);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      dragging = null;
      li.classList.remove('dragging');
      for (const n of els.list.querySelectorAll('.drop-before, .drop-after')) n.classList.remove('drop-before', 'drop-after');
    });
    li.addEventListener('dragover', (ev) => {
      if (!dragging || dragging === item.id) return;
      ev.preventDefault();
      const after = dropAfter(li, ev);
      li.classList.toggle('drop-after', after);
      li.classList.toggle('drop-before', !after);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const id = dragging;
      li.classList.remove('drop-before', 'drop-after');
      if (!id || id === item.id) return;
      void move(id, dropAfter(li, ev) ? { after: item.id } : { before: item.id });
    });
    return li;
  }

  function dropAfter(li: HTMLElement, ev: DragEvent): boolean {
    const box = li.getBoundingClientRect();
    return box.height > 0 && ev.clientY > box.top + box.height / 2;
  }

  function rowsKey(rows: WorkItem[], all: WorkItem[]): string {
    return JSON.stringify(rows.map((item) => [item.id, item.number, item.title, item.status, item.agent, item.createdBy, item.source?.repo, item.source?.number, item.lastError, statusLine(item, all)]));
  }

  function render(): void {
    const all = store.items();
    const rows = visible();
    els.finished.textContent = showFinished ? 'Hide finished' : 'Show finished';
    els.finished.setAttribute('aria-pressed', String(showFinished));
    const ready = store.hasSnapshot();
    els.add.disabled = !ready;
    els.importBtn.disabled = !ready;
    if (!ready) {
      els.list.textContent = '';
      builtRows = '';
      return;
    }
    const key = rowsKey(rows, all);
    const active = document.activeElement;
    const focusedId = active instanceof HTMLElement && els.list.contains(active) ? (active.dataset.item ?? null) : null;
    if (builtRows === key && !focusAfterRender) return;
    builtRows = key;
    els.list.textContent = '';
    if (!rows.length) {
      els.list.appendChild(el('li', 'bl-empty', 'Nothing in the backlog. Add an item, or ask the orchestrator.'));
      focusAfterRender = null;
      return;
    }
    for (const item of rows) els.list.appendChild(row(item, all));
    const restore = focusAfterRender ?? focusedId;
    focusAfterRender = null;
    if (restore) els.list.querySelector<HTMLElement>(`[data-item="${CSS.escape(restore)}"]`)?.focus();
  }

  function closeTray(): void {
    creating = null;
    importPanel = null;
    els.tray.textContent = '';
  }

  function create(): void {
    if (!store.hasSnapshot()) return;
    if (creating) {
      creating.focus();
      return;
    }
    closeTray();
    const input = el('input', 'bl-new');
    input.placeholder = 'New item title — Enter to add, ⌘Enter to open';
    input.setAttribute('aria-label', 'New item title');
    input.maxLength = 200;
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeTray();
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
            closeTray();
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
    creating = input;
    els.tray.appendChild(input);
    input.focus();
  }

  function importIssue(): void {
    if (!store.hasSnapshot()) return;
    if (importPanel) {
      importPanel.querySelector('input')?.focus();
      return;
    }
    closeTray();
    const panel = el('div', 'bl-import');
    const input = el('input', 'bl-import-query');
    input.placeholder = 'Search issues, or owner/name#12';
    input.setAttribute('aria-label', 'Search issues to import');
    const results = el('ul', 'bl-import-results');
    const close = button('btn-ghost bl-import-close', 'Close');
    close.addEventListener('click', closeTray);
    const head = el('div', 'bl-import-head');
    head.append(input, close);
    panel.append(head, results);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let token = 0;

    const doImport = async (repo: string, number: number): Promise<void> => {
      try {
        const made = await ctx.daemon('issue.import', { repo, number, position: 'top' });
        ctx.say('');
        closeTray();
        ctx.openItem(made.id);
      } catch (err) {
        ctx.say(errText(err));
      }
    };

    const showHits = (hits: IssueHit[]): void => {
      results.textContent = '';
      if (!hits.length) {
        results.appendChild(el('li', 'bl-import-note', 'No open issues match.'));
        return;
      }
      for (const hit of hits.slice(0, 30)) {
        const li = el('li', 'bl-import-hit');
        const pick = button('bl-import-pick');
        pick.append(el('span', 'bl-import-ref', `${hit.repo}#${hit.number}`), el('span', 'bl-import-title', hit.title));
        if (hit.item) {
          pick.appendChild(el('span', 'bl-import-linked', hit.item));
          pick.disabled = true;
          pick.title = `Already ${hit.item}`;
        }
        pick.addEventListener('click', () => void doImport(hit.repo, hit.number));
        li.appendChild(pick);
        results.appendChild(li);
      }
    };

    const search = (): void => {
      const q = input.value.trim();
      const mine = ++token;
      if (!q || parseIssueRef(q)) {
        results.textContent = '';
        if (q) results.appendChild(el('li', 'bl-import-note', 'Enter imports this issue.'));
        return;
      }
      results.textContent = '';
      results.appendChild(el('li', 'bl-import-note', 'Searching…'));
      ctx
        .daemon('issue.search', { query: q })
        .then((found) => {
          if (mine === token) showHits(found.issues);
        })
        .catch((err: unknown) => {
          if (mine !== token) return;
          results.textContent = '';
          results.appendChild(el('li', 'bl-import-note', errText(err)));
        });
    };

    input.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(search, ctx.debounceMs ?? 300);
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        closeTray();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        const ref = parseIssueRef(input.value);
        if (ref) void doImport(ref.repo, ref.number);
        else search();
      }
    });
    importPanel = panel;
    els.tray.appendChild(panel);
    input.focus();
  }

  els.add.addEventListener('click', create);
  els.importBtn.addEventListener('click', importIssue);
  els.finished.addEventListener('click', () => {
    showFinished = !showFinished;
    try {
      ctx.prefs?.setItem(FINISHED_KEY, showFinished ? '1' : '0');
    } catch {
      /* a convenience */
    }
    render();
  });

  return {
    render,
    /** ⌘N. */
    create,
    importIssue,
    /** Another environment: close the tray. */
    reset(): void {
      closeTray();
      render();
    },
  };
}

export type BacklogPane = ReturnType<typeof initBacklogPane>;
