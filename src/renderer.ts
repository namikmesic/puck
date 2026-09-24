/**
 * Renderer entry point: chat frontend for the Puck harness.
 *
 * Turns run in the main process — the active provider (Claude Code or Codex)
 * executes inside a Docker environment container — and stream back as
 * `HarnessEvent`s over the preload bridge (see src/harness/bridge.ts).
 */

// One stylesheet per surface; import order preserves the original cascade.
import './styles/shell.css';
import './styles/settings.css';
import './styles/editors.css';
import './styles/chat.css';
import './styles/overlays.css';
import './harness/bridge';
import { armDelete, el, showToast, statusEl } from './renderer/dom';
import { button, errText, latestToken, SEND_ICON, STOP_ICON } from './renderer/util';
import { createSessionStore, type Session } from './renderer/session-store';
import { applyEvent, initChatView } from './renderer/chat-view';
import { initAgentEditor } from './renderer/settings/agent-editor';
import { initEnvEditor } from './renderer/settings/env-editor';
import { initSupportView } from './renderer/settings/support';
import { initPalette } from './renderer/palette';
import { initRoster } from './renderer/roster';
import {
  escapeTarget,
  navTransition,
  type NavState,
  type NavTarget,
  type SettingsSection,
  type View,
} from './renderer/nav';
import { addCard, cardShell, loadingInto } from './renderer/settings/cards';
import { envOpRail } from './renderer/settings/env-rail';
import {
  composerGate,
  createLifecycleTracker,
  heroLine,
  pickLifecycle,
  renderProgress,
  statusChip,
  statusTone,
} from './renderer/env-progress';
import { IpcHarness } from './harness/ipc';
import type {
  AgentInfo,
  ConversationEntry,
  EnvironmentInfo,
  HarnessStatus,
  ProviderCapabilities,
  ProviderInfo,
  PuckBridge,
} from './harness/bridge';

/** Provider metadata cache — labels, hints, capabilities come from main. */
let providersById = new Map<string, ProviderInfo>();

async function loadProviders(): Promise<ProviderInfo[]> {
  const infos = (await bridge?.providers().catch(() => [])) ?? [];
  if (infos.length) providersById = new Map(infos.map((p) => [p.id, p]));
  return infos;
}

function providerLabel(id: string): string {
  return providersById.get(id)?.label ?? id;
}

const bridge: PuckBridge | undefined = window.puck;
const harness = bridge ? new IpcHarness(bridge) : null;

/** Typed lookup for the static ids in index.html. Editor-page elements are
 *  looked up inline at the module init sites; only ids this file touches
 *  more than once (or in listeners) get a named binding. */
const byId = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const stage = byId('stage');
const chat = byId('chat');
const composer = byId<HTMLFormElement>('composer');
const prompt = byId<HTMLTextAreaElement>('prompt');
const send = byId<HTMLButtonElement>('send');
const recentsList = byId<HTMLUListElement>('recents');
const addAgentBtn = byId<HTMLButtonElement>('add-agent');
const chatHead = byId('chat-head');
const chatHeadName = byId('chat-head-name');
const chatHeadTag = byId('chat-head-tag');
const turnFullBack = byId<HTMLButtonElement>('turn-full-back');
const openSettingsBtn = byId<HTMLButtonElement>('open-settings');
const settingsNav = byId('settings-nav');
const settingsOverlay = byId('settings-overlay');
const settingsClose = byId<HTMLButtonElement>('settings-close');
const sidebarEl = document.querySelector('.sidebar') as HTMLElement;
const envselBtn = byId<HTMLButtonElement>('envsel-btn');
const envselDot = byId('envsel-dot');
const envselName = byId('envsel-name');
const agentCards = byId('agent-cards');
const agentMsg = byId('agent-msg');
const agentDetailView = byId('agent-detail-view');
const agentTitle = byId('agent-title');
const heroSubtitle = byId('hero-subtitle');
const heroTitle = byId('hero-title');
const heroAvatar = byId('hero-avatar');
const heroCta = byId<HTMLButtonElement>('hero-cta');

/** Display label for the human author; persisted entries store 'user'. */
const USER_NAME = 'You';
const settingsView = byId('settings-view');
const providerCards = byId('provider-cards');
const envCards = byId('env-cards');
const envMsg = byId('env-msg');
const providerMsg = byId('provider-msg');
const envDetailView = byId('env-detail-view');
const detailTitle = byId('detail-title');
const secAgents = byId('sec-agents');
const secProviders = byId('sec-providers');
const secEnvs = byId('sec-envs');
const secSupport = byId('sec-support');
const secAgentsTitle = byId('sec-agents-title');
const secProvidersTitle = byId('sec-providers-title');
const secEnvsTitle = byId('sec-envs-title');
const secSupportTitle = byId('sec-support-title');

