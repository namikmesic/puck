/**
 * Work detail: one work item in the center, in place of the orchestrator.
 *
 * - Breadcrumb "Orchestrator / W-12 Fix login redirect" (Back and Esc
 *   return; a dot says the orchestrator got something meanwhile).
 * - Header: status, agent, `repo@branch`, attempts, the pull request.
 * - Actions by status, as the item state machine allows: running → Stop;
 *   review → Accept, Request changes (focuses the composer), Publish
 *   (always offered to the user); failed and cancelled → Retry; Cancel and
 *   Delete wherever allowed. Delete, and cancelling running work, arm on
 *   first click.
 * - Tabs: Conversation (the worker's thread and a follow-up composer),
 *   Changes (summary, commits, diff stat, uncommitted files, the pull
 *   request with its CI checks and review feedback, "Compare on GitHub"),
 *   Details (editable title and body when not running, the agent and repo
 *   pickers, timestamps, creator, last error).
 * - A pending question shows a banner: "Waiting on the orchestrator" with
 *   "Answer myself", or the question card when it is routed to the user.
 *
 * Context in, controller out; no DOM lookups.
 */

import type { ItemStatus, OpArgs, OpResult, PullView, RendererOp, WorkItem } from '../harness/daemon-protocol';
import { askCard } from './ask-card';
import { armDelete, el } from './dom';
import { fmtClock, relTime } from './format';
import type { InstanceStore } from './instance-store';
import { renderMd } from './markdown';
import type { SessionView } from './session-view';
import type { WorkTab } from './view-nav';
import { button, errText } from './util';

export type ItemAction = 'stop' | 'accept' | 'request-changes' | 'publish' | 'retry' | 'cancel' | 'delete';

/**
 * The header actions per status. Each one the daemon's state machine
 * decides maps to a trigger it allows from that status (a unit test holds
 * this table to the daemon's transitions); Stop interrupts the running
 * turn, and Publish is always the user's to press on work in review.
 */
export const ITEM_ACTIONS: Record<ItemStatus, readonly ItemAction[]> = {
  backlog: ['cancel', 'delete'],
  queued: ['cancel'],
  running: ['stop', 'cancel'],
  'needs-input': ['cancel'],
  review: ['accept', 'request-changes', 'publish', 'cancel'],
  done: ['delete'],
  failed: ['retry', 'delete'],
  cancelled: ['retry', 'delete'],
};

const ACTION_LABEL: Record<ItemAction, string> = {
  stop: 'Stop',
  accept: 'Accept',
  'request-changes': 'Request changes',
  publish: 'Publish',
  retry: 'Retry',
  cancel: 'Cancel',
  delete: 'Delete',
};

/** Which statuses the item's title and body may be edited in. */
const EDITABLE: ReadonlySet<ItemStatus> = new Set(['backlog', 'queued', 'review', 'failed', 'cancelled', 'done']);

export function statusTone(status: ItemStatus): 'busy' | 'ask' | 'on' | 'bad' | 'off' {
  switch (status) {
    case 'running':
      return 'busy';
    case 'needs-input':
      return 'ask';
    case 'review':
    case 'done':
      return 'on';
    case 'failed':
      return 'bad';
    default:
      return 'off';
  }
}

/** Encode a git ref for a GitHub path. Slashes stay, so `puck/W-1` and `release/1` are branch paths. */
const encodeRef = (ref: string): string => ref.split('/').map(encodeURIComponent).join('/');

/** `https://github.com/{owner/name}/compare/{base}...{branch}` once the branch is published. */
export function compareUrl(item: WorkItem, github: string | null): string | null {
  if (!item.pr || !item.branch || !item.base || !github) return null;
  return `https://github.com/${github}/compare/${encodeRef(item.base.branch)}...${encodeRef(item.branch)}`;
}

export interface WorkDetailElements {
  back: HTMLButtonElement;
  unread: HTMLElement;
  crumbTitle: HTMLElement;
  status: HTMLElement;
  meta: HTMLElement;
  actions: HTMLElement;
  banner: HTMLElement;
  tabs: HTMLElement;
  conversation: HTMLElement;
  /** The worker thread's scroller, inside the Conversation tab. */
  thread: HTMLElement;
  /** Composer area (hidden when the item has no session). */
  composerZone: HTMLElement;
  changes: HTMLElement;
  details: HTMLElement;
}

