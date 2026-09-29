/**
 * First run: a full-window sequence that gets a new user to their first
 * environment. Each step is also reachable later from Settings.
 *
 * 1. Sign in with GitHub, through the Puck server.
 * 2. Install the Puck app on an account.
 * 3. Connect your Puck home: connect an existing home or initialize a new
 *    one (the shared panel in home-setup.ts). The step shows its
 *    repositories afresh each time it opens.
 * 4. Connect Claude Code: the orchestrator needs it. Codex is optional.
 * 5. Set up a runner: This Mac in one click, or Add runner in Settings.
 * 6. Start an environment (the start flow).
 *
 * The first step not done is the current one; done steps show a check and
 * stay clickable. Sign-ins finish in the browser, so while one is pending
 * the sequence polls. Context in, controller out; no DOM lookups.
 */

import type { GithubInstallation, HarnessProviderInfo, IntegrationProviderInfo, ProviderInfo, PuckBridge, RunnersState } from '../harness/bridge';
import { el } from './dom';
import { initHomeSetup } from './home-setup';
import { button, errText } from './util';

export type FirstRunStep = 'sign-in' | 'install' | 'config-repo' | 'claude' | 'runner' | 'start';

export interface FirstRunFacts {
  github: IntegrationProviderInfo | null;
  claude: HarnessProviderInfo | null;
  codex: HarnessProviderInfo | null;
  installations: GithubInstallation[] | null;
  runners: RunnersState | null;
}

export function stepDone(step: FirstRunStep, f: FirstRunFacts): boolean {
  switch (step) {
    case 'sign-in':
      return !!f.github?.auth.connected;
    case 'install':
      return (f.installations?.length ?? 0) > 0;
    case 'config-repo':
      return !!f.github?.github.configRepo;
    case 'claude':
      return !!f.claude?.auth.connected;
    case 'runner':
      return (f.runners?.runners.length ?? 0) > 0;
    case 'start':
      return false;
  }
}

export const STEPS: { id: FirstRunStep; title: string }[] = [
  { id: 'sign-in', title: 'Sign in with GitHub' },
  { id: 'install', title: 'Install Puck on an account' },
  { id: 'config-repo', title: 'Connect your Puck home' },
  { id: 'claude', title: 'Connect Claude Code' },
  { id: 'runner', title: 'Set up a runner' },
  { id: 'start', title: 'Start an environment' },
];

/** The first step that is not done. */
export function currentStep(f: FirstRunFacts): FirstRunStep {
  return STEPS.find((s) => !stepDone(s.id, f))?.id ?? 'start';
}

export interface FirstRunContext {
  root: HTMLElement;
  bridge: PuckBridge;
  runners(): RunnersState | null;
  openSettings(section: 'providers' | 'runners'): void;
  startFlow(): void;
  pollMs?: number;
}