// Sticky scrolling: follow the stream only while the user is at the bottom.
let stickToBottom = true;
chat.addEventListener('scroll', () => {
  stickToBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 48;
});

function scrollChat(force = false): void {
  if (!force && !stickToBottom) return;
  chat.scrollTo({ top: chat.scrollHeight });
}

/* ---------- Markdown link containment ---------- */

// Chat anchors are sanitized in renderer/markdown.ts; clicks route to the
// system browser here — a link must never navigate the app window.
document.addEventListener('click', (e) => {
  const anchor = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
  if (!anchor) return;
  e.preventDefault();
  if (/^https?:\/\//i.test(anchor.href)) void bridge?.openExternal(anchor.href);
});

/* ---------- Harness status + environment lifecycle ---------- */

/** The active environment's lifecycle as last reported (status call or push). */
let activeEnv: HarnessStatus['environment'] = null;

function applyStatus(s: HarnessStatus): void {
  activeEnv = s.environment;
  if (activeEnv) tracker.seed([activeEnv]);
  applyEnvChrome(Date.now());
}

/** Everything in the chat that reflects the active environment: selector dot, hero, composer. */
function applyEnvChrome(now: number): void {
  const env = activeEnv;
  envselName.textContent = env?.name ?? 'no environment';
  envselDot.className = 'dot-mini ' + (env ? statusTone(env.status) : '');
  stage.classList.toggle('connected', env?.status === 'ready');
  const who = current.agentId ? current.title : 'your agent';
  heroSubtitle.textContent = heroLine(env, who, agentInfos.length > 0, now);
  syncComposer();
}

async function refreshStatus(): Promise<void> {
  if (!bridge) return;
  try {
    applyStatus(await bridge.status());
  } catch (err) {
    console.error('status refresh failed', err);
  }
}

/* ---------- Dropdown menus (provider / model) ---------- */

let menu: HTMLElement | null = null;

function closeMenu(): void {
  menu?.remove();
  menu = null;
}

interface MenuItem {
  value: string;
  label: string;
  active?: boolean;
}

/** Drop-up menu anchored to a composer selector button. */
function openMenuUp(anchor: HTMLElement, items: MenuItem[], onPick: (value: string) => void): void {
  closeMenu();
  if (!items.length) return;
  menu = el('div', 'model-menu menu-up');
  menu.style.left = `${anchor.offsetLeft}px`;
  for (const entry of items) {
    const item = button('model-item' + (entry.active ? ' active' : ''), entry.label);
    item.addEventListener('click', () => {
      closeMenu();
      onPick(entry.value);
    });
    menu.appendChild(item);
  }
  composer.appendChild(menu);
}

envselBtn.addEventListener('click', async () => {
  if (!bridge || menu) return closeMenu();
  const envs = await bridge.envList().catch(() => []);
  const items: MenuItem[] = envs.map((e) => ({
    value: e.id,
    label: `${e.name}${e.status === 'ready' ? '' : ` — ${e.status}`}`,
    active: e.active,
  }));
  items.push({ value: '__manage', label: '⚙ Manage environments…' });
  openMenuUp(envselBtn, items, (value) => {
    if (value === '__manage') {
      return nav({ view: 'settings', section: 'envs' });
    }
    void bridge.envSelect(value).then(applyStatus);
  });
});

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (menu && !target.closest('.model-menu') && !target.closest('.picker')) closeMenu();
});

/* ---------- Navigation: the settings modal over the chat ---------- */

// State rules (last-used section, Escape ladder) are pure and tested in
// src/renderer/nav.ts; this file is the DOM applier.
let navState: NavState = { view: 'chat', lastSection: 'agents' };

/** The single navigation entry point — every view change goes through here. */
function nav(target: NavTarget): void {
  navState = navTransition(navState, target);
  switch (target.view) {
    case 'chat':
    case 'settings':
      showView(target.view);
      break;
    case 'agent-detail':
      void agentEditor.open(target.agent); // reveals the view once populated
      break;
    case 'env-detail':
      envEditor.open(target.env);
      break;
  }
}

/** Highlights the active section in the sidebar menu (parent section on detail pages). */
function syncSettingsNavActive(): void {
  settingsNav.querySelectorAll<HTMLElement>('.nav-item[data-section]').forEach((btn) => {
    btn.classList.toggle(
      'active',
      navState.view !== 'chat' && btn.dataset.section === navState.lastSection,
    );
  });
}

