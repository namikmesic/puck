/**
 * Work detail: one ticket in the side sheet over the Chat or Board view.
 *
 * - Header: `W-12`, the status (and a Done ticket's outcome), Close (Esc
 *   also closes), the title, and the agent, `repo@branch`, attempts and the
 *   delivery pull request.
 * - Actions, as the ticket table allows: its worker running → Stop; its
 *   worker finished (the merge step waits) → Accept, Request changes
 *   (focuses the composer: a message opens a new round), Publish (always
 *   offered to the user); failed and cancelled → Retry; Cancel and Delete
 *   wherever allowed. Delete, and cancelling a started ticket, arm on
 *   first click.
 * - Tabs: Conversation (the worker's thread and a follow-up composer),
 *   Changes (summary, commits, diff stat, uncommitted files, the pull
 *   request with its CI checks and review feedback, "Compare on GitHub"),
 *   Workflow (the ticket's rounds and steps from `item.workflow`, newest
 *   first, reloaded as its steps change, and its references with Add link),
 *   Details (editable title and body when not running, the agent and repo
 *   pickers, timestamps, creator, last error). The repo picker shows no
 *   repository until one is saved, and is disabled once a worktree exists.
 *   Once a ticket has a session, the agent picker offers only that agent,
 *   and Unassign is not offered. Assign enables only for an agent the
 *   ticket can take, and follows the picker as it changes.
 * - An open question shows a banner: the question card when one is routed
 *   to the user (the oldest such), else "Waiting on the orchestrator" with
 *   "Answer myself". On the Conversation tab, where the thread already
 *   shows the card, the banner is one line that scrolls to it.
 * - A daemon that predates the three-column board: the sheet is read-only.
 *
 * Context in, controller out; no DOM lookups.
 */

import type { ClientResult, OpArgs, OpResult, PullView, Reference, RendererOp, RoundInfo, Step, WorkItem } from '../harness/daemon-protocol';
import { allows } from '../harness/item-transitions';
import { deliveryPull, referenceLabel, sourceIssue } from '../harness/references';
import { askCard } from './ask-card';
import { activeImplement, assignable, canUnassign, isRunning, LEGACY_READ_ONLY } from './board-model';
import { armDelete, conceal, el } from './dom';
import { fmtTime, relTime } from './format';
import type { InstanceStore } from './instance-store';
import { renderMd } from './markdown';
import type { SessionView } from './session-view';
import { statusIcon } from './status-icons';
import type { WorkTab } from './view-nav';
import { button, errText } from './util';

export type ItemAction = 'stop' | 'accept' | 'request-changes' | 'publish' | 'retry' | 'cancel' | 'delete';

/**
 * The header actions of a ticket. Each one the daemon decides maps to a
 * trigger the ticket table allows from its status and outcome (a unit test
 * holds this to the table); Stop interrupts the running turn, and Publish
 * is always the user's to press once the worker finished.
 */
export function itemActions(item: Pick<WorkItem, 'status' | 'outcome' | 'workflow'>): ItemAction[] {
  const state = { status: item.status, outcome: item.outcome };
  const out: ItemAction[] = [];
  const step = activeImplement(item);
  if (item.status === 'in-progress') {
    if (step?.state === 'running') out.push('stop');
    if (!step) out.push('accept', 'request-changes', 'publish');
  }
  if (allows(state, 'retry')) out.push('retry');
  if (allows(state, 'cancel')) out.push('cancel');
  if (allows(state, 'delete')) out.push('delete');
  return out;
}

const ACTION_LABEL: Record<ItemAction, string> = {
  stop: 'Stop',
  accept: 'Accept',
  'request-changes': 'Request changes',
  publish: 'Publish',
  retry: 'Retry',
  cancel: 'Cancel',
  delete: 'Delete',
};

/** The header's status word: "Todo", "In progress", "Done · merged". */
export function statusLabel(item: Pick<WorkItem, 'status' | 'outcome'>): string {
  if (item.status === 'todo') return 'Todo';
  if (item.status === 'in-progress') return 'In progress';
  return item.outcome ? `Done · ${item.outcome}` : 'Done';
}

