/**
 * Renderer entry for PUCK_UI=v2: the environment window. One environment on
 * screen at a time; the backlog on the left, the orchestrator chat (or one
 * work item's detail) in the center, work in progress on the right, the top
 * bar with the environment switcher, and Settings, the start flow and the
 * command palette as modals.
 *
 * The wiring layer only: DOM lookups, the nav applier, keyboard shortcuts
 * and boot. Every surface is its own module under src/renderer/ (context
 * in, controller out); the instance store holds the daemon's state and
 * the instance sync keeps it current. The legacy window stays the default
 * until cutover.
 */

import './styles/shell.css';
import './styles/settings.css';
import './styles/work.css';
import './styles/flows.css';
import './styles/chat.css';
import './styles/overlays.css';
import type { HarnessProviderInfo, IntegrationProviderInfo, ProviderInfo, PuckBridge, RunnersState } from './harness/bridge';
import type { OpArgs, OpResult, RendererOp } from './harness/daemon-protocol';
import { initBacklogPane } from './renderer/backlog-pane';
import { initCommandPalette, type PaletteCommand } from './renderer/command-palette';
import { initComposer } from './renderer/composer';
import { showToast } from './renderer/dom';
import { initFirstRun } from './renderer/first-run';
import { fmtTokens } from './renderer/format';
import { composerGate, createTicker, isWorking } from './renderer/instance-progress';
import { createInstanceStore, type StoreChange } from './renderer/instance-store';
import { initInstanceSync, type InstanceSync } from './renderer/instance-sync';
import { initPaneLayout } from './renderer/pane-layout';
import { initSessionView } from './renderer/session-view';
import { initSettingsModal } from './renderer/settings/modal';
import { initStartFlow } from './renderer/start-flow';
import { initTopbar } from './renderer/topbar';
import { escapeTarget, INITIAL_NAV, navTransition, type NavState, type NavTarget } from './renderer/view-nav';
import { initWorkDetail } from './renderer/work-detail';
import { initWorkPane } from './renderer/work-pane';

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