function showSettingsSection(section: SettingsSection): void {
  navState = { ...navState, lastSection: section };
  secAgents.classList.toggle('hidden', section !== 'agents');
  secProviders.classList.toggle('hidden', section !== 'providers');
  secEnvs.classList.toggle('hidden', section !== 'envs');
  secSupport.classList.toggle('hidden', section !== 'support');
  syncSettingsNavActive();
  if (section === 'agents') {
    void renderAgents();
    secAgentsTitle.focus();
  } else if (section === 'providers') {
    void renderProviders();
    secProvidersTitle.focus();
  } else if (section === 'support') {
    void supportView.render();
    secSupportTitle.focus();
  } else {
    void renderEnvs();
    secEnvsTitle.focus();
  }
}

function showView(view: View): void {
  // Direct callers (the editor's deferred reveal, openDetail) sync the state.
  navState = { ...navState, view };
  const modalOpen = view !== 'chat';
  // Settings live in a modal over the chat; the stage stays mounted beneath.
  settingsOverlay.classList.toggle('hidden', !modalOpen);
  settingsView.classList.toggle('hidden', view !== 'settings');
  envDetailView.classList.toggle('hidden', view !== 'env-detail');
  agentDetailView.classList.toggle('hidden', view !== 'agent-detail');
  // Nothing behind or beside the open modal may hold focus or be AT-reachable.
  stage.inert = modalOpen;
  sidebarEl.inert = modalOpen;
  settingsView.inert = view !== 'settings';
  envDetailView.inert = view !== 'env-detail';
  agentDetailView.inert = view !== 'agent-detail';
  openSettingsBtn.classList.toggle('active', modalOpen);
  // Leaving a detail page abandons it (the env delete flow relies on this).
  if (view !== 'agent-detail') agentEditor.abandon();
  if (view !== 'env-detail') envEditor.abandon();
  syncSettingsNavActive();
  if (view === 'settings') {
    showSettingsSection(navState.lastSection);
  } else if (view === 'env-detail') {
    detailTitle.focus();
  } else if (view === 'agent-detail') {
    agentTitle.focus();
  } else {
    stopAuthPoll(); // leaving settings abandons any pending connect poll
    void refreshStatus();
    prompt.focus();
  }
}

// Escape steps back: detail → its section list → close the modal.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (palette.isOpen()) return palette.close();
  if (menu) return closeMenu();
  const target = escapeTarget(navState);
  if (!target) {
    closeFullTurn(); // in chat: dismiss a full-screen turn if one is open
    return;
  }
  nav(target);
});

openSettingsBtn.addEventListener('click', () => nav({ view: 'settings' }));
settingsClose.addEventListener('click', () => nav({ view: 'chat' }));
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) nav({ view: 'chat' }); // backdrop click closes
});
settingsNav.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.nav-item') as HTMLElement | null;
  const section = btn?.dataset.section as SettingsSection | undefined;
  if (section) nav({ view: 'settings', section });
});
heroCta.addEventListener('click', () => nav({ view: 'settings', section: 'envs' }));

/* ---------- Providers view ---------- */

// A login completes in the system browser; main reports `auth.pending` until
// its loopback callback lands, fails, or times out - the view polls that.
let authPoll: ReturnType<typeof setInterval> | null = null;

function stopAuthPoll(): void {
  if (authPoll) clearInterval(authPoll);
  authPoll = null;
}

function pollAuthUntilSettled(providerId: string): void {
  stopAuthPoll();
  authPoll = setInterval(async () => {
    const latest = await loadProviders();
    if (!latest.find((p) => p.id === providerId)?.auth.pending) {
      stopAuthPoll();
      await renderProviders();
    }
  }, 2000);
}

/* ---------- Agents (settings section + detail page) ---------- */

// Monotonic request tokens: rapid tab switches must not land stale content.
const agentsGrid = latestToken();
const providersGrid = latestToken();
const envsGrid = latestToken();