export function initFirstRun(ctx: FirstRunContext) {
  const { bridge, root } = ctx;
  let facts: FirstRunFacts = { github: null, claude: null, codex: null, installations: null, runners: null };
  let error = '';
  let poll: ReturnType<typeof setInterval> | null = null;
  let shown: FirstRunStep | null = null;
  let active = false;
  let loading: Promise<void> = Promise.resolve();
  /** Whether the Puck home step was open at the last draw: opening it again fetches the repositories again. */
  let homeOpen = false;
  const home = initHomeSetup({
    bridge,
    current: () => facts.github?.github.configRepo ?? null,
    connected: () => void refresh(),
  });

  async function load(): Promise<void> {
    const infos: ProviderInfo[] = await bridge.providers().catch((err: unknown) => {
      error = errText(err);
      return [];
    });
    const github = (infos.find((p) => p.kind === 'integration' && p.id === 'github') as IntegrationProviderInfo | undefined) ?? null;
    const harness = (id: string) => (infos.find((p) => p.kind === 'harness' && p.id === id) as HarnessProviderInfo | undefined) ?? null;
    let installations: GithubInstallation[] | null = null;
    if (github?.auth.connected) installations = await bridge.githubInstallations().catch(() => null);
    facts = { github, claude: harness('claude-code'), codex: harness('codex'), installations, runners: ctx.runners() };
    const pending = !!(github?.auth.pending || facts.claude?.auth.pending || facts.codex?.auth.pending || facts.runners?.local.busy);
    if (pending && !poll) poll = setInterval(() => void refresh(), ctx.pollMs ?? 2000);
    if (!pending && poll) {
      clearInterval(poll);
      poll = null;
    }
  }

  async function refresh(): Promise<void> {
    if (!active) return;
    await load();
    draw();
  }

  async function signIn(id: string): Promise<void> {
    error = '';
    try {
      await bridge.providerAuthStart(id);
    } catch (err) {
      error = errText(err);
    }
    await refresh();
  }

  function body(step: FirstRunStep): HTMLElement {
    const box = el('div', 'fr-body');
    const note = (text: string): void => {
      box.appendChild(el('p', 'fr-note', text));
    };
    switch (step) {
      case 'sign-in': {
        if (facts.github?.auth.pending) {
          note('Finish signing in in your browser, then come back here.');
          const cancel = button('btn-ghost', 'Cancel');
          cancel.addEventListener('click', async () => {
            await bridge.providerAuthCancel('github').catch(() => undefined);
            await refresh();
          });
          box.appendChild(cancel);
          break;
        }
        note(`Puck signs you in through its server${facts.github ? ` at ${facts.github.github.server}` : ''}. Your runners and environments belong to that account, and Puck asks GitHub for everything it needs now.`);
        const go = button('btn-primary', facts.github?.auth.connected ? `Signed in as ${facts.github.github.login ?? ''}` : 'Sign in with GitHub');
        go.disabled = !!facts.github?.auth.connected;
        go.addEventListener('click', () => void signIn('github'));
        box.appendChild(go);
        break;
      }
      case 'install': {
        const installs = facts.installations ?? [];
        if (installs.length) note(`Installed on ${installs.map((i) => i.account).join(', ')}.`);
        else note('Install the Puck app on the account that owns your Puck home and the repositories your agents work on.');
        const url = facts.github?.github.installUrl;
        if (url) {
          const go = button(installs.length ? 'btn-ghost' : 'btn-primary', installs.length ? 'Install on another account' : 'Install Puck on GitHub');
          go.addEventListener('click', () => void bridge.openExternal(url));
          box.appendChild(go);
        }
        const again = button('btn-ghost', 'I installed it');
        again.addEventListener('click', () => void refresh());
        box.appendChild(again);
        break;
      }
      case 'config-repo': {
        if (!facts.github?.auth.connected) {
          note('Sign in with GitHub first: Puck reads your Puck home through your GitHub sign-in.');
          break;
        }
        if (!facts.github.github.configRepo) {
          note('Your Puck home is one GitHub repository that holds all your agent and environment definitions. Connect the one you have, or initialize a new one. You change definitions by committing to it.');
        }
        if (!homeOpen) void home.show();
        else home.render();
        homeOpen = true;
        box.appendChild(home.root);
        break;
      }
      case 'claude': {
        note('The orchestrator runs on Claude Code. Codex is optional, for workers.');
        // One grid for both rows: same button, and the connected or waiting
        // state takes the button's cell. Optional is a label, not a lesser button.
        const grid = el('div', 'fr-harnesses');
        for (const h of [facts.claude, facts.codex]) {
          if (!h) continue;
          const row = el('div', 'fr-harness');
          row.dataset.harness = h.id;
          const name = el('span', 'fr-harness-name', h.label);
          name.appendChild(el('span', 'fr-harness-tag', h.id === 'claude-code' ? 'Required' : 'Optional'));
          row.appendChild(name);
          if (h.auth.connected || h.auth.pending) {
            const state = el('span', `fr-harness-state ${h.auth.connected ? 'on' : 'busy'}`);
            state.append(el('span', 'dot'), h.auth.connected ? 'Connected' : 'Waiting for the browser…');
            row.appendChild(state);
          } else {
            const go = button('btn-primary', `Connect ${h.label}`);
            go.addEventListener('click', () => void signIn(h.id));
            row.appendChild(go);
          }
          grid.appendChild(row);
        }
        box.appendChild(grid);
        break;
      }
      case 'runner': {
        const state = facts.runners;
        const rows = state?.runners ?? [];
        if (rows.length) note(`Runners: ${rows.map((r) => r.name).join(', ')}.`);
        else note('A runner is a machine that hosts your environments with Docker. This Mac can be one, or add another machine.');
        const local = state?.local;
        if (local?.supported && !local.installed) {
          const go = button('btn-primary', local.busy ? local.detail || 'Setting up…' : 'Set up This Mac');
          go.disabled = !!local.busy;
          go.addEventListener('click', async () => {
            go.disabled = true;
            error = '';
            try {
              await bridge.runnerInstallLocal();
            } catch (err) {
              error = errText(err);
            }
            await refresh();
          });
          box.appendChild(go);
          if (local.error) box.appendChild(el('p', 'fr-error', local.error));
        }
        const other = button('btn-ghost', 'Add runner…');
        other.addEventListener('click', () => ctx.openSettings('runners'));
        box.appendChild(other);
        break;
      }
      case 'start': {
        note('Pick a definition and a runner, and Puck starts the environment and its orchestrator.');
        const go = button('btn-primary', 'Start an environment');
        go.addEventListener('click', () => ctx.startFlow());
        box.appendChild(go);
        break;
      }
    }
    return box;
  }

  function draw(): void {
    if (!active) return;
    const current = currentStep(facts);
    const open = shown && STEPS.some((s) => s.id === shown) ? shown : current;
    if (open !== 'config-repo') homeOpen = false;
    root.textContent = '';
    const wrap = el('div', 'fr-wrap');
    wrap.appendChild(el('h1', 'fr-title', 'Welcome to Puck'));
    wrap.appendChild(el('p', 'fr-sub', 'Six steps to your first environment: an orchestrator and its agents working your backlog.'));
    if (error) wrap.appendChild(el('p', 'fr-error', error));
    const list = el('ol', 'fr-steps');
    STEPS.forEach((s, i) => {
      const done = stepDone(s.id, facts);
      const li = el('li', `fr-step${done ? ' done' : ''}${s.id === current ? ' current' : ''}${s.id === open ? ' open' : ''}`);
      li.dataset.step = s.id;
      const head = button('fr-step-head');
      head.append(el('span', 'fr-step-mark', done ? '✓' : String(i + 1)), el('span', 'fr-step-title', s.title));
      head.setAttribute('aria-expanded', String(s.id === open));
      head.addEventListener('click', () => {
        shown = s.id;
        draw();
      });
      li.appendChild(head);
      if (s.id === open) li.appendChild(body(s.id));
      list.appendChild(li);
    });
    wrap.appendChild(list);
    root.appendChild(wrap);
  }

  return {
    show(): Promise<void> {
      active = true;
      shown = null;
      loading = load().then(draw);
      return loading;
    },
    /** The facts of the last show() are in. */
    loaded: (): Promise<void> => loading,
    hide(): void {
      active = false;
      homeOpen = false;
      if (poll) clearInterval(poll);
      poll = null;
    },
    refresh,
    runnersChanged(state: RunnersState): void {
      facts = { ...facts, runners: state };
      draw();
    },
    /** Whether the setup steps (all but starting an environment) are done. */
    ready: (): boolean => STEPS.every((s) => s.id === 'start' || stepDone(s.id, facts)),
    facts: (): FirstRunFacts => facts,
  };
}

export type FirstRun = ReturnType<typeof initFirstRun>;
