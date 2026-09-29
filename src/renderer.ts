/**
 * Renderer entry: the environment window. One environment on screen at a
 * time, in one of two views the top bar switches between (⌘1, ⌘2, and
 * remembered per environment): Chat, the orchestrator conversation in a
 * centered reading column, and Board, the work items as a Kanban board.
 * A work item's detail opens in a side sheet over either view. The top
 * bar also carries the environment switcher and status; Settings, the
 * start flow and the command palette are modals.
 *
 * The wiring layer only: DOM lookups, the nav applier, keyboard shortcuts
 * and boot. Every surface is its own module under src/renderer/ (context
 * in, controller out); the instance store holds the daemon's state and
 * the instance sync keeps it current.
 */

import './styles/shell.css';
import './styles/settings.css';
import './styles/work.css';
import './styles/flows.css';
import './styles/chat.css';
import './styles/overlays.css';
import type { HarnessProviderInfo, IntegrationProviderInfo, ProviderInfo, PuckBridge, RunnersState } from './harness/bridge';
import type { OpArgs, OpResult, RendererOp } from './harness/daemon-protocol';
import { initBoard } from './renderer/board';
import { liveWork } from './renderer/board-model';
import { initCommandPalette, type PaletteCommand } from './renderer/command-palette';
import { initComposer } from './renderer/composer';
import { watchDayRollover } from './renderer/day-clock';
import { conceal, el, showToast } from './renderer/dom';
import { initFirstRun } from './renderer/first-run';
import { fmtTokens, fmtUsd } from './renderer/format';
import { composerGate, createTicker, isWorking } from './renderer/instance-progress';
import { createInstanceStore, type StoreChange } from './renderer/instance-store';
import { initInstanceSync, type InstanceSync } from './renderer/instance-sync';
import { closePopup, openPopover, popupAnchor } from './renderer/popup';
import { initSessionView } from './renderer/session-view';
import { initSettingsModal } from './renderer/settings/modal';
import { initStartFlow } from './renderer/start-flow';
import { initTopbar } from './renderer/topbar';
import { button } from './renderer/util';
import { escapeTarget, INITIAL_NAV, navTransition, readView, saveView, type NavState, type NavTarget, type View } from './renderer/view-nav';
import { initViewSwitch } from './renderer/view-switch';
import { initWorkDetail } from './renderer/work-detail';

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