async function renderAgents(): Promise<void> {
  if (!bridge) return;
  const token = agentsGrid.next();
  loadingInto(agentCards);
  const infos = await bridge.agentList().catch(() => []);
  if (!agentsGrid.isCurrent(token)) return;
  agentCards.removeAttribute('aria-busy');
  agentInfos = infos; // the sidebar roster follows Settings
  // Renames land everywhere: live conversations retitle, and if the renamed
  // chat is on screen its header/hero refresh without a remount.
  for (const renamed of store.syncAgentNames(infos)) {
    if (renamed === store.getMounted()) syncSessionChrome(renamed);
  }
  renderRecents();
  agentCards.textContent = '';
  for (const agent of infos) {
    const card = cardShell({
      title: agent.name,
      active: agent.active,
      headRight: providerLabel(agent.provider),
      clickable: {
        label: `Configure agent ${agent.name}`,
        onOpen: () => nav({ view: 'agent-detail', agent }),
      },
    });
    card.appendChild(
      el(
        'div',
        'card-sub',
        `${agent.model} · thinking ${agent.effort}` +
          (agent.systemPrompt.trim() ? ' · custom instructions' : ''),
      ),
    );

    const foot = el('div', 'card-foot');
    const use = button('btn-ghost', 'Open chat');
    use.addEventListener('click', (e) => {
      e.stopPropagation();
      void selectAndOpenChat(agent.id);
    });
    foot.appendChild(use);
    const remove = button('btn-ghost danger', 'Delete');
    armDelete(remove, async () => {
      agentMsg.textContent = '';
      try {
        agentInfos = await bridge.agentDelete(agent.id);
        // The conversation dies with its agent — the store interrupts its
        // turn and drops it plus its sub-agent chats; moving the UI off the
        // dead chat is this side's job.
        const conv = store.removeAgent(agent.id);
        if (conv && (current === conv || current.parentSessionId === conv.id)) {
          const next = agentInfos[0];
          if (next) {
            current = conversationFor(next);
            hydrate(current);
          } else {
            current = freshSession();
          }
          mountSession(current);
        }
        renderRecents();
        await refreshStatus();
      } catch (err) {
        agentMsg.textContent = errText(err);
      }
      await renderAgents();
    });
    foot.appendChild(remove);
    card.appendChild(foot);
    agentCards.appendChild(card);
  }

  agentCards.appendChild(
    addCard('+ New agent', async () => {
      agentMsg.textContent = '';
      try {
        const list = await bridge.agentCreate({
          name: 'New agent',
          provider: (await loadProviders())[0]?.id ?? '',
          model: 'auto',
          systemPrompt: '',
          effort: 'auto',
          options: {},
          advanced: '',
        });
        const newest = list[list.length - 1];
        if (newest) nav({ view: 'agent-detail', agent: newest });
      } catch (err) {
        agentMsg.textContent = errText(err);
      }
    }),
  );
}


// The agent editor owns its form, dirty tracking, section rail, and save
// flow (src/renderer/settings/agent-editor.ts); this file hands it the DOM.
const agentEditor = initAgentEditor({
  bridge,
  loadProviders,
  showView: () => showView('agent-detail'),
  navToAgents: () => nav({ view: 'settings', section: 'agents' }),
  refreshStatus,
  openAgentChat: (agentId) => void selectAndOpenChat(agentId),
  els: {
    view: agentDetailView,
    title: agentTitle,
    status: byId('agent-status'),
    controls: byId('agent-controls'),
    msg: byId('agent-detail-msg'),
    back: byId<HTMLButtonElement>('agent-back'),
    name: byId<HTMLInputElement>('a-name'),
    provider: byId<HTMLSelectElement>('a-provider'),
    modelSeg: byId('a-model-seg'),
    model: byId<HTMLInputElement>('a-model'),
    thinkingSeg: byId('a-thinking-seg'),
    system: byId<HTMLTextAreaElement>('a-system'),
    systemHint: byId('a-system-hint'),
    options: byId('a-options'),
    advanced: byId<HTMLTextAreaElement>('a-advanced'),
    advancedWarn: byId('a-advanced-warn'),
    save: byId<HTMLButtonElement>('a-save'),
    nav: byId('agent-nav'),
    editorMain: byId('agent-editor-main'),
    dirty: byId('agent-dirty'),
    identityCard: byId('aed-identity'),
    identityModBadge: byId('a-identity-mod'),
    instructionsCard: byId('aed-instructions'),
    advancedCard: byId('aed-advanced'),
  },
});

async function renderProviders(): Promise<void> {
  if (!bridge) return;
  const token = providersGrid.next();
  loadingInto(providerCards);
  const infos = await loadProviders();
  if (!providersGrid.isCurrent(token)) return;
  providerCards.removeAttribute('aria-busy');
  providerCards.textContent = '';
  for (const info of infos) {
    const card = cardShell({
      title: info.label,
      headRight: statusEl(info.auth.connected, info.auth.connected ? 'connected' : 'offline'),
    });
    const waiting = info.auth.pending && !info.auth.connected;
    card.appendChild(
      el(
        'div',
        'card-sub',
        waiting ? 'waiting for the sign-in in your browser… come back here when done' : info.auth.detail,
      ),
    );
    if (waiting && !authPoll) pollAuthUntilSettled(info.id); // e.g. settings reopened mid-login

    const foot = el('div', 'card-foot');
    const btn = button('btn-ghost', info.auth.connected ? 'Disconnect' : waiting ? 'Cancel' : 'Connect');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      providerMsg.textContent = '';
      try {
        if (info.auth.connected) {
          stopAuthPoll();
          await bridge.providerAuthLogout(info.id);
        } else if (waiting) {
          stopAuthPoll();
          await bridge.providerAuthCancel(info.id);
        } else {
          await bridge.providerAuthStart(info.id);
          pollAuthUntilSettled(info.id);
        }
      } catch (err) {
        providerMsg.textContent = errText(err);
      }
      await renderProviders();
    });
    foot.appendChild(btn);
    card.appendChild(foot);
    providerCards.appendChild(card);
  }
}