function boot(bridge: PuckBridge): void {
  let nav: NavState = INITIAL_NAV;
  let runners: RunnersState | null = null;
  let harnesses: HarnessProviderInfo[] = [];
  let login: string | null = null;
  /** An earlier (closed) orchestrator session shown read-only, or null for the current one. */
  let viewing: string | null = null;
  let childOpen = false;
  let lastUpdateCheck = 0;

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

  /* ---------- Layout ---------- */

  const narrow = window.matchMedia?.('(max-width: 1100px)');
  const panes = initPaneLayout({
    els: { root: byId('panes'), leftHandle: byId('resize-left'), rightHandle: byId('resize-right') },
    storage,
    narrow: () => narrow?.matches ?? false,
  });

  /* ---------- Threads and composers ---------- */

  const ocChat = byId('oc-chat');
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
      if (item) go({ view: 'work', itemId: item.id });
    },
    onChild: (title) => {
      childOpen = title !== null;
      byId('oc-child-back').classList.toggle('hidden', !(childOpen && nav.center === 'orchestrator'));
      if (title && nav.center === 'orchestrator') byId('oc-title').textContent = `Sub-agent · ${title}`;
      else renderOrchestrator();
    },
    toast: showToast,
    overlay: {
      body: byId('turn-full-body'),
      crumb: byId('turn-full-crumb'),
      title: byId('turn-full-title'),
      stage: byId('center'),
      backButton: byId('turn-full-back'),
    },
    storage,
  });
  byId('turn-full-back').addEventListener('click', () => sessions.closeFullTurn());
  byId('oc-child-back').addEventListener('click', () => sessions.closeChild());

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
      const item = workDetail.itemId() ? store.item(workDetail.itemId() as string) : undefined;
      const s = item?.sessionId ? store.session(item.sessionId) : undefined;
      let gate = composerGate(current(), store.state()?.instance ?? null, item?.agent ?? null);
      if (gate.ready && item && !['running', 'needs-input', 'review', 'queued'].includes(item.status)) {
        gate = { ready: false, placeholder: `The item is ${item.status}: retry it to work on it again.`, reason: `The item is ${item.status}.` };
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

  /* ---------- Panes ---------- */

  const backlog = initBacklogPane({
    els: { list: byId('bl-list'), add: byId('bl-add'), importBtn: byId('bl-import'), finished: byId('bl-finished'), tray: byId('bl-tray') },
    store,
    daemon,
    openItem: (itemId, tab) => go({ view: 'work', itemId, tab }),
    say,
    resync: () => {
      const id = store.envId();
      if (id) sync?.resync(id);
    },
    prefs: storage,
  });

  const workPane = initWorkPane({
    els: {
      needs: byId('wp-needs'),
      running: byId('wp-running'),
      review: byId('wp-review'),
      sections: byId('wp-sections'),
      empty: byId('wp-empty'),
      capacity: byId('wp-capacity'),
      paused: byId('wp-paused'),
    },
    store,
    daemon,
    openItem: (itemId) => {
      panes.closeDrawer();
      go({ view: 'work', itemId });
    },
    say,
  });

  const workDetail = initWorkDetail({
    els: {
      back: byId('wd-back'),
      unread: byId('wd-unread'),
      crumbTitle: byId('wd-title'),
      status: byId('wd-status'),
      meta: byId('wd-meta'),
      actions: byId('wd-actions'),
      banner: byId('wd-banner'),
      tabs: byId('wd-tabs'),
      conversation: byId('wd-conversation'),
      thread: byId('wd-thread'),
      composerZone: byId('wd-composer-zone'),
      changes: byId('wd-changes'),
      details: byId('wd-details'),
    },
    store,
    sessions,
    daemon,
    openExternal: (url) => void bridge.openExternal(url),
    say,
    back: () => {
      if (!sessions.closeChild()) go({ view: 'orchestrator' });
    },
    onTab: (tab) => {
      if (nav.itemId) go({ view: 'work', itemId: nav.itemId, tab });
    },
    composer: wdComposer,
  });

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
      showCenter('orchestrator');
      void openEnv(envId, false);
    },
    close: () => go({ view: 'close-modal' }),
    openRunners: () => go({ view: 'settings', section: 'runners' }),
  });
  byId('sf-close').addEventListener('click', () => go({ view: 'close-modal' }));

  const firstRun = initFirstRun({
    root: byId('fr'),
    bridge,
    runners: () => runners,
    openSettings: (section) => go({ view: 'settings', section }),
    startFlow: () => go({ view: 'start' }),
  });

  const palette = initCommandPalette({
    instances: () => store.instances(),
    currentEnv: () => store.envId(),
    items: () => store.items(),
    history: () => [...ocChat.querySelectorAll('.row-body, .notice-text')].map((n) => n.textContent ?? ''),
    commands: () => {
      const cmds: PaletteCommand[] = [
        { label: 'New item', hint: '⌘N', run: () => backlog.create() },
        { label: 'Import issue…', run: () => backlog.importIssue() },
        { label: 'Start environment…', run: () => go({ view: 'start' }) },
        { label: 'Orchestrator', hint: '⌘1', run: () => go({ view: 'orchestrator' }) },
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
    openItem: (itemId) => go({ view: 'work', itemId }),
    openHistory: () => go({ view: 'orchestrator' }),
  });
  byId('tb-palette').addEventListener('click', () => palette.toggle());
  byId('open-settings').addEventListener('click', () => go({ view: 'settings' }));
  byId('oc-empty-start').addEventListener('click', () => go({ view: 'start' }));
  byId('oc-resume').addEventListener('click', () => {
    byId('oc-hint').textContent = 'Send a message to resume automatic turns.';
    byId('oc-hint').classList.remove('hidden');
    ocComposer.focus();
  });
  byId('oc-earlier').addEventListener('change', () => {
    const value = (byId<HTMLSelectElement>('oc-earlier')).value;
    viewing = value || null;
    renderOrchestrator();
  });

  /* ---------- Rendering ---------- */

  function renderOrchestrator(): void {
    const envId = store.envId();
    const s = store.orchestrator();
    const hasEnv = !!envId;
    byId('oc-empty').classList.toggle('hidden', hasEnv);
    ocChat.classList.toggle('hidden', !hasEnv);
    byId('oc-composer-zone').classList.toggle('hidden', !hasEnv);
    if (!childOpen) byId('oc-title').textContent = s ? `Orchestrator · ${s.agent}` : 'Orchestrator';
    byId('oc-stats').textContent = s && s.turns ? `${fmtTokens(s.lastTurnTokens)} tokens last turn${s.costUsd ? ` · $${s.costUsd.toFixed(2)}` : ''}` : '';
    byId('oc-paused').classList.toggle('hidden', !s?.autoWakePaused);
    const earlier = store.closedOrchestrators();
    const select = byId<HTMLSelectElement>('oc-earlier');
    select.classList.toggle('hidden', !earlier.length);
    if (earlier.length && select.options.length !== earlier.length + 1) {
      select.textContent = '';
      const now = document.createElement('option');
      now.value = '';
      now.textContent = 'Current session';
      select.appendChild(now);
      for (const e of earlier) {
        const o = document.createElement('option');
        o.value = e.id;
        o.textContent = `Earlier: ${new Date(e.createdAt).toLocaleDateString()} (${e.turns} turns)`;
        select.appendChild(o);
      }
    }
    select.value = viewing ?? '';
    const target = viewing ?? s?.id ?? null;
    if (nav.center === 'orchestrator' && store.hasSnapshot() && target && sessions.mountedSession() !== target) sessions.mount(target, ocChat);
    ocComposer.refresh();
  }

  function renderUser(): void {
    const node = byId('tb-user');
    node.textContent = login ? `@${login}` : '';
    node.title = login ? `Signed in to Puck as ${login}` : '';
  }

  let frame = 0;
  function renderAll(): void {
    frame = 0;
    topbar.render();
    backlog.render();
    workPane.render();
    if (nav.center === 'orchestrator') renderOrchestrator();
    if (nav.center === 'work') {
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
    busy: () => workPane.busy() || isWorking(current()) || startFlow.busy(),
    onTick: (now) => {
      workPane.tick(now);
      topbar.tick();
      startFlow.tick();
    },
  });

  let shownCenter: NavState['center'] | null = null;

  function applyNav(): void {
    const { center, modal } = nav;
    const entered = center !== shownCenter;
    shownCenter = center;
    byId('oc').classList.toggle('hidden', center !== 'orchestrator');
    byId('wd').classList.toggle('hidden', center !== 'work');
    byId('fr').classList.toggle('hidden', center !== 'first-run');
    byId('panes').classList.toggle('first-run', center === 'first-run');
    byId('oc-child-back').classList.toggle('hidden', !(childOpen && center === 'orchestrator'));
    if (center === 'orchestrator') renderOrchestrator();
    if (center === 'work' && nav.itemId) {
      workDetail.setUnread(false);
      workDetail.show(nav.itemId, nav.tab);
      wdComposer.refresh();
    }
    if (center === 'first-run') {
      if (entered) void firstRun.show();
    } else firstRun.hide();

    if (modal === 'settings') settings.show(nav.section);
    else settings.hide();
    const sf = byId('sf');
    if (modal === 'start' && !startFlow.isOpen()) {
      sf.classList.remove('hidden');
      void startFlow.open();
      byId('sf-title').focus();
    } else if (modal !== 'start' && startFlow.isOpen()) {
      startFlow.close();
      sf.classList.add('hidden');
    }
  }

  /** Change what the center shows without closing a modal over it. */
  function showCenter(center: 'orchestrator' | 'first-run'): void {
    nav = { ...nav, center };
    applyNav();
  }

  function go(target: NavTarget): void {
    if (target.view === 'orchestrator' || target.view === 'work') sessions.closeFullTurn();
    nav = navTransition(nav, target);
    applyNav();
  }

  async function openEnv(envId: string, closeModal = true): Promise<void> {
    viewing = null;
    if (closeModal) go({ view: 'orchestrator' });
    else if (nav.center !== 'orchestrator') showCenter('orchestrator');
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
      if (nav.center === 'work' && 'sessionId' in change.ev && change.ev.sessionId === orch && (change.ev.kind === 'turn.notice' || change.ev.kind === 'turn.start')) {
        workDetail.setUnread(true);
      }
    } else if (change.kind === 'reset' || change.kind === 'snapshot') {
      const was = sessions.reset();
      workDetail.reset();
      if (change.kind === 'reset') {
        backlog.reset();
        viewing = null;
        if (nav.center === 'work') go({ view: 'orchestrator' });
      } else {
        maybeCheckUpdate();
        // A resync keeps the view: mount the same thread again.
        if (was && nav.center === 'work') workDetail.render();
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
    if (event.kind === 'upsert' && nav.center === 'first-run') showCenter('orchestrator');
  });

  // Quit waits for the renderer; everything here is already saved.
  bridge.onFlush(async () => undefined);

  /* ---------- Keyboard ---------- */

  document.addEventListener('keydown', (ev) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (ev.key === 'Escape') {
      if (palette.close() || topbar.closeMenu() || workPane.closeMenu() || topbar.closeDialog()) {
        ev.preventDefault();
        return;
      }
      const fullOpen = byId('center').classList.contains('turn-full-open');
      if (nav.modal) {
        ev.preventDefault();
        go({ view: 'close-modal' });
        return;
      }
      if (fullOpen) {
        ev.preventDefault();
        sessions.closeFullTurn();
        return;
      }
      if (panes.closeDrawer()) return;
      if (childOpen && sessions.closeChild()) return;
      const next = escapeTarget(nav);
      if (next) {
        ev.preventDefault();
        go(next);
      }
      return;
    }
    if (!mod) return;
    if (ev.key === 'k') {
      ev.preventDefault();
      palette.toggle();
    } else if (ev.key === 'n' && !nav.modal) {
      ev.preventDefault();
      backlog.create();
    } else if (ev.key === '1') {
      ev.preventDefault();
      go({ view: 'orchestrator' });
    } else if (ev.key === '[') {
      ev.preventDefault();
      panes.toggleLeft();
    } else if (ev.key === ']') {
      ev.preventDefault();
      panes.toggleRight();
    } else if (ev.key === ',') {
      ev.preventDefault();
      go({ view: 'settings' });
    }
  });
  document.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    if (!target.closest('.tb-switch')) topbar.closeMenu();
    if (!target.closest('.wp-row')) workPane.closeMenu();
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
    if (firstRun.ready() && nav.center === 'first-run') showCenter('orchestrator');
  })();
  applyNav();
}

const bridge = window.puck;
if (bridge) boot(bridge);