export interface WorkDetailContext {
  els: WorkDetailElements;
  store: InstanceStore;
  sessions: SessionView;
  daemon<K extends RendererOp>(op: K, args: OpArgs<K>): Promise<OpResult<K>>;
  openExternal(url: string): void;
  say(text: string): void;
  back(): void;
  /** The user picked another tab. */
  onTab(tab: WorkTab): void;
  /** Refresh and focus the follow-up composer. */
  composer: { refresh(): void; focus(): void };
}

export function initWorkDetail(ctx: WorkDetailContext) {
  const { els, store } = ctx;
  let itemId: string | null = null;
  let tab: WorkTab = 'conversation';
  let mountedSession: string | null = null;
  let pull: { itemId: string; key: string; view: PullView | null; error: string | null; loading: boolean } | null = null;
  let answering = false;
  /** What each part was last built from: an unrelated event does not rebuild it (and lose typing or a selection). */
  const built = { banner: '', changes: '', details: '' };

  els.back.addEventListener('click', () => ctx.back());
  for (const b of els.tabs.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    b.addEventListener('click', () => ctx.onTab(b.dataset.tab as WorkTab));
  }

  function item(): WorkItem | undefined {
    return itemId ? store.item(itemId) : undefined;
  }

  function repoOf(it: WorkItem): { github: string; dir: string } | null {
    const repos = store.state()?.repos ?? [];
    if (it.repo) return repos.find((r) => r.dir === it.repo) ?? null;
    return repos.length === 1 ? (repos[0] ?? null) : null;
  }

  async function act(it: WorkItem, action: ItemAction): Promise<void> {
    ctx.say('');
    try {
      switch (action) {
        case 'stop':
          if (it.sessionId) await ctx.daemon('session.interrupt', { sessionId: it.sessionId });
          return;
        case 'request-changes':
          ctx.onTab('conversation');
          ctx.composer.focus();
          return;
        case 'accept':
          await ctx.daemon('item.accept', { itemId: it.id });
          return;
        case 'publish': {
          const res = await ctx.daemon('item.publish', { itemId: it.id });
          ctx.say(`Published: ${res.prUrl}`);
          return;
        }
        case 'retry':
          await ctx.daemon('item.retry', { itemId: it.id });
          return;
        case 'cancel':
          await ctx.daemon('item.cancel', { itemId: it.id });
          return;
        case 'delete':
          await ctx.daemon('item.delete', { itemId: it.id });
          ctx.back();
          return;
      }
    } catch (err) {
      ctx.say(errText(err));
    }
  }

  function renderHeader(it: WorkItem): void {
    els.crumbTitle.textContent = `W-${it.number} ${it.title}`;
    els.status.className = `wd-status tone-${statusTone(it.status)}`;
    els.status.textContent = '';
    els.status.append(el('span', 'dot'), document.createTextNode(it.status));
    els.meta.textContent = '';
    els.meta.appendChild(el('span', `wd-agent${it.agent ? '' : ' none'}`, it.agent ?? 'Unassigned'));
    const repo = it.repo ?? repoOf(it)?.dir ?? null;
    if (repo || it.branch) els.meta.appendChild(el('span', 'wd-branch', [repo, it.branch].filter(Boolean).join('@')));
    if (it.attempts > 1) els.meta.appendChild(el('span', 'wd-attempts', `attempt ${it.attempts}`));
    if (it.pr) {
      const url = it.pr.url;
      const pr = button('wd-pr', `PR #${it.pr.number}${it.pr.state && it.pr.state !== 'open' ? ` · ${it.pr.state}` : it.pr.draft ? ' · draft' : ''}`);
      pr.addEventListener('click', () => ctx.openExternal(url));
      els.meta.appendChild(pr);
    }
    els.actions.textContent = '';
    for (const action of ITEM_ACTIONS[it.status]) {
      const b = button(action === 'accept' || action === 'publish' ? 'btn-primary' : action === 'delete' || action === 'cancel' ? 'btn-ghost danger' : 'btn-ghost', ACTION_LABEL[action]);
      b.dataset.action = action;
      const run = (): Promise<void> => act(it, action);
      if (action === 'delete' || (action === 'cancel' && (it.status === 'running' || it.status === 'needs-input'))) armDelete(b, run);
      else b.addEventListener('click', () => void run());
      els.actions.appendChild(b);
    }
  }

  function renderBanner(it: WorkItem): void {
    const pending = it.pendingAsk;
    const ask = pending ? store.ask(pending.askId) : undefined;
    const key = JSON.stringify([it.id, pending, answering, !!ask]);
    if (built.banner === key) return;
    built.banner = key;
    els.banner.textContent = '';
    els.banner.classList.toggle('hidden', !pending);
    if (!pending) {
      answering = false;
      return;
    }
    const submit = async (answers: Record<string, string> | null): Promise<void> => {
      if (!it.sessionId) return;
      try {
        await ctx.daemon('ask.answer', { sessionId: it.sessionId, askId: pending.askId, answers });
        answering = false;
      } catch (err) {
        ctx.say(`Couldn't send the answer: ${errText(err)}`);
        throw err;
      }
    };
    if (pending.routedTo === 'orchestrator' && !answering) {
      els.banner.appendChild(el('span', 'wd-banner-text', 'Waiting on the orchestrator to answer a question.'));
      const mine = button('btn-ghost', 'Answer myself');
      mine.disabled = !ask;
      mine.addEventListener('click', () => {
        answering = true;
        renderBanner(it);
        els.banner.querySelector<HTMLButtonElement>('.ask-option, button')?.focus();
      });
      els.banner.appendChild(mine);
      return;
    }
    els.banner.appendChild(el('span', 'wd-banner-text', `${it.agent ?? 'The worker'} asks:`));
    if (ask) els.banner.appendChild(askCard(ask.questions, { submit }));
    else els.banner.appendChild(el('span', 'wd-banner-text', 'Loading the question…'));
  }

  function renderConversation(it: WorkItem): void {
    els.composerZone.classList.toggle('hidden', !it.sessionId);
    if (!it.sessionId) {
      mountedSession = null;
      els.thread.textContent = '';
      els.thread.appendChild(el('p', 'wd-empty', 'No conversation yet: the item has not started.'));
      return;
    }
    if (mountedSession !== it.sessionId || ctx.sessions.mountedSession() !== it.sessionId) {
      mountedSession = it.sessionId;
      ctx.sessions.mount(it.sessionId, els.thread);
    }
    ctx.composer.refresh();
  }

  function section(title: string): HTMLElement {
    const box = el('section', 'wd-section');
    box.appendChild(el('h4', 'wd-section-title', title));
    return box;
  }

  function linkButton(label: string, url: string): HTMLButtonElement {
    const b = button('btn-ghost', label);
    b.addEventListener('click', () => ctx.openExternal(url));
    return b;
  }

  function pullKey(it: WorkItem): string {
    return JSON.stringify([it.pr?.number, it.pr?.lastPushedSha, it.pr?.state, it.pr?.checks?.state, it.pr?.checks?.sha, it.updatedAt]);
  }

  function loadPull(it: WorkItem): void {
    if (!it.pr) {
      pull = null;
      return;
    }
    const key = pullKey(it);
    if (pull && pull.itemId === it.id && pull.key === key) return;
    const mine: NonNullable<typeof pull> = { itemId: it.id, key, view: pull?.itemId === it.id ? pull.view : null, error: null, loading: true };
    pull = mine;
    ctx
      .daemon('item.pr', { itemId: it.id })
      .then((view) => {
        mine.view = view;
      })
      .catch((err: unknown) => {
        mine.error = errText(err);
      })
      .finally(() => {
        mine.loading = false;
        const now = item();
        if (pull === mine && tab === 'changes' && now) renderChanges(now);
      });
  }

  function renderChanges(it: WorkItem, force = false): void {
    const key = JSON.stringify([it.id, it.status, it.result?.endedAt, it.pr, it.branch, pull?.view, pull?.error]);
    if (!force && built.changes === key) return;
    built.changes = key;
    const host = els.changes;
    host.textContent = '';
    const r = it.result;
    if (!r && !it.pr) {
      host.appendChild(el('p', 'wd-empty', it.status === 'running' ? 'The worker is still at it; changes show when it finishes.' : 'No changes yet.'));
      return;
    }
    if (r?.summary) {
      const s = section('Summary');
      const body = el('div', 'prose');
      body.innerHTML = renderMd(r.summary);
      s.appendChild(body);
      host.appendChild(s);
    }
    if (r) {
      const s = section(`Commits (${r.commits.length})`);
      const list = el('ul', 'wd-commits');
      for (const c of r.commits) {
        const li = el('li', '');
        li.append(el('code', 'wd-sha', c.sha.slice(0, 7)), el('span', '', c.subject));
        list.appendChild(li);
      }
      if (!r.commits.length) list.appendChild(el('li', 'wd-empty', 'No commits.'));
      s.appendChild(list);
      s.appendChild(el('pre', 'wd-diffstat', r.diffStat.text || `${r.diffStat.files} files changed, +${r.diffStat.insertions} −${r.diffStat.deletions}`));
      if (r.uncommitted.length) {
        s.appendChild(el('h5', 'wd-sub', 'Uncommitted'));
        const u = el('ul', 'wd-uncommitted');
        for (const f of r.uncommitted) u.appendChild(el('li', '', f));
        s.appendChild(u);
      }
      host.appendChild(s);
    }
    if (it.pr) renderPull(it, host);
  }

  function renderPull(it: WorkItem, host: HTMLElement): void {
    const pr = it.pr;
    if (!pr) return;
    const view = pull?.itemId === it.id ? pull.view : null;
    const s = section('Pull request');
    const line = el('div', 'wd-pr-line');
    const state = view?.state ?? pr.state ?? 'open';
    line.append(el('span', `wd-pr-state ${state}`, `#${pr.number} · ${state}${pr.draft && state === 'open' ? ' · draft' : ''}`));
    line.appendChild(linkButton('Open on GitHub', pr.url));
    const compare = compareUrl(it, repoOf(it)?.github ?? /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(pr.url)?.[1] ?? null);
    if (compare) line.appendChild(linkButton('Compare on GitHub', compare));
    s.appendChild(line);

    const checks = view?.checks ?? pr.checks ?? null;
    const ci = el('div', 'wd-ci');
    if (!checks) ci.appendChild(el('span', 'wd-ci-state none', 'Checks: not reported yet'));
    else {
      ci.appendChild(el('span', `wd-ci-state ${checks.state}`, `Checks: ${checks.state === 'failure' ? `${checks.failing.length} failing` : checks.state} · ${checks.sha.slice(0, 7)}`));
      if (checks.failing.length) {
        const list = el('ul', 'wd-failing');
        for (const f of checks.failing) {
          const li = el('li', '');
          li.appendChild(el('span', 'wd-failing-name', f.name));
          if (f.summary) li.appendChild(el('span', 'wd-failing-summary', f.summary));
          if (f.url) li.appendChild(linkButton('Details', f.url));
          list.appendChild(li);
        }
        ci.appendChild(list);
      }
    }
    s.appendChild(ci);

    const reviews = el('div', 'wd-reviews');
    reviews.appendChild(el('h5', 'wd-sub', view ? `Reviews and comments · rounds ${view.reviewRounds.used} of ${view.reviewRounds.max}` : 'Reviews and comments'));
    if (pull?.itemId === it.id && pull.error) reviews.appendChild(el('p', 'wd-empty', `Couldn't read the reviews: ${pull.error}`));
    else if (!view) reviews.appendChild(el('p', 'wd-empty', 'Loading…'));
    else if (!view.feedback.length) reviews.appendChild(el('p', 'wd-empty', 'No reviews or comments yet.'));
    else {
      const list = el('ul', 'wd-feedback');
      for (const f of view.feedback) {
        const li = el('li', `wd-fb${f.trusted ? '' : ' untrusted'}`);
        const head = el('div', 'wd-fb-head');
        head.appendChild(el('span', 'wd-fb-author', `@${f.author}`));
        const what = f.kind === 'review' ? (f.state === 'CHANGES_REQUESTED' ? 'requested changes' : f.state === 'APPROVED' ? 'approved' : 'reviewed') : f.kind === 'inline' ? `on ${f.where ?? 'a line'}` : 'commented';
        head.appendChild(el('span', 'wd-fb-what', what));
        head.appendChild(el('span', 'wd-fb-time', relTime(f.at)));
        if (!f.trusted) {
          const badge = el('span', 'wd-fb-untrusted', 'not sent to agents');
          badge.title = 'Only feedback from people with write access reaches agents.';
          head.appendChild(badge);
        }
        li.appendChild(head);
        if (f.body) {
          const body = el('div', 'prose wd-fb-body');
          body.innerHTML = renderMd(f.body);
          li.appendChild(body);
        }
        list.appendChild(li);
      }
      reviews.appendChild(list);
    }
    s.appendChild(reviews);
    host.appendChild(s);
  }

  function renderDetails(it: WorkItem): void {
    const key = JSON.stringify([it, Object.keys(store.capacity().agents), store.state()?.repos]);
    if (built.details === key) return;
    built.details = key;
    const host = els.details;
    const focused = host.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.field : undefined;
    const prevTitle = host.querySelector<HTMLInputElement>('[data-field="title"]');
    const prevBody = host.querySelector<HTMLTextAreaElement>('[data-field="body"]');
    const dirty = host.dataset.item === it.id && host.dataset.dirty === '1';
    const keep = dirty ? { title: prevTitle?.value ?? it.title, body: prevBody?.value ?? it.body } : null;
    host.textContent = '';
    host.dataset.item = it.id;
    host.dataset.dirty = dirty ? '1' : '0';

    const editable = EDITABLE.has(it.status);
    const form = el('div', 'wd-form config-form');
    const title = el('input', 'wd-title-input');
    title.dataset.field = 'title';
    title.value = keep?.title ?? it.title;
    title.maxLength = 200;
    title.disabled = !editable;
    title.setAttribute('aria-label', 'Title');
    const body = el('textarea', 'wd-body-input');
    body.dataset.field = 'body';
    body.value = keep?.body ?? it.body;
    body.rows = 8;
    body.disabled = !editable;
    body.placeholder = 'What should be done (markdown)';
    body.setAttribute('aria-label', 'Description');
    const save = button('btn-primary', 'Save');
    save.disabled = !dirty;
    const markDirty = (): void => {
      host.dataset.dirty = '1';
      save.disabled = false;
    };
    title.addEventListener('input', markDirty);
    body.addEventListener('input', markDirty);
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await ctx.daemon('item.update', { itemId: it.id, title: title.value.trim(), body: body.value });
        host.dataset.dirty = '0';
        ctx.say('');
      } catch (err) {
        save.disabled = false;
        ctx.say(errText(err));
      }
    });
    form.append(el('label', 'wd-label', 'Title'), title, el('label', 'wd-label', 'Description'), body);
    if (!editable) form.appendChild(el('p', 'wd-note', 'The title and description are read-only while the item runs.'));
    else {
      const row = el('div', 'wd-row');
      row.appendChild(save);
      form.appendChild(row);
    }
    host.appendChild(form);

    // Assignment: the agents the environment's definition assigns.
    const agents = Object.keys(store.capacity().agents).sort();
    const assign = el('div', 'wd-assign');
    assign.appendChild(el('label', 'wd-label', 'Agent'));
    const pick = el('select', 'wd-agent-select');
    pick.setAttribute('aria-label', 'Agent');
    const none = el('option', '', 'Unassigned');
    none.value = '';
    pick.appendChild(none);
    for (const a of agents) {
      const o = el('option', '', a);
      o.value = a;
      pick.appendChild(o);
    }
    pick.value = it.agent ?? '';
    const canAssign = it.status === 'backlog' || it.status === 'queued';
    pick.disabled = !canAssign;
    const row = el('div', 'wd-row');
    row.appendChild(pick);
    const assignBtn = button('btn-ghost', 'Assign');
    assignBtn.dataset.action = 'assign';
    assignBtn.disabled = !canAssign;
    assignBtn.addEventListener('click', async () => {
      if (!pick.value) return;
      try {
        await ctx.daemon('item.assign', { itemId: it.id, agent: pick.value });
      } catch (err) {
        ctx.say(errText(err));
      }
    });
    row.appendChild(assignBtn);
    if (it.status === 'queued') {
      const un = button('btn-ghost', 'Unassign');
      un.dataset.action = 'unassign';
      un.addEventListener('click', async () => {
        try {
          await ctx.daemon('item.assign', { itemId: it.id, agent: null });
        } catch (err) {
          ctx.say(errText(err));
        }
      });
      row.appendChild(un);
    }
    assign.appendChild(row);
    const repos = store.state()?.repos ?? [];
    if (repos.length > 1) {
      assign.appendChild(el('label', 'wd-label', 'Repository'));
      const repo = el('select', 'wd-repo-select');
      repo.setAttribute('aria-label', 'Repository');
      for (const r of repos) {
        const o = el('option', '', `${r.dir} (${r.github})`);
        o.value = r.dir;
        repo.appendChild(o);
      }
      repo.value = it.repo ?? repos[0]?.dir ?? '';
      repo.disabled = !(it.status === 'backlog' || it.status === 'queued');
      repo.addEventListener('change', async () => {
        try {
          await ctx.daemon('item.update', { itemId: it.id, repo: repo.value });
        } catch (err) {
          ctx.say(errText(err));
        }
      });
      assign.appendChild(repo);
    }
    host.appendChild(assign);

    const facts = el('dl', 'facts wd-facts');
    const fact = (k: string, v: string): void => {
      facts.append(el('dt', '', k), el('dd', '', v));
    };
    fact('Created', `${new Date(it.createdAt).toLocaleDateString()} ${fmtClock(it.createdAt)} by ${it.createdBy === 'orchestrator' ? 'the orchestrator' : 'you'}`);
    fact('Updated', relTime(it.updatedAt));
    if (it.source) fact('Issue', `${it.source.repo}#${it.source.number}`);
    if (it.lastError) fact('Last error', it.lastError);
    if (it.cancelReason) fact('Cancelled', it.cancelReason);
    if (it.acceptNote) fact('Accepted', it.acceptNote);
    host.appendChild(facts);
    if (it.source) host.appendChild(linkButton('Open the issue', it.source.url));
    if (focused) host.querySelector<HTMLElement>(`[data-field="${focused}"]`)?.focus();
  }

  function render(): void {
    const it = item();
    if (!it) {
      els.crumbTitle.textContent = itemId ? 'This item was deleted' : '';
      els.actions.textContent = '';
      els.meta.textContent = '';
      els.banner.classList.add('hidden');
      return;
    }
    for (const b of els.tabs.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    }
    els.conversation.classList.toggle('hidden', tab !== 'conversation');
    els.changes.classList.toggle('hidden', tab !== 'changes');
    els.details.classList.toggle('hidden', tab !== 'details');
    renderHeader(it);
    renderBanner(it);
    if (tab === 'conversation') renderConversation(it);
    else if (tab === 'changes') {
      loadPull(it);
      renderChanges(it);
    } else renderDetails(it);
  }

  return {
    show(next: string, nextTab: WorkTab): void {
      if (next !== itemId) {
        answering = false;
        els.details.dataset.dirty = '0';
        built.banner = built.changes = built.details = '';
      }
      itemId = next;
      tab = nextTab;
      render();
    },
    render,
    /** Another environment or a resync: the thread will be mounted again. */
    reset(): void {
      mountedSession = null;
      pull = null;
      built.banner = built.changes = built.details = '';
    },
    setUnread(on: boolean): void {
      els.unread.classList.toggle('hidden', !on);
    },
    itemId: (): string | null => itemId,
    sessionId: (): string | null => item()?.sessionId ?? null,
  };
}

export type WorkDetail = ReturnType<typeof initWorkDetail>;