/* ---------- Environment list + detail editor ---------- */

// The env editor owns the detail form, kv lists, header, and save flow
// (src/renderer/settings/env-editor.ts); this file hands it the DOM.
const envEditor = initEnvEditor({
  bridge,
  applyStatus,
  refreshStatus,
  showView: () => showView('env-detail'),
  navToEnvs: () => nav({ view: 'settings', section: 'envs' }),
  els: {
    title: detailTitle,
    status: byId('detail-status'),
    progress: byId('detail-progress'),
    controls: byId('detail-controls'),
    msg: byId('detail-msg'),
    back: byId<HTMLButtonElement>('detail-back'),
    name: byId<HTMLInputElement>('d-name'),
    image: byId<HTMLInputElement>('d-image'),
    workspace: byId<HTMLInputElement>('d-workspace'),
    autoInstall: byId<HTMLInputElement>('d-autoinstall'),
    dockerfile: byId<HTMLTextAreaElement>('d-dockerfile'),
    envVars: byId('d-envvars'),
    envKey: byId<HTMLInputElement>('d-env-key'),
    envVal: byId<HTMLInputElement>('d-env-val'),
    envAdd: byId<HTMLButtonElement>('d-env-add'),
    secrets: byId('d-secrets'),
    secretKey: byId<HTMLInputElement>('d-secret-key'),
    secretVal: byId<HTMLInputElement>('d-secret-val'),
    secretAdd: byId<HTMLButtonElement>('d-secret-add'),
    save: byId<HTMLButtonElement>('d-save'),
  },
});

/* ---------- Support section ---------- */

const supportView = initSupportView({
  bridge,
  els: {
    version: byId('support-version'),
    dataDir: byId('support-datadir'),
    logFile: byId('support-logfile'),
    exportBtn: byId<HTMLButtonElement>('support-export'),
    msg: byId('support-msg'),
  },
});

async function renderEnvs(): Promise<void> {
  if (!bridge) return;
  const token = envsGrid.next();
  loadingInto(envCards); // envList shells out to docker — visibly slow
  const envs = await bridge.envList().catch(() => [] as EnvironmentInfo[]);
  if (!envsGrid.isCurrent(token)) return;
  renderEnvsFrom(envs);
}

/** The list as last rendered; lifecycle pushes patch it in place. */
let lastEnvs: EnvironmentInfo[] = [];

/** Renders a known list — env ops feed their returned list here instead of
 *  paying a second round of per-container docker probes. */
function renderEnvsFrom(envs: EnvironmentInfo[]): void {
  if (!bridge) return;
  lastEnvs = envs;
  tracker.seed(envs);
  envCards.removeAttribute('aria-busy');
  envCards.textContent = '';
  for (const env of envs) {
    const card = cardShell({
      title: env.name,
      active: env.active,
      headRight: statusChip(env.status),
      clickable: {
        label: `Configure environment ${env.name}`,
        onOpen: () => nav({ view: 'env-detail', env }),
      },
    });
    card.dataset.envId = env.id;
    card.appendChild(
      el(
        'div',
        'card-sub',
        `${env.dockerfile.trim() ? 'Dockerfile' : env.image} · ${env.workspacePath}`,
      ),
    );
    const progress = el('div', 'env-progress card-progress');
    renderProgress(progress, env, Date.now());
    card.appendChild(progress);

    const foot = el('div', 'card-foot');
    envOpRail(foot, env, {
      bridge,
      applyStatus,
      stopPropagation: true, // rail clicks must not open the detail page
      message: (text) => {
        envMsg.textContent = text;
      },
      onSettled: async (latest) => {
        if (latest) renderEnvsFrom(latest);
        else await renderEnvs();
        await refreshStatus();
      },
      onDelete: (target) => {
        envEditor.forget(target.id);
        return bridge.envDelete(target.id);
      },
    });
    card.appendChild(foot);
    envCards.appendChild(card);
  }

  // Dashed add-card creates an environment and opens its page for configuring.
  envCards.appendChild(
    addCard('+ New environment', async () => {
      envMsg.textContent = '';
      try {
        const list = await bridge.envCreate({
          name: `env-${Date.now().toString(36).slice(-4)}`,
          image: 'node:22-bookworm',
          workspacePath: '',
          autoInstall: true,
          dockerfile: '',
          envVars: {},
        });
        const newest = list[list.length - 1];
        if (newest) nav({ view: 'env-detail', env: newest });
      } catch (err) {
        envMsg.textContent = errText(err);
      }
    }),
  );
}