/** localStorage for per-machine conveniences; absent when the page may not use it. */
const storage = ((): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

const UPDATE_CHECK_MS = 15 * 60_000;

const STATUS_WORD: Record<string, string> = {
  backlog: 'backlog',
  queued: 'ready',
  running: 'running',
  'needs-input': 'needs input',
  review: 'in review',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

function boot(bridge: PuckBridge): void {
  let nav: NavState = INITIAL_NAV;
  let runners: RunnersState | null = null;
  let harnesses: HarnessProviderInfo[] = [];
  let login: string | null = null;
  /** An earlier (closed) orchestrator session shown read-only, or null for the current one. */
  let viewing: string | null = null;
  /** The orchestrator said something while the Chat view was not showing. */
  let unread = false;
  let lastUpdateCheck = 0;
  /** Where focus goes back to when the sheet closes. */
  let sheetReturn: HTMLElement | null = null;

  const say = (text: string): void => {
    if (text) showToast(text);
  };

  let sync: InstanceSync | null = null;
  const store = createInstanceStore({ requestResync: (envId) => sync?.resync(envId) });

  const current = () => {
    const id = store.envId();
    return id ? store.instance(id) : undefined;
  };

  function daemon<K extends RendererOp>(op: K, args: OpArgs<K>): Promise<OpResult<K>> {
    const envId = store.envId();
    if (!envId) return Promise.reject(new Error('Open an environment first.'));
    return bridge.daemon(envId, op, args);
  }

  /* ---------- Threads and composers ---------- */

  const ocChat = byId('oc-chat');
  const wdThread = byId('wd-thread');
  const center = byId('center');

  const sessions = initSessionView({
    store,
    history: (sessionId, before) => daemon('session.history', before === undefined ? { sessionId } : { sessionId, before }),
    answerAsk: async (sessionId, askId, answers) => {
      await daemon('ask.answer', { sessionId, askId, answers });
    },
    userName: () => login ?? 'You',
    orchestratorName: () => store.orchestrator()?.agent ?? 'orchestrator',
    capabilities: (harness) => harnesses.find((h) => h.id === harness)?.capabilities,
    openRef: (ref) => {
      const item = store.findItem(ref);
      if (item) openItem(item.id);
      else say(`${ref} is no longer on the board.`);
    },
    describeRef: (ref) => {
      const item = store.findItem(ref);
      return item ? `${ref} · ${item.title} · ${STATUS_WORD[item.status] ?? item.status}` : null;
    },
    onChild: (title, host) => {
      if (host === wdThread) {
        byId('wd-child-back').classList.toggle('hidden', title === null);
        return;
      }
      byId('oc-child-back').classList.toggle('hidden', title === null);
      renderOrchestrator(title);
    },
    toast: showToast,
    overlay: {
      body: byId('turn-full-body'),
      crumb: byId('turn-full-crumb'),
      title: byId('turn-full-title'),
      stage: center,
      backButton: byId('turn-full-back'),
    },
    storage,
  });
  byId('turn-full-back').addEventListener('click', () => sessions.closeFullTurn());
  byId('oc-child-back').addEventListener('click', () => sessions.closeChild(ocChat));
  byId('wd-child-back').addEventListener('click', () => sessions.closeChild(wdThread));
  watchDayRollover(window, () => sessions.refreshDays());

  const ocComposer = initComposer({
    els: { form: byId('oc-composer'), input: byId('oc-prompt'), send: byId('oc-send'), stop: byId('oc-stop'), hint: byId('oc-hint') },
    target: () => {
      const s = store.orchestrator();
      let gate = composerGate(current(), store.state()?.instance ?? null, s?.agent ?? null);
      if (gate.ready && !s) gate = { ready: false, placeholder: 'The orchestrator is starting…', reason: 'The orchestrator is starting.' };
      if (viewing) gate = { ready: false, placeholder: 'An earlier orchestrator session (read-only)', reason: 'This session is closed.' };
      return { sessionId: viewing ?? s?.id ?? null, running: s?.status === 'running', gate, who: 'the orchestrator' };
    },
    send: (sessionId, text) => daemon('chat.send', { sessionId, text }),
    interrupt: async (sessionId) => {
      await daemon('session.interrupt', { sessionId });
    },
    draft: sessions.draft,
    saveDraft: sessions.saveDraft,
    say: (text) => (byId('oc-msg').textContent = text),
  });

  const wdComposer = initComposer({
    els: { form: byId('wd-composer'), input: byId('wd-prompt'), send: byId('wd-send'), stop: byId('wd-stop'), hint: byId('wd-hint') },
    target: () => {
      const item = nav.itemId ? store.item(nav.itemId) : undefined;
      const s = item?.sessionId ? store.session(item.sessionId) : undefined;
      let gate = composerGate(current(), store.state()?.instance ?? null, item?.agent ?? null);
      if (gate.ready && item && !['running', 'needs-input', 'review', 'queued'].includes(item.status)) {
        gate = { ready: false, placeholder: `The item is ${STATUS_WORD[item.status] ?? item.status}: retry it to work on it again.`, reason: `The item is ${item.status}.` };
      }
      return { sessionId: s?.id ?? null, running: s?.status === 'running', gate, who: 'the worker' };
    },
    send: (sessionId, text) => daemon('chat.send', { sessionId, text }),
    interrupt: async (sessionId) => {
      await daemon('session.interrupt', { sessionId });
    },
    draft: sessions.draft,
    saveDraft: sessions.saveDraft,
    say: (text) => (byId('wd-msg').textContent = text),
  });

  /* ---------- Views ---------- */

  const board = initBoard({
    els: {
      columns: byId('bd-columns'),
      capacity: byId('bd-capacity'),
      paused: byId('bd-paused'),
      newBtn: byId('bd-new'),
      importBtn: byId('bd-import'),
    },
    store,
    daemon,
    openItem: (itemId, tab) => openItem(itemId, tab),
    selected: () => nav.itemId,
    toChat: () => pickView('chat'),
    openExternal: (url) => void bridge.openExternal(url),
    say,
    resync: () => {
      const id = store.envId();
      if (id) sync?.resync(id);
    },
    prefs: storage,
  });

  const workDetail = initWorkDetail({
    els: {
      close: byId('wd-close'),
      id: byId('wd-id'),
      title: byId('wd-title'),
      status: byId('wd-status'),
      meta: byId('wd-meta'),
      actions: byId('wd-actions'),
      banner: byId('wd-banner'),
      tabs: byId('wd-tabs'),
      conversation: byId('wd-conversation'),
      thread: wdThread,
      composerZone: byId('wd-composer-zone'),
      changes: byId('wd-changes'),
      details: byId('wd-details'),
    },
    store,
    sessions,
    daemon,
    openExternal: (url) => void bridge.openExternal(url),
    say,
    close: () => go({ view: 'close-item' }),
    onTab: (tab) => {
      if (nav.itemId) go({ view: 'item', itemId: nav.itemId, tab });
    },
    composer: wdComposer,
  });

  const viewSwitch = initViewSwitch(
    { root: byId('tb-views'), chat: byId('tb-view-chat'), board: byId('tb-view-board'), chatDot: byId('tb-chat-dot'), boardBadge: byId('tb-board-badge') },
    (view) => pickView(view),
  );

  /* ---------- Top bar, modals ---------- */

  const topbar = initTopbar({
    els: {
      env: byId('tb-env'),
      envName: byId('tb-env-name'),
      menu: byId('tb-menu'),
      status: byId('tb-status'),
      chips: byId('tb-chips'),
      banner: byId('tb-banner'),
      dialog: byId('tb-dialog'),
    },
    bridge,
    store,
    attach: () => sync?.view() ?? { phase: 'none', text: '', retry: false },
    open: (envId) => void openEnv(envId),
    reconnect: () => {
      const id = store.envId();
      if (id) void openEnv(id);
    },
    startFlow: () => go({ view: 'start' }),
    say,
  });

  const settings = initSettingsModal({
    bridge,
    els: {
      overlay: byId('settings-overlay'),
      nav: byId('settings-nav'),
      close: byId('settings-close'),
      sections: { providers: byId('sec-providers'), runners: byId('sec-runners'), support: byId('sec-support') },
      providers: { harnessCards: byId('pv-harness-cards'), integrationCards: byId('pv-integration-cards'), msg: byId('provider-msg') },
      runners: { cards: byId('rn-cards'), msg: byId('rn-msg') },
      support: {
        version: byId('support-version'),
        dataDir: byId('support-datadir'),
        logFile: byId('support-logfile'),
        exportBtn: byId('support-export'),
        msg: byId('support-msg'),
      },
    },
    copy: async (text) => {
      await navigator.clipboard?.writeText(text);
    },
    pick: (section) => go({ view: 'settings', section }),
    requestClose: () => go({ view: 'close-modal' }),
    onProviders: applyProviders,
  });

  const startFlow = initStartFlow({
    body: byId('sf-body'),
    bridge,
    store,
    runners: () => runners,
    // The window switches under the dialog, which keeps showing the progress.
    opened: (envId) => {
      showCenter('env');
      void openEnv(envId, false);
    },
    close: () => go({ view: 'close-modal' }),
    openRunners: () => go({ view: 'settings', section: 'runners' }),
    openProviders: () => go({ view: 'settings', section: 'providers' }),
  });
  byId('sf-close').addEventListener('click', () => go({ view: 'close-modal' }));

  const firstRun = initFirstRun({
    root: byId('fr'),
    bridge,
    runners: () => runners,
    openSettings: (section) => go({ view: 'settings', section }),
    startFlow: () => go({ view: 'start' }),
  });

  function newItem(): void {
    if (!store.hasSnapshot()) return;
    pickView('board');
    board.create();
  }

  const palette = initCommandPalette({
    instances: () => store.instances(),
    currentEnv: () => store.envId(),
    items: () => store.items(),
    history: () => [...ocChat.querySelectorAll('.row-body, .notice-text')].map((n) => n.textContent ?? ''),
    commands: () => {
      const cmds: PaletteCommand[] = [
        { label: 'Chat', hint: '⌘1', run: () => pickView('chat') },
        { label: 'Board', hint: '⌘2', run: () => pickView('board') },
        { label: 'New item', hint: '⌘N', run: newItem },
        {
          label: 'Import issue…',
          run: () => {
            pickView('board');
            board.importIssue();
          },
        },
        { label: 'Start environment…', run: () => go({ view: 'start' }) },
        { label: 'Settings', hint: '⌘,', run: () => go({ view: 'settings' }) },
        { label: 'Runners', run: () => go({ view: 'settings', section: 'runners' }) },
      ];
      if (store.hasSnapshot()) {
        const paused = store.capacity().paused;
        cmds.push({
          label: paused ? 'Resume the scheduler' : 'Pause the scheduler',
          run: () => void daemon(paused ? 'scheduler.resume' : 'scheduler.pause', {}).catch((err: unknown) => say(String(err))),
        });
      }
      return cmds;
    },
    openEnv: (envId) => void openEnv(envId),
    openItem: (itemId) => openItem(itemId),
    openHistory: () => pickView('chat'),
  });
  byId('tb-palette').addEventListener('click', () => palette.toggle());
  byId('open-settings').addEventListener('click', () => go({ view: 'settings' }));
  byId('oc-empty-start').addEventListener('click', () => go({ view: 'start' }));
  byId('oc-live').addEventListener('click', () => pickView('board'));
  byId('oc-resume').addEventListener('click', () => {
    byId('oc-hint').textContent = 'Send a message to resume automatic turns.';
    byId('oc-hint').classList.remove('hidden');
    ocComposer.focus();
  });
  byId('oc-current').addEventListener('click', () => {
    viewing = null;
    renderOrchestrator();
  });
  byId('oc-info').addEventListener('click', showSessionDetails);
  for (const b of byId('oc-suggest').querySelectorAll<HTMLButtonElement>('.oc-suggestion')) {
    b.addEventListener('click', () => {
      const input = byId<HTMLTextAreaElement>('oc-prompt');
      if (input.disabled) return;
      input.value = b.textContent ?? '';
      input.dispatchEvent(new Event('input'));
      input.focus();
    });
  }

  /* ---------- Chat header ---------- */

  function showSessionDetails(): void {
    const anchor = byId('oc-info');
    if (popupAnchor() === anchor) {
      closePopup();
      return;
    }
    const s = viewing ? store.session(viewing) : store.orchestrator();
    const box = el('div', 'oc-details');
    const facts = el('dl', 'oc-facts');
    const fact = (k: string, v: string): void => {
      facts.append(el('dt', '', k), el('dd', '', v));
    };
    if (s) {
      const harness = harnesses.find((h) => h.id === s.harness)?.label ?? s.harness;
      fact('Agent', `${s.agent} · ${harness}`);
      fact('Turns', s.turns.toLocaleString());
      fact('Last turn', `${fmtTokens(s.lastTurnTokens)} tokens`);
      fact('Session cost', fmtUsd(s.costUsd));
    }
    box.appendChild(facts);
    const earlier = store.closedOrchestrators();
    if (earlier.length) {
      box.appendChild(el('p', 'oc-details-label', 'Sessions'));
      const list = el('div', 'oc-sessions');
      const option = (id: string | null, label: string, sub: string): void => {
        const b = button('oc-session');
        b.setAttribute('aria-pressed', String((viewing ?? null) === id));
        b.append(el('span', 'oc-session-label', label), el('span', 'oc-session-sub', sub));
        b.addEventListener('click', () => {
          viewing = id;
          closePopup(true);
          renderOrchestrator();
        });
        list.appendChild(b);
      };
      const now = store.orchestrator();
      option(null, 'Current session', now ? `${now.turns} turns` : '');
      for (const e of earlier) option(e.id, new Date(e.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }), `${e.turns} turns · read-only`);
      box.appendChild(list);
    }
    openPopover(anchor, box, { label: 'Session details', align: 'start', className: 'oc-details-pop' });
  }

  /* ---------- Rendering ---------- */

  let childTitle: string | null = null;

  function renderOrchestrator(child: string | null | undefined = childTitle): void {
    childTitle = child ?? null;
    const envId = store.envId();
    const s = store.orchestrator();
    const hasEnv = !!envId;
    const oc = byId('oc');
    oc.classList.toggle('no-env', !hasEnv);
    byId('oc-empty').classList.toggle('hidden', hasEnv);
    ocChat.classList.toggle('hidden', !hasEnv);
    byId('oc-composer-zone').classList.toggle('hidden', !hasEnv);
    const shown = viewing ? store.session(viewing) : s;
    const agent = shown?.agent ?? 'Orchestrator';
    byId('oc-title').textContent = childTitle ? childTitle : agent;
    byId('oc-role').textContent = childTitle ? 'Sub-agent' : shown ? 'Orchestrator' : '';
    byId('oc-info').classList.toggle('hidden', !shown || !!childTitle);
    byId('oc-intro-avatar').textContent = (s?.agent[0] ?? 'P').toUpperCase();
    byId('oc-intro-title').textContent = s ? `${s.agent} is ready when you are` : 'Your orchestrator is ready';
    byId('oc-paused').classList.toggle('hidden', !s?.autoWakePaused);
    const live = liveWork(store.items());
    const liveBtn = byId('oc-live');
    liveBtn.classList.toggle('hidden', !store.hasSnapshot() || !live.text);
    liveBtn.classList.toggle('needs', live.needs > 0);
    if (liveBtn.dataset.text !== live.text) {
      liveBtn.dataset.text = live.text;
      liveBtn.textContent = '';
      const [first, ...rest] = live.text.split(' · ');
      const text = el('span', '');
      text.appendChild(el('span', live.needs ? 'oc-live-needs' : '', first ?? ''));
      if (rest.length) text.appendChild(document.createTextNode(` · ${rest.join(' · ')}`));
      liveBtn.append(el('span', 'oc-live-dot'), text);
      liveBtn.setAttribute('aria-label', `${live.text}. Show the board`);
    }
    const earlierBar = byId('oc-earlier-bar');
    earlierBar.classList.toggle('hidden', !viewing);
    if (viewing) {
      const e = store.session(viewing);
      byId('oc-earlier-text').textContent = e
        ? `An earlier session from ${new Date(e.createdAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}, read-only.`
        : 'An earlier session, read-only.';
    }
    const target = viewing ?? s?.id ?? null;
    if (nav.view === 'chat' && store.hasSnapshot() && target && sessions.mountedSession(ocChat) !== target) sessions.mount(target, ocChat);
    ocComposer.refresh();
  }

  function renderUser(): void {
    const node = byId('tb-user');
    node.textContent = login ? `@${login}` : '';
    node.title = login ? `Signed in to Puck as ${login}` : '';
  }

  function renderSwitch(): void {
    viewSwitch.show({
      view: nav.view,
      hidden: nav.center !== 'env' || !store.envId(),
      needs: liveWork(store.items()).needs,
      unread: unread && nav.view !== 'chat',
    });
  }

  /**
   * Which view shows. It depends on whether an environment is open as well
   * as on the nav, so every render applies it: an environment opened on a
   * remembered Board, or the last one removed, lands in the right view.
   */
  function showViews(): void {
    const env = nav.center === 'env';
    const hasEnv = !!store.envId();
    const chat = env && (nav.view === 'chat' || !hasEnv);
    conceal(byId('oc'), !chat);
    conceal(byId('board'), !(env && hasEnv && nav.view === 'board'));
    if (chat) {
      unread = false;
      renderOrchestrator();
    } else if (env) board.render();
    renderSwitch();
  }

  let frame = 0;
  function renderAll(): void {
    frame = 0;
    topbar.render();
    showViews();
    if (nav.itemId) {
      workDetail.render();
      wdComposer.refresh();
    }
    startFlow.changed();
    ticker.sync();
  }
  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(renderAll);
  }

  const ticker = createTicker({
    busy: () => board.busy() || isWorking(current()) || startFlow.busy(),
    onTick: (now) => {
      board.tick(now);
      topbar.tick();
      startFlow.tick();
    },
  });

  let shown: { center: NavState['center']; view: View; itemId: string | null } | null = null;

  function applyNav(): void {
    const { center: where, view, itemId, modal } = nav;
    const before = shown;
    shown = { center: where, view, itemId };
    const env = where === 'env';
    const hasEnv = !!store.envId();
    byId('fr').classList.toggle('hidden', where !== 'first-run');
    center.classList.toggle('first-run', where === 'first-run');
    showViews();

    const sheet = byId('wd');
    const open = env && hasEnv && !!itemId;
    conceal(sheet, !open);
    center.classList.toggle('sheet-open', open);
    if (open && itemId) {
      const opened = before?.itemId !== itemId;
      if (opened && !before?.itemId) {
        const active = document.activeElement;
        sheetReturn = active instanceof HTMLElement && active !== document.body && !sheet.contains(active) ? active : null;
      }
      workDetail.show(itemId, nav.tab);
      wdComposer.refresh();
      if (opened) byId('wd-title').focus({ preventScroll: true });
    } else if (before?.itemId) {
      sessions.closeChild(wdThread);
      const back = sheetReturn?.isConnected ? sheetReturn : null;
      sheetReturn = null;
      if (back) back.focus();
      else if (env && view === 'board') board.focusCard(before.itemId);
    }

    if (where === 'first-run') {
      if (before?.center !== 'first-run') void firstRun.show();
    } else firstRun.hide();

    if (modal === 'settings') settings.show(nav.section);
    else settings.hide();
    const sf = byId('sf');
    if (modal === 'start' && !startFlow.isOpen()) {
      sf.classList.remove('hidden');
      void startFlow.open();
      // The dialog itself takes focus: it announces its title without a ring on it.
      byId('sf-dialog').focus();
    } else if (modal !== 'start' && startFlow.isOpen()) {
      startFlow.close();
      sf.classList.add('hidden');
    }
  }

  /** Change what the window shows without closing a modal over it. */
  function showCenter(where: NavState['center']): void {
    nav = { ...nav, center: where };
    applyNav();
  }

  function go(target: NavTarget): void {
    if (target.view === 'chat' || target.view === 'board' || target.view === 'item' || target.view === 'close-item') sessions.closeFullTurn();
    closePopup();
    nav = navTransition(nav, target);
    applyNav();
  }

  function pickView(view: View): void {
    const envId = store.envId();
    if (envId) saveView(storage, envId, view);
    go({ view });
  }

  function openItem(itemId: string, tab?: 'details'): void {
    go(tab ? { view: 'item', itemId, tab } : { view: 'item', itemId });
  }

  async function openEnv(envId: string, closeModal = true): Promise<void> {
    viewing = null;
    unread = false;
    const view = readView(storage, envId);
    nav = closeModal ? navTransition({ ...nav, itemId: null }, { view }) : { ...nav, center: 'env', view, itemId: null };
    applyNav();
    try {
      await sync?.open(envId);
    } catch (err) {
      say(err instanceof Error ? err.message : String(err));
    }
    lastUpdateCheck = 0;
  }

  function applyProviders(infos: ProviderInfo[]): void {
    harnesses = infos.filter((p): p is HarnessProviderInfo => p.kind === 'harness');
    const github = infos.find((p): p is IntegrationProviderInfo => p.kind === 'integration' && p.id === 'github');
    login = github?.github.login ?? (runners?.signedIn ? runners.login : null);
    renderUser();
  }

  function maybeCheckUpdate(): void {
    if (!store.hasSnapshot() || Date.now() - lastUpdateCheck < UPDATE_CHECK_MS) return;
    lastUpdateCheck = Date.now();
    void topbar.checkUpdate();
  }

  /* ---------- Store and bridge events ---------- */

  sync = initInstanceSync({ bridge, store, say, onAttach: () => schedule() });

  store.subscribe((change: StoreChange) => {
    if (change.kind === 'event') {
      sessions.apply(change.seq, change.ev);
      const orch = store.state()?.orchestratorSessionId;
      const said = change.ev.kind === 'turn.notice' || change.ev.kind === 'turn.start';
      if (said && 'sessionId' in change.ev && change.ev.sessionId === orch && !(nav.center === 'env' && nav.view === 'chat')) unread = true;
    } else if (change.kind === 'reset' || change.kind === 'snapshot') {
      const was = sessions.reset();
      workDetail.reset();
      if (change.kind === 'reset') {
        board.reset();
        viewing = null;
        if (nav.itemId) go({ view: 'close-item' });
      } else {
        maybeCheckUpdate();
        // A resync keeps the view: mount the same threads again.
        if (was && nav.itemId) workDetail.render();
      }
    }
    schedule();
  });

  bridge.onRunnerEvent((event) => {
    if (event.kind === 'state') runners = event.state;
    else if (runners && event.kind === 'removed') runners = { ...runners, runners: runners.runners.filter((r) => r.id !== event.runnerId) };
    else if (runners && event.kind === 'upsert') {
      const have = runners.runners.some((r) => r.id === event.runner.id);
      runners = { ...runners, runners: have ? runners.runners.map((r) => (r.id === event.runner.id ? event.runner : r)) : [...runners.runners, event.runner] };
    }
    if (runners) {
      settings.runnersChanged(runners);
      if (nav.center === 'first-run') firstRun.runnersChanged(runners);
      if (!login && runners.signedIn && runners.login) {
        login = runners.login;
        renderUser();
      }
    }
    startFlow.changed();
  });

  bridge.onInstanceEvent((event) => {
    // A first environment: leave first run for it (a start dialog stays open).
    if (event.kind === 'upsert' && nav.center === 'first-run') showCenter('env');
  });

  // Quit waits for the renderer; everything here is already saved.
  bridge.onFlush(async () => undefined);

  /* ---------- Keyboard ---------- */

  document.addEventListener('keydown', (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (ev.key === 'Escape') {
      if (palette.close() || topbar.closeMenu() || closePopup(true) || topbar.closeDialog()) {
        ev.preventDefault();
        return;
      }
      if (nav.modal) {
        ev.preventDefault();
        go({ view: 'close-modal' });
        return;
      }
      if (center.classList.contains('turn-full-open')) {
        ev.preventDefault();
        sessions.closeFullTurn();
        return;
      }
      if (nav.itemId && sessions.closeChild(wdThread)) return;
      const next = escapeTarget(nav);
      if (next) {
        ev.preventDefault();
        go(next);
        return;
      }
      if (nav.view === 'chat') sessions.closeChild(ocChat);
      return;
    }
    if (!mod || ev.altKey) return;
    if (ev.key === 'k') {
      ev.preventDefault();
      palette.toggle();
    } else if (ev.key === 'n' && !nav.modal && nav.center === 'env') {
      ev.preventDefault();
      newItem();
    } else if ((ev.key === '1' || ev.key === '2') && !nav.modal && nav.center === 'env' && store.envId()) {
      ev.preventDefault();
      pickView(ev.key === '1' ? 'chat' : 'board');
    } else if (ev.key === ',') {
      ev.preventDefault();
      go({ view: 'settings' });
    }
  });
  document.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    if (!target.closest('.tb-switch')) topbar.closeMenu();
  });
  byId('tb-dialog').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) topbar.closeDialog();
  });

  window.addEventListener('focus', () => {
    settings.refresh();
    if (nav.center === 'first-run') void firstRun.refresh();
    maybeCheckUpdate();
  });
  setInterval(maybeCheckUpdate, UPDATE_CHECK_MS);

  /* ---------- Boot ---------- */

  void (async () => {
    const [list, state, infos] = await Promise.all([
      (sync as InstanceSync).load().catch((err: unknown) => {
        say(err instanceof Error ? err.message : String(err));
        return [];
      }),
      bridge.runners().catch(() => null),
      bridge.providers().catch((): ProviderInfo[] => []),
    ]);
    runners = state;
    applyProviders(infos);
    const pick = list.find((i) => i.current) ?? list[0];
    if (pick) {
      applyNav();
      await openEnv(pick.id);
      return;
    }
    showCenter('first-run');
    await firstRun.loaded();
    if (firstRun.ready() && nav.center === 'first-run') showCenter('env');
  })();
  applyNav();
}

// Dev only: `#fixture=<scenario>` boots on the seeded fixture bridge
// (src/renderer/fixture). Production builds drop this branch and its import.
if (process.env.NODE_ENV !== 'production' && location.hash.startsWith('#fixture')) {
  void import('./renderer/fixture').then(({ fixtureBridge, fixtureScenario }) => boot(fixtureBridge(fixtureScenario(location.hash))));
} else {
  const bridge = window.puck;
  if (bridge) boot(bridge);
}