export function statusTone(item: Pick<WorkItem, 'status' | 'outcome' | 'userAsks' | 'workflow'>): 'busy' | 'ask' | 'on' | 'bad' | 'off' {
  if (item.userAsks > 0) return 'ask';
  if (item.status === 'in-progress') return isRunning(item) ? 'busy' : 'on';
  if (item.status === 'done') return item.outcome === 'failed' ? 'bad' : item.outcome === 'cancelled' ? 'off' : 'on';
  return 'off';
}

const STEP_KIND: Record<Step['kind'], string> = {
  decompose: 'Plan',
  implement: 'Implement',
  checks: 'Checks',
  review: 'Review',
  publish: 'Publish',
  ci: 'CI',
  merge: 'Merge',
};

/** A step row's state words: "Running", "Waiting for you to accept or merge", "Passed". */
export function stepWords(step: Pick<Step, 'kind' | 'state' | 'result' | 'detail'>): string {
  if (step.state === 'done') return step.detail || (step.result ? step.result[0].toUpperCase() + step.result.slice(1) : 'Done');
  if (step.kind === 'merge' && step.state === 'waiting') return 'Waiting for you to accept or merge';
  const words: Record<string, string> = { pending: 'Pending', queued: 'Queued for a slot', running: 'Running', 'needs-input': 'Waiting on a question', waiting: 'Waiting' };
  return words[step.state] ?? step.state;
}

/** Encode a git ref for a GitHub path. Slashes stay, so `puck/W-1` and `release/1` are branch paths. */
const encodeRef = (ref: string): string => ref.split('/').map(encodeURIComponent).join('/');

/** `https://github.com/{owner/name}/compare/{base}...{branch}` once the branch is published. */
export function compareUrl(item: WorkItem, github: string | null): string | null {
  if (!deliveryPull(item) || !item.branch || !item.base || !github) return null;
  return `https://github.com/${github}/compare/${encodeRef(item.base.branch)}...${encodeRef(item.branch)}`;
}

export interface WorkDetailElements {
  close: HTMLButtonElement;
  /** `W-12`. */
  id: HTMLElement;
  title: HTMLElement;
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
  workflow: HTMLElement;
  details: HTMLElement;
}

export interface WorkDetailContext {
  els: WorkDetailElements;
  store: InstanceStore;
  sessions: SessionView;
  daemon<K extends RendererOp>(op: K, args: OpArgs<K>): Promise<ClientResult<K>>;
  openExternal(url: string): void;
  say(text: string): void;
  /** Close the sheet (Close, and after Delete). */
  close(): void;
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
  type RoundView = OpResult<'item.workflow'>;
  let flow: { itemId: string; key: string; current: RoundView | null; older: Map<number, RoundView | 'loading'>; error: string | null } | null = null;
  let answering = false;
  /** The thread has no card for the question (not loaded): answer in the banner instead. */
  let inline = false;
  /** What each part was last built from: an unrelated event does not rebuild it (and lose typing or a selection). */
  const built = { actions: '', banner: '', changes: '', workflow: '', details: '' };