/** Refresh one card's progress line without rebuilding the grid. */
function patchEnvCard(env: EnvironmentInfo, now: number): void {
  const host = envCards.querySelector<HTMLElement>(`[data-env-id="${env.id}"] .card-progress`);
  if (host) renderProgress(host, env, now);
}

// Lifecycle pushes: the same event updates the chat chrome (if it is the
// active environment), the Settings card, and the detail header. A status
// change re-renders the card grid (the op rail depends on it); a mere output
// line patches the progress text in place. The tracker's ticker advances
// elapsed times between pushes.
const tracker = createLifecycleTracker({
  onTick: (now) => {
    applyEnvChrome(now);
    for (const env of lastEnvs) patchEnvCard(env, now);
    envEditor.tick(now);
  },
});

bridge?.onEnvEvent((ev) => {
  const statusChanged = tracker.apply(ev);
  const lifecycle = pickLifecycle(ev);
  if (activeEnv?.id === ev.envId) {
    activeEnv = { ...activeEnv, ...lifecycle };
    applyEnvChrome(Date.now());
  }
  const idx = lastEnvs.findIndex((e) => e.id === ev.envId);
  if (idx === -1) return;
  const merged = { ...lastEnvs[idx], ...lifecycle };
  lastEnvs[idx] = merged;
  if (statusChanged) renderEnvsFrom(lastEnvs);
  else patchEnvCard(merged, Date.now());
  envEditor.update(merged);
});

/* ---------- Sessions ---------- */

let agentInfos: AgentInfo[] = [];

// The session model lives in the store (src/renderer/session-store.ts);
// the rendering layer lives in chat-view. This file wires them to the DOM,
// the bridge, and each other.
const store = createSessionStore({
  interrupt: (turnId) => {
    if (harness) harness.interrupt(turnId);
  },
  save: (agentId, data) => (bridge ? bridge.convoSave(agentId, data) : Promise.resolve()),
  onSaveError: (session, err) => showToast(`Couldn't save "${session.title}": ${err.message}`),
  currentDraft: () => prompt.value,
});
const { conversations } = store;
const freshSession = store.freshSession;
const conversationFor = store.conversationFor;
const persistConversation = store.persist;
const schedulePersist = store.schedulePersist;

/** A session's provider capabilities; sub-agent chats resolve through their root conversation. */
function capabilitiesOf(session: Session): ProviderCapabilities | undefined {
  let root: Session | undefined = session;
  while (root?.parentSessionId !== undefined) root = store.findSession(root.parentSessionId);
  const agentId = root?.agentId;
  const info = agentId ? agentInfos.find((a) => a.id === agentId) : undefined;
  return info ? providersById.get(info.provider)?.capabilities : undefined;
}

const chatView = initChatView({
  userName: USER_NAME,
  scrollChat,
  answerAsk: (turnId, askId, answers) =>
    harness ? harness.answerAsk(turnId, askId, answers) : Promise.resolve(),
  toast: showToast,
  schedulePersist,
  rosterChanged: () => renderRecents(), // lazily — the roster is wired below
  isCurrent: (session) => session === current,
  openSession,
  spawnChild: store.spawnChild,
  capabilities: capabilitiesOf,
  pruneChildren: store.dropChildren,
  overlay: {
    body: byId('turn-full-body'),
    crumb: byId('turn-full-crumb'),
    title: byId('turn-full-title'),
    stage,
    backButton: turnFullBack,
  },
});
const { addUserMessage, addAssistantTurn, hydrate, closeFullTurn } = chatView;

/** Bring a session on screen in the chat view. */
function showSession(session: Session): void {
  nav({ view: 'chat' });
  if (session === current) return;
  current = session;
  session.unread = null;
  hydrate(session); // no-op for sub-agent chats (nothing pending)
  mountSession(session);
  renderRecents();
  prompt.focus();
}

function openConversation(agentId: string): void {
  const info = agentInfos.find((a) => a.id === agentId);
  if (info) showSession(conversationFor(info));
}

/** Make an agent the active one (main tracks it) and open its chat. */
async function selectAndOpenChat(agentId: string): Promise<void> {
  if (!bridge) return;
  applyStatus(await bridge.agentSelect(agentId));
  openConversation(agentId);
}


let current: Session = freshSession();


/** Swap the chat scroller over to a session's live thread. */
function mountSession(session: Session): void {
  const prev = store.getMounted();
  if (prev && prev !== session) {
    // Draft and scroll state are per conversation — never leak across agents.
    prev.draft = prompt.value;
    prev.scrollPos = chat.scrollTop;
    prev.stick = stickToBottom;
  }
  store.setMounted(session);
  chat.querySelector('.thread')?.remove();
  chat.appendChild(session.thread);
  closeFullTurn(); // full-screen detail belongs to the previous view
  prompt.value = session.draft ?? '';
  autosize();
  stickToBottom = session.stick ?? true;
  chat.scrollTop = stickToBottom ? chat.scrollHeight : session.scrollPos ?? 0;
  stage.classList.toggle('empty', !session.thread.children.length);
  syncSessionChrome(session);
}

/** Chat header, hero, and composer text derived from the session's title. */
function syncSessionChrome(session: Session): void {
  const isChild = session.parentSessionId !== undefined;
  const info = session.agentId ? agentInfos.find((a) => a.id === session.agentId) : undefined;
  chatHeadName.textContent = session.title;
  chatHeadTag.textContent = isChild
    ? 'sub-agent'
    : info
      ? providerLabel(info.provider)
      : '';
  chatHead.classList.toggle('hidden', !isChild && !info);
  const named = info || isChild;
  heroAvatar.textContent = named ? (session.title[0] ?? 'P').toUpperCase() : 'P';
  heroTitle.textContent = named ? session.title : 'Welcome to Puck';
  syncComposer();
}

// The roster owns the sidebar list's rendering (src/renderer/roster.ts);
// render() is rAF-coalesced, so callers fire it on every event.
const roster = initRoster({
  listEl: recentsList,
  agents: () => agentInfos,
  conversationOf: (agentId) => conversations.get(agentId),
  childrenOf: store.childrenOf,
  isCurrent: (session) => session === current,
  providerLabel,
  openConversation,
  openSession,
  interrupt: (turnId) => {
    if (harness) harness.interrupt(turnId);
  },
});
const renderRecents = roster.render;

/** Open a sub-agent chat by its session id. */
function openSession(id: number): void {
  nav({ view: 'chat' });
  const target = store.findSession(id);
  if (target) showSession(target);
}

/* ---------- Turn loop ---------- */

/** Reflect the CURRENT session's turn state and the environment gate on the composer. */
function syncComposer(): void {
  const isChild = current.parentSessionId !== undefined;
  const gate = composerGate(activeEnv, current.agentId ? current.title : null);
  prompt.disabled = isChild;
  prompt.placeholder = isChild
    ? 'Sub-agent conversation — watch it work, or reply via the main chat'
    : gate.placeholder;
  const running = current.running;
  // Not ready (starting, stopping, failed, stopped, or no environment): the
  // draft stays editable, sending is blocked and the button says why.
  const gated = !isChild && !running && !gate.ready;
  send.disabled = isChild || gated;
  composer.classList.toggle('gated', gated);
  send.classList.toggle('stop', running && !isChild);
  send.classList.remove('stopping');
  send.innerHTML = running && !isChild ? STOP_ICON : SEND_ICON;
  send.title = running && !isChild ? 'Stop this turn' : gated ? gate.reason : 'Send · Enter';
}

async function submit(text: string): Promise<void> {
  const session = current; // the turn belongs to this conversation, even if the user switches away
  const trimmed = text.trim();
  if (!trimmed || session.running || !harness) return;
  if (session.parentSessionId !== undefined) return; // sub-agent chats are observed, not driven
  if (!session.agentId) return; // no agent configured yet
  hydrate(session); // history must be on screen before the new exchange

  const { turnId, events } = harness.send(session.agentId, trimmed);
  session.running = true;
  session.turnId = turnId;
  session.unread = null;
  session.turns += 1;
  session.lastActiveAt = Date.now();
  stage.classList.remove('empty');
  addUserMessage(session, trimmed);
  syncComposer();
  renderRecents();

  // Record structured history so a restart can replay this turn into live UI.
  session.log.push({ kind: 'user', text: trimmed, author: 'user', ts: Date.now() });
  const record: ConversationEntry = { kind: 'turn', ts: Date.now(), events: [] };
  session.log.push(record);
  void persistConversation(session); // the user's message is durable immediately

  const turn = addAssistantTurn(session, turnId);
  turn.setThinking(true, 'Contacting the harness…'); // no dead air before the first event
  try {
    for await (const event of events) {
      if (event.kind !== 'thinking') {
        event.ts = Date.now(); // wall-clock stamp survives into replays
        // Merge consecutive text deltas — token-level entries would bloat the
        // log and make replay quadratic again.
        const prev = record.events[record.events.length - 1];
        if (
          event.kind === 'text-delta' &&
          prev?.kind === 'text-delta' &&
          prev.parentId === event.parentId
        ) {
          prev.text += event.text;
        } else {
          record.events.push(event);
        }
        schedulePersist(session);
      }
      applyEvent(turn, event, false);
      switch (event.kind) {
        case 'error':
        case 'ask':
          if (session !== current) {
            session.unread = event.kind;
            renderRecents();
          }
          break;
        case 'turn-end':
          if (event.stats.inputTokens + event.stats.outputTokens > 0) {
            session.usage = event.stats.inputTokens + event.stats.outputTokens;
          }
          break;
      }
    }
  } finally {
    session.running = false;
    session.turnId = null;
    session.lastActiveAt = Date.now();
    // The turn is over, so no sub-agent of it can still be streaming.
    for (const { child } of session.agents.values()) {
      if (child.running) {
        child.running = false;
        if (child !== current && !child.unread) child.unread = 'done';
      }
    }
    if (session === current) {
      prompt.focus();
    } else if (!session.unread) {
      session.unread = 'done';
    }
    syncComposer();
    renderRecents();
    // Conversations are forever — persist the completed turn.
    void persistConversation(session);
  }
}