  els.close.addEventListener('click', () => ctx.close());
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
          ctx.close();
          return;
      }
    } catch (err) {
      ctx.say(errText(err));
    }
  }

  /** True while the environment's daemon predates protocol 2: everything is read-only. */
  function readOnly(): boolean {
    return (store.state()?.daemon.protocol ?? 2) < 2;
  }

  function renderHeader(it: WorkItem): void {
    els.id.textContent = `W-${it.number}`;
    els.title.textContent = it.title;
    els.status.className = `wd-status tone-${statusTone(it)}`;
    els.status.textContent = '';
    els.status.append(el('span', 'dot'), document.createTextNode(statusLabel(it)));
    els.meta.textContent = '';
    const agent = el('span', `wd-agent${it.agent ? '' : ' none'}`);
    if (it.agent) agent.appendChild(el('span', 'bd-agent-mark', it.agent[0]?.toUpperCase() ?? '?'));
    agent.appendChild(document.createTextNode(it.agent ?? 'Unassigned'));
    els.meta.appendChild(agent);
    const repo = it.repo ?? repoOf(it)?.dir ?? null;
    if (repo) els.meta.appendChild(el('span', 'wd-repo', repo));
    if (it.branch) {
      const branch = el('code', 'wd-branch', it.branch);
      branch.title = `Branch ${it.branch}`;
      els.meta.appendChild(branch);
    }
    if (it.attempts > 1) els.meta.appendChild(el('span', 'wd-attempts', `Attempt ${it.attempts}`));
    const prRef = deliveryPull(it);
    if (prRef) {
      const url = prRef.url;
      const pr = button('wd-pr', `#${prRef.number}${prRef.state && prRef.state !== 'open' ? ` ${prRef.state}` : prRef.draft ? ' draft' : ''}`);
      pr.prepend(statusIcon('pr'));
      pr.title = `Open pull request #${prRef.number} on GitHub`;
      pr.addEventListener('click', () => ctx.openExternal(url));
      els.meta.appendChild(pr);
    }
    const actions = readOnly() ? [] : itemActions(it);
    const actionsKey = JSON.stringify([it.id, it.status, it.outcome, it.sessionId, actions]);
    if (built.actions === actionsKey) return;
    built.actions = actionsKey;
    els.actions.textContent = '';
    for (const action of actions) {
      const primary = action === 'accept' || (action === 'retry' && it.outcome === 'failed');
      const b = button(primary ? 'btn-primary small' : action === 'delete' || action === 'cancel' ? 'btn-ghost danger' : 'btn-ghost', ACTION_LABEL[action]);
      b.dataset.action = action;
      const run = (): Promise<void> => act(it, action);
      if (action === 'delete' || (action === 'cancel' && it.status === 'in-progress')) armDelete(b, run);
      else b.addEventListener('click', () => void run());
      els.actions.appendChild(b);
    }
  }

  /** The question the banner shows: the oldest routed to the user, else the oldest routed to the orchestrator. */
  function pendingOf(it: WorkItem): { askId: string; routedTo: 'user' | 'orchestrator' } | null {
    if (it.oldestUserAsk?.kind === 'question') return { askId: it.oldestUserAsk.askId, routedTo: 'user' };
    if (it.needsInput?.kind === 'question') return { askId: it.needsInput.askId, routedTo: it.needsInput.routedTo };
    return null;
  }

  function renderBanner(it: WorkItem): void {
    const pending = pendingOf(it);
    const ask = pending ? store.ask(pending.askId) : undefined;
    const key = JSON.stringify([it.id, pending, answering, inline, !!ask, tab, readOnly()]);
    if (built.banner === key) return;
    built.banner = key;
    els.banner.textContent = '';
    els.banner.classList.toggle('hidden', !pending);
    if (!pending) {
      answering = false;
      inline = false;
      return;
    }
    // An older daemon's tickets are read-only: the question shows, and nothing answers or takes it over from here.
    if (readOnly()) {
      answering = false;
      inline = false;
      const who = pending.routedTo === 'orchestrator' ? 'the orchestrator' : 'you';
      els.banner.appendChild(el('span', 'wd-banner-text', `${it.agent ?? 'The worker'} is waiting on ${who} to answer a question. ${LEGACY_READ_ONLY}`));
      return;
    }
    const submit = async (answers: Record<string, string> | null): Promise<void> => {
      if (!it.sessionId) return;
      if (readOnly()) throw new Error(LEGACY_READ_ONLY);
      try {
        await ctx.daemon('ask.answer', { sessionId: it.sessionId, askId: pending.askId, answers });
        answering = false;
      } catch (err) {
        ctx.say(`Couldn't send the answer: ${errText(err)}`);
        throw err;
      }
    };
    /** The thread's own card for the question, when the Conversation tab shows it. */
    const inThread = (): HTMLElement | null => (tab === 'conversation' ? els.thread.querySelector<HTMLElement>(`[data-ask-id="${CSS.escape(pending.askId)}"]`) : null);
    const goToCard = (card: HTMLElement): void => {
      card.scrollIntoView({ block: 'center' });
      card.querySelector<HTMLButtonElement>('.ask-option, button')?.focus({ preventScroll: true });
    };
    if (pending.routedTo === 'orchestrator' && !answering) {
      els.banner.appendChild(el('span', 'wd-banner-text', 'Waiting on the orchestrator to answer a question.'));
      const mine = button('btn-ghost', 'Answer myself');
      mine.disabled = !ask;
      mine.addEventListener('click', () => {
        answering = true;
        const card = inThread();
        if (card) goToCard(card);
        else inline = true;
        renderBanner(it);
        if (!card) els.banner.querySelector<HTMLButtonElement>('.ask-option, button')?.focus();
      });
      els.banner.appendChild(mine);
      return;
    }
    if (tab === 'conversation' && ask && !inline) {
      els.banner.appendChild(el('span', 'wd-banner-text', `${it.agent ?? 'The worker'} is waiting on your answer.`));
      const go = button('btn-ghost', 'Go to the question');
      go.addEventListener('click', () => {
        const card = inThread();
        if (card) {
          goToCard(card);
          return;
        }
        // Not in the thread (it did not load): answer here instead.
        inline = true;
        renderBanner(it);
        els.banner.querySelector<HTMLButtonElement>('.ask-option, button')?.focus();
      });
      els.banner.appendChild(go);
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
    if (mountedSession !== it.sessionId || ctx.sessions.mountedSession(els.thread) !== it.sessionId) {
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
    const pr = deliveryPull(it);
    return JSON.stringify([pr?.number, pr?.lastPushedSha, pr?.state, pr?.checks?.state, pr?.checks?.sha, it.updatedAt]);
  }

  function loadPull(it: WorkItem): void {
    if (!deliveryPull(it)) {
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
    const pr = deliveryPull(it);
    const key = JSON.stringify([it.id, it.status, it.result?.endedAt, pr, it.branch, pull?.view, pull?.error]);
    if (!force && built.changes === key) return;
    built.changes = key;
    const host = els.changes;
    host.textContent = '';
    const r = it.result;
    if (!r && !pr) {
      host.appendChild(el('p', 'wd-empty', isRunning(it) ? 'The worker is still at it; changes show when it finishes.' : 'No changes yet.'));
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
    if (pr) renderPull(it, host);
  }

  function renderPull(it: WorkItem, host: HTMLElement): void {
    const pr = deliveryPull(it);
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
    if (!checks) ci.appendChild(el('span', 'wd-ci-state none', 'Checks not reported yet'));
    else {
      const word = { success: 'Checks passed', failure: `${checks.failing.length} check${checks.failing.length === 1 ? '' : 's'} failing`, pending: 'Checks running', neutral: 'Checks finished' }[checks.state];
      const state = el('span', `wd-ci-state ${checks.state}`, word);
      state.appendChild(el('code', 'wd-sha', checks.sha.slice(0, 7)));
      ci.appendChild(state);
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
    const knownAgent = it.agent ?? (it.sessionId ? (store.session(it.sessionId)?.agent ?? null) : null);
    const key = JSON.stringify([it, Object.keys(store.capacity().agents), store.state()?.repos, knownAgent]);
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

    const editable = !isRunning(it) && !readOnly();
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
    const choices = assignable(it, agents, it.sessionId ? knownAgent : null);
    const assign = el('div', 'wd-assign');
    assign.appendChild(el('label', 'wd-label', 'Agent'));
    const pick = el('select', 'wd-agent-select');
    pick.setAttribute('aria-label', 'Agent');
    if (it.sessionId) {
      if (knownAgent) {
        const o = el('option', '', knownAgent);
        o.value = knownAgent;
        pick.appendChild(o);
      }
      pick.value = knownAgent ?? '';
    } else {
      const none = el('option', '', 'Unassigned');
      none.value = '';
      pick.appendChild(none);
      for (const a of agents) {
        const o = el('option', '', a);
        o.value = a;
        pick.appendChild(o);
      }
      pick.value = it.agent ?? '';
    }
    const savedAgent = it.sessionId ? (knownAgent ?? '') : (it.agent ?? '');
    const canChangeAgent = !readOnly() && (it.sessionId ? choices.length > 0 : it.status === 'todo');
    pick.disabled = !canChangeAgent;
    const row = el('div', 'wd-row');
    row.appendChild(pick);
    const assignBtn = button('btn-ghost', 'Assign');
    assignBtn.dataset.action = 'assign';
    const syncAssign = (): void => {
      assignBtn.disabled = !choices.includes(pick.value);
    };
    pick.addEventListener('change', () => {
      if (!choices.includes(pick.value)) pick.value = savedAgent;
      syncAssign();
    });
    syncAssign();
    assignBtn.addEventListener('click', async () => {
      if (!choices.includes(pick.value)) return;
      try {
        await ctx.daemon('item.assign', { itemId: it.id, agent: pick.value });
      } catch (err) {
        pick.value = savedAgent;
        syncAssign();
        ctx.say(errText(err));
      }
    });
    row.appendChild(assignBtn);
    if (canUnassign(it) && !readOnly()) {
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
      const savedRepo = it.repo ?? '';
      if (!it.repo) {
        const none = el('option', '', 'Choose a repository');
        none.value = '';
        repo.appendChild(none);
      }
      for (const r of repos) {
        const o = el('option', '', `${r.dir} (${r.github})`);
        o.value = r.dir;
        repo.appendChild(o);
      }
      repo.value = savedRepo;
      repo.disabled = !!it.worktree || it.status !== 'todo' || readOnly();
      repo.addEventListener('change', async () => {
        if (!repo.value) {
          repo.value = savedRepo;
          return;
        }
        try {
          await ctx.daemon('item.update', { itemId: it.id, repo: repo.value });
        } catch (err) {
          repo.value = savedRepo;
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
    const day = new Date(it.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    fact('Created', `${day}, ${fmtTime(it.createdAt)} by ${it.createdBy === 'orchestrator' ? 'the orchestrator' : it.createdBy === 'pipeline' ? 'Puck' : 'you'}`);
    fact('Updated', relTime(it.updatedAt));
    if (it.closedAt) fact('Closed', relTime(it.closedAt));
    const src = sourceIssue(it);
    if (src) fact('Issue', `${src.repo}#${src.number}`);
    if (it.lastError) fact('Last error', it.lastError);
    if (it.cancelReason) fact('Cancelled', it.cancelReason);
    if (it.acceptNote) fact(it.outcome === 'merged' ? 'Merged' : 'Accepted', it.acceptNote);
    host.appendChild(facts);
    if (src) host.appendChild(linkButton('Open the issue', src.url));
    if (focused) host.querySelector<HTMLElement>(`[data-field="${focused}"]`)?.focus();
  }

  /* ---------- Workflow ---------- */

  function flowKey(it: WorkItem): string {
    return JSON.stringify([it.id, it.status, it.outcome, it.workflow, it.updatedAt]);
  }

  /** Read the current round on open and whenever the ticket's steps change (the key-and-rebuild pattern of loadPull). */
  function loadFlow(it: WorkItem): void {
    const key = flowKey(it);
    if (flow && flow.itemId === it.id && flow.key === key) return;
    const mine: NonNullable<typeof flow> = {
      itemId: it.id,
      key,
      current: flow?.itemId === it.id ? flow.current : null,
      older: flow?.itemId === it.id ? flow.older : new Map(),
      error: null,
    };
    flow = mine;
    ctx
      .daemon('item.workflow', { itemId: it.id })
      .then((view) => {
        mine.current = view;
      })
      .catch((err: unknown) => {
        mine.error = errText(err);
      })
      .finally(() => {
        const now = item();
        if (flow === mine && tab === 'workflow' && now) renderWorkflow(now);
      });
  }

  function loadRound(it: WorkItem, round: number): void {
    const mine = flow;
    if (!mine || mine.itemId !== it.id || mine.older.has(round)) return;
    mine.older.set(round, 'loading');
    ctx
      .daemon('item.workflow', { itemId: it.id, round })
      .then((view) => mine.older.set(round, view))
      .catch(() => mine.older.delete(round))
      .finally(() => {
        const now = item();
        if (flow === mine && tab === 'workflow' && now) renderWorkflow(now, true);
      });
  }

  function duration(step: Step): string {
    if (!step.startedAt) return '';
    const end = step.finishedAt ?? Date.now();
    const s = Math.max(0, Math.round((end - step.startedAt) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
  }

  function stepRow(it: WorkItem, step: Step): HTMLElement {
    const li = el('li', `wd-step state-${step.state}${step.result ? ` result-${step.result}` : ''}`);
    li.dataset.step = step.id;
    li.appendChild(el('span', `wd-step-glyph ${step.state === 'done' ? `result-${step.result ?? 'done'}` : `state-${step.state}`}`));
    const main = el('div', 'wd-step-main');
    const head = el('div', 'wd-step-head');
    head.appendChild(el('span', 'wd-step-kind', STEP_KIND[step.kind]));
    if (step.agent) head.appendChild(el('span', 'wd-step-agent', step.agent));
    if (step.attempt > 1) head.appendChild(el('span', 'wd-step-attempt', `attempt ${step.attempt}`));
    const took = duration(step);
    if (took) head.appendChild(el('span', 'wd-step-time', took));
    main.appendChild(head);
    main.appendChild(el('div', 'wd-step-detail', stepWords(step)));
    if (step.kind === 'implement' && step.work) {
      main.appendChild(el('div', 'wd-step-work', `${step.work.commits} commit${step.work.commits === 1 ? '' : 's'}${step.work.head ? ` · ${step.work.head.slice(0, 7)}` : ''}`));
    }
    if (step.kind === 'implement' && step.sessionId && step.sessionId === it.sessionId) {
      const open = button('btn-ghost small', 'Open conversation');
      open.addEventListener('click', () => ctx.onTab('conversation'));
      main.appendChild(open);
    }
    li.appendChild(main);
    return li;
  }

  function roundBlock(it: WorkItem, round: RoundInfo, steps: Step[], open: boolean): HTMLElement {
    const box = el('details', 'wd-round');
    box.open = open;
    const summary = el('summary', 'wd-round-head');
    const head = round.headSha ? ` · commit ${round.headSha.slice(0, 7)}` : '';
    const state = round.outcome === 'open' ? 'open' : round.outcome;
    summary.appendChild(el('span', 'wd-round-title', `Round ${round.round}${head}`));
    summary.appendChild(el('span', 'wd-round-state', state));
    box.appendChild(summary);
    const list = el('ol', 'wd-steps');
    for (const step of steps.filter((s) => !(s.kind === 'decompose' && s.result === 'skipped'))) list.appendChild(stepRow(it, step));
    if (!list.childElementCount) list.appendChild(el('li', 'wd-empty', 'No steps in this round.'));
    box.appendChild(list);
    return box;
  }

  function nextLine(it: WorkItem): string {
    if (it.status === 'done') return it.outcome === 'merged' ? 'Merged on GitHub.' : it.outcome === 'accepted' ? 'Accepted.' : it.outcome === 'failed' ? 'Failed. Retry it to run a new round.' : 'Cancelled. Retry it to run a new round.';
    if (it.userAsks > 0) return `${it.agent ?? 'The worker'} is waiting on your answer.`;
    const step = activeImplement(it);
    if (step?.state === 'queued') return `Queued for ${step.agent ?? 'an agent'}; it starts when a slot is free.`;
    if (step) return `${step.agent ?? 'The worker'} is working on it.`;
    if (it.workflow?.steps.some((s) => s.kind === 'merge' && s.state === 'waiting')) {
      return 'Finished: accept it, publish and merge its pull request, or send the worker a message to start another round.';
    }
    return '';
  }

  function renderReferences(it: WorkItem, host: HTMLElement): void {
    const s = section('References');
    const list = el('ul', 'wd-refs');
    const label = (r: Reference): string => {
      if (r.role === 'source') return 'Source issue';
      if (r.role === 'delivery') return 'Pull request';
      if (r.role === 'followup-of') return 'Follow-up of';
      if (r.role === 'followup') return 'Follow-up';
      return 'Related';
    };
    for (const r of it.references) {
      const li = el('li', `wd-ref role-${r.role}`);
      li.appendChild(el('span', 'wd-ref-role', label(r)));
      if ('url' in r) {
        const open = button('wd-ref-link', referenceLabel(r));
        open.title = r.url;
        open.addEventListener('click', () => ctx.openExternal(r.url));
        li.appendChild(open);
      } else li.appendChild(el('span', 'wd-ref-link', referenceLabel(r)));
      if (r.role === 'related' && !readOnly()) {
        const remove = button('icon-btn wd-ref-remove');
        remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>';
        remove.setAttribute('aria-label', `Remove the link ${referenceLabel(r)}`);
        remove.addEventListener('click', async () => {
          try {
            await ctx.daemon('item.unlink', { itemId: it.id, referenceId: r.id });
          } catch (err) {
            ctx.say(errText(err));
          }
        });
        li.appendChild(remove);
      }
      list.appendChild(li);
    }
    if (!it.references.length) list.appendChild(el('li', 'wd-empty', 'No links. Add an issue, a pull request or a URL.'));
    s.appendChild(list);
    if (!readOnly()) {
      const row = el('form', 'wd-row wd-ref-add');
      const input = el('input', 'wd-ref-input');
      input.placeholder = 'owner/name#12, a GitHub link, or an https URL';
      input.setAttribute('aria-label', 'Add link');
      const add = button('btn-ghost', 'Add link');
      add.type = 'submit';
      row.append(input, add);
      row.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const ref = input.value.trim();
        if (!ref) return;
        add.disabled = true;
        try {
          await ctx.daemon('item.link', { itemId: it.id, ref });
          input.value = '';
          ctx.say('');
        } catch (err) {
          ctx.say(errText(err));
        } finally {
          add.disabled = false;
        }
      });
      s.appendChild(row);
    }
    host.appendChild(s);
  }

  function renderWorkflow(it: WorkItem, force = false): void {
    const current = flow?.itemId === it.id ? flow.current : null;
    const key = JSON.stringify([it.id, it.status, it.outcome, it.references, it.userAsks, current, flow?.error, [...(flow?.older ?? new Map()).entries()], readOnly()]);
    if (!force && built.workflow === key) return;
    built.workflow = key;
    const host = els.workflow;
    const openRounds = new Set([...host.querySelectorAll<HTMLDetailsElement>('details.wd-round[open]')].map((d) => d.dataset.round));
    host.textContent = '';
    const head = section('Workflow');
    head.appendChild(
      el(
        'p',
        'wd-flow-policy',
        'This environment has no delivery block: finished work waits for you to accept or merge. Add delivery: to its environment definition in the Puck home to run checks and a review panel.',
      ),
    );
    const next = nextLine(it);
    if (next) head.appendChild(el('p', 'wd-flow-next', next));
    host.appendChild(head);
    if (flow?.itemId === it.id && flow.error && !current) host.appendChild(el('p', 'wd-empty', `Couldn't read the workflow: ${flow.error}`));
    else if (!current) host.appendChild(el('p', 'wd-empty', 'Loading…'));
    else if (!current.round) host.appendChild(el('p', 'wd-empty', 'Nothing has started. Assign an agent, or plan the ticket.'));
    else {
      const rounds = el('div', 'wd-rounds');
      const latest = roundBlock(it, current.round, current.steps, true);
      latest.dataset.round = String(current.round.round);
      rounds.appendChild(latest);
      for (let r = current.round.round - 1; r >= 1; r--) {
        const got = flow?.older.get(r);
        if (got && got !== 'loading' && got.round) {
          const block = roundBlock(it, got.round, got.steps, openRounds.has(String(r)));
          block.dataset.round = String(r);
          rounds.appendChild(block);
          continue;
        }
        const stub = el('details', 'wd-round');
        stub.dataset.round = String(r);
        const sum = el('summary', 'wd-round-head');
        sum.appendChild(el('span', 'wd-round-title', `Round ${r}`));
        stub.appendChild(sum);
        stub.appendChild(el('p', 'wd-empty', got === 'loading' ? 'Loading…' : ''));
        stub.addEventListener('toggle', () => {
          if (stub.open) loadRound(it, r);
        });
        rounds.appendChild(stub);
      }
      host.appendChild(rounds);
    }
    renderReferences(it, host);
  }

  function render(): void {
    const it = item();
    if (!it) {
      if (itemId && store.hasSnapshot()) {
        ctx.close();
        return;
      }
      els.title.textContent = '';
      els.id.textContent = '';
      els.status.textContent = '';
      els.actions.textContent = '';
      built.actions = '';
      els.meta.textContent = '';
      els.banner.classList.add('hidden');
      return;
    }
    for (const b of els.tabs.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    }
    conceal(els.conversation, tab !== 'conversation');
    conceal(els.changes, tab !== 'changes');
    conceal(els.workflow, tab !== 'workflow');
    conceal(els.details, tab !== 'details');
    renderHeader(it);
    renderBanner(it);
    if (tab === 'conversation') renderConversation(it);
    else if (tab === 'changes') {
      loadPull(it);
      renderChanges(it);
    } else if (tab === 'workflow') {
      loadFlow(it);
      renderWorkflow(it);
    } else renderDetails(it);
  }

  return {
    show(next: string, nextTab: WorkTab): void {
      if (next !== itemId) {
        answering = false;
        inline = false;
        els.details.dataset.dirty = '0';
        built.actions = built.banner = built.changes = built.workflow = built.details = '';
        flow = null;
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
      flow = null;
      built.banner = built.changes = built.workflow = built.details = '';
    },
    itemId: (): string | null => itemId,
    sessionId: (): string | null => item()?.sessionId ?? null,
  };
}

export type WorkDetail = ReturnType<typeof initWorkDetail>;