send.addEventListener('click', (e) => {
  if (current.running) {
    e.preventDefault();
    if (harness && current.turnId) harness.interrupt(current.turnId);
    send.classList.add('stopping');
    send.title = 'Stopping…';
  }
});

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (current.running) return; // keep the draft while this session's turn is in flight
  const text = prompt.value;
  if (!text.trim() || !harness) return; // validate before destroying the draft
  const gate = composerGate(activeEnv, current.agentId ? current.title : null);
  if (!gate.ready) {
    if (gate.reason) showToast(gate.reason); // e.g. Enter while the environment is still starting
    return;
  }
  prompt.value = '';
  autosize();
  void submit(text);
});

prompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

function autosize(): void {
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`;
}
prompt.addEventListener('input', () => {
  autosize();
  // An idle draft belongs to its conversation: save it after the typing
  // pause so it survives quit and restart (the quit flush covers the rest).
  if (current.agentId) schedulePersist(current);
});

// Quit (main asks) and window close (best effort) drain the renderer:
// pending debounced saves plus the mounted conversation's composer draft.
bridge?.onFlush(() => store.flushPending());
window.addEventListener('pagehide', () => void store.flushPending());

addAgentBtn.addEventListener('click', () => {
  nav({ view: 'settings', section: 'agents' });
});

turnFullBack.addEventListener('click', closeFullTurn);

/* ---------- Command palette: Cmd+K switches agents + searches history ---------- */

// The palette owns its overlay, search index, and keyboard flow
// (src/renderer/palette.ts); this file supplies the data and navigation.
const palette = initPalette({
  agents: () => agentInfos,
  logOf: (agentId) => {
    const conv = conversations.get(agentId);
    return conv?.pendingLog ?? conv?.log;
  },
  providerLabel,
  openConversation,
});

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    palette.toggle();
  } else if (mod && e.key === ',') {
    e.preventDefault();
    nav({ view: 'settings' }); // last-used section, same as the gear
  } else if (mod && /^[1-9]$/.test(e.key)) {
    const info = agentInfos[Number(e.key) - 1];
    if (info) {
      e.preventDefault();
      openConversation(info.id);
    }
  }
});

/** Load the agent roster and restore each agent's permanent conversation. */
async function boot(): Promise<void> {
  if (!bridge) {
    mountSession(current);
    return;
  }
  // Labels must be cached before conversations render; the four fetches are
  // otherwise independent.
  const [, infos, saved, status] = await Promise.all([
    loadProviders(),
    bridge.agentList().catch(() => []),
    bridge.convoLoad().catch(() => ({}) as Record<string, never>),
    bridge.status().catch(() => null),
  ]);
  agentInfos = infos;
  for (const info of agentInfos) {
    const conv = conversationFor(info);
    const data = saved[info.id];
    // Histories are only REPLAYED when their conversation first opens — boot
    // stays fast.
    if (data && conv.turns === 0) {
      conv.pendingLog = data.log;
      conv.usage = data.lastTurnTokens;
      conv.lastActiveAt = data.lastActiveAt;
      conv.turns = data.turns;
      conv.draft = data.draft;
    }
  }
  renderRecents();
  if (status) applyStatus(status);
  const first = agentInfos.find((a) => a.id === status?.agent?.id) ?? agentInfos[0];
  if (first) openConversation(first.id);
  else mountSession(current);
}
void boot();
