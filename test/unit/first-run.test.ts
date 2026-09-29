// @vitest-environment jsdom

/**
 * First run walks a new user through sign-in, the app installation, the
 * Puck home, Claude Code, a runner and the first environment, one step
 * at a time.
 */

import { describe, expect, it, vi } from 'vitest';
import type { HarnessProviderInfo, IntegrationProviderInfo, ProviderInfo, RunnersState } from '../../src/harness/bridge';
import { currentStep, initFirstRun, stepDone, type FirstRunFacts } from '../../src/renderer/first-run';
import { homeUrl } from '../../src/renderer/home-setup';
import { runnerRow, runnersState } from './runners-fixtures';
import { fakeBridge } from './v2-fixtures';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function github(connected: boolean, configRepo: string | null = null): IntegrationProviderInfo {
  return {
    kind: 'integration',
    id: 'github',
    label: 'GitHub',
    status: { state: connected ? 'connected' : 'disconnected', detail: '' },
    auth: { connected, detail: '', pending: false },
    github: { login: connected ? 'octocat' : null, configRepo, installUrl: 'https://github.com/apps/puck/installations/new', server: 'http://localhost:8765' },
  };
}

function harness(id: string, connected: boolean, pending = false): HarnessProviderInfo {
  return {
    kind: 'harness',
    id,
    label: id === 'codex' ? 'Codex' : 'Claude Code',
    models: [],
    thinkingLevels: [],
    systemPromptHint: '',
    configOptions: [],
    capabilities: { supportsAsk: true, subAgents: true, subAgentTranscript: true, streamsTokens: true, reportsCost: true },
    status: { state: 'disconnected', detail: '' },
    auth: { connected, detail: '', pending },
  };
}

type Repo = { fullName: string; private: boolean; defaultBranch: string; htmlUrl: string };
const repo = (fullName: string): Repo => ({ fullName, private: true, defaultBranch: 'main', htmlUrl: '' });

function setup(state: { providers: ProviderInfo[]; installs?: number; runners?: RunnersState; environments?: number; repos?: Repo[] }) {
  document.body.innerHTML = '<div id="root"></div>';
  const fake = fakeBridge({
    providers: vi.fn(async () => state.providers),
    providerAuthStart: vi.fn(async () => ({ url: 'https://auth' })),
    githubInstallations: vi.fn(async () => Array.from({ length: state.installs ?? 0 }, (_, i) => ({ id: i, account: `acct${i}`, accountType: 'User', manageUrl: '', repositorySelection: 'all' }))),
    githubRepos: vi.fn(async () => state.repos ?? [repo('octo/config')]),
    githubConnectHome: vi.fn(async () => ({ connected: true, providers: [] })),
    definitionRefs: vi.fn(async () => ({ defaultBranch: 'main', tags: [{ name: 'v1.0.0', sha: 'a' }], branches: [], defaultTag: 'v1.0.0' })),
    definitionsAt: vi.fn(async () => ({ repo: 'octo/config', pin: { kind: 'tag', name: 'v1.0.0', sha: 'a' }, sha: 'a', environments: Array.from({ length: state.environments ?? 1 }, () => ({})), agents: [], errors: [] })),
    runnerInstallLocal: vi.fn(async () => runnersState()),
  } as never);
  const openSettings = vi.fn();
  const startFlow = vi.fn();
  const root = document.getElementById('root') as HTMLElement;
  const fr = initFirstRun({ root, bridge: fake.bridge, runners: () => state.runners ?? runnersState({ runners: [] }), openSettings, startFlow, pollMs: 5 });
  const open = () => root.querySelector('.fr-step.open') as HTMLElement;
  return { ...fake, fr, root, open, openSettings, startFlow };
}

describe('first run', () => {
  it('starts at sign-in and signs in with GitHub', async () => {
    const { fr, open, bridge, root } = setup({ providers: [github(false), harness('claude-code', false)] });
    await fr.show();
    expect(open().dataset.step).toBe('sign-in');
    expect(root.querySelectorAll('.fr-step')).toHaveLength(6);
    (open().querySelector('.btn-primary') as HTMLButtonElement).click();
    await flush();
    expect(bridge.providerAuthStart).toHaveBeenCalledWith('github');
    fr.hide();
  });

  it('moves to the installation, then connects the Puck home', async () => {
    const state = { providers: [github(true), harness('claude-code', false)] as ProviderInfo[], installs: 0, environments: 0 };
    const { fr, open, bridge, root } = setup(state);
    await fr.show();
    expect(open().dataset.step).toBe('install');
    (open().querySelector('.btn-primary') as HTMLButtonElement).click();
    expect(bridge.openExternal).toHaveBeenCalledWith('https://github.com/apps/puck/installations/new');
    state.installs = 1;
    await fr.refresh();
    expect(open().dataset.step).toBe('config-repo');
    expect(open().querySelector('.fr-step-title')?.textContent).toBe('Connect your Puck home');
    await flush();
    const select = open().querySelector('select[aria-label="Puck home"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'octo/config']);
    select.value = 'octo/config';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(bridge.githubConnectHome).toHaveBeenCalledWith('octo/config');
    state.providers = [github(true, 'octo/config'), harness('claude-code', false)];
    await fr.refresh();
    // Claude is the current step now; the home step shows the home with Open on GitHub and Change.
    expect(open().dataset.step).toBe('claude');
    (root.querySelector('[data-step="config-repo"] .fr-step-head') as HTMLButtonElement).click();
    expect(open().querySelector('.home-current')?.textContent).toContain('octo/config');
    (open().querySelector('.home-open') as HTMLButtonElement).click();
    expect(bridge.openExternal).toHaveBeenCalledWith(homeUrl('octo/config'));
    expect(open().querySelector('.home-change')).not.toBeNull();
  });

  it('lists each repository once, fetches the list again whenever the step opens, and refreshes on demand', async () => {
    const state = {
      providers: [github(true), harness('claude-code', false)] as ProviderInfo[],
      installs: 2,
      repos: [repo('octo/app'), repo('Octo/Home'), repo('octo/home')],
    };
    const { fr, open, bridge, root } = setup(state);
    await fr.show();
    await flush();
    expect(open().dataset.step).toBe('config-repo');
    const options = () => [...(open().querySelector('select[aria-label="Puck home"]') as HTMLSelectElement).options].map((o) => o.value);
    expect(options()).toEqual(['', 'octo/app', 'Octo/Home']);
    expect(bridge.githubRepos).toHaveBeenCalledTimes(1);
    // A redraw while the step stays open does not fetch again.
    await fr.refresh();
    expect(bridge.githubRepos).toHaveBeenCalledTimes(1);
    // A repository created since then appears when the step is opened again...
    state.repos = [...state.repos, repo('octo/puck-home')];
    (root.querySelector('[data-step="install"] .fr-step-head') as HTMLButtonElement).click();
    (root.querySelector('[data-step="config-repo"] .fr-step-head') as HTMLButtonElement).click();
    await flush();
    expect(bridge.githubRepos).toHaveBeenCalledTimes(2);
    expect(options()).toEqual(['', 'octo/app', 'Octo/Home', 'octo/puck-home']);
    // ...and on Refresh.
    state.repos = [...state.repos, repo('octo/later')];
    (open().querySelector('.home-refresh') as HTMLButtonElement).click();
    await flush();
    expect(bridge.githubRepos).toHaveBeenCalledTimes(3);
    expect(options()).toContain('octo/later');
    fr.hide();
  });

  it('asks for the GitHub sign-in before the Puck home', async () => {
    const { fr, root, bridge } = setup({ providers: [github(false), harness('claude-code', false)] });
    await fr.show();
    (root.querySelector('[data-step="config-repo"] .fr-step-head') as HTMLButtonElement).click();
    expect(root.querySelector('.fr-step.open .fr-note')?.textContent).toMatch(/Sign in with GitHub first/);
    expect(root.querySelector('.fr-step.open .home-panel')).toBeNull();
    expect(bridge.githubRepos).not.toHaveBeenCalled();
    fr.hide();
  });

  it('connects Claude Code, sets up This Mac, then starts an environment', async () => {
    const state = { providers: [github(true, 'octo/config'), harness('claude-code', false), harness('codex', false)] as ProviderInfo[], installs: 1, runners: runnersState({ runners: [] }) };
    const { fr, open, bridge, startFlow, openSettings } = setup(state);
    await fr.show();
    expect(open().dataset.step).toBe('claude');
    (open().querySelector('[data-harness="claude-code"] button') as HTMLButtonElement).click();
    await flush();
    expect(bridge.providerAuthStart).toHaveBeenCalledWith('claude-code');
    state.providers = [github(true, 'octo/config'), harness('claude-code', true), harness('codex', false)];
    await fr.refresh();
    expect(open().dataset.step).toBe('runner');
    (open().querySelector('.btn-primary') as HTMLButtonElement).click();
    await flush();
    expect(bridge.runnerInstallLocal).toHaveBeenCalled();
    [...open().querySelectorAll('button')].find((b) => b.textContent === 'Add runner…')?.click();
    expect(openSettings).toHaveBeenCalledWith('runners');
    fr.runnersChanged(runnersState({ runners: [runnerRow()] }));
    expect(open().dataset.step).toBe('start');
    expect(fr.ready()).toBe(true);
    (open().querySelector('.btn-primary') as HTMLButtonElement).click();
    expect(startFlow).toHaveBeenCalled();
  });

  it('gives both harness rows one shape, with Codex marked optional and states in the button cell', async () => {
    const state = { providers: [github(true, 'octo/config'), harness('claude-code', false), harness('codex', false)] as ProviderInfo[], installs: 1 };
    const { fr, open } = setup(state);
    await fr.show();
    const row = (id: string) => open().querySelector(`.fr-harnesses [data-harness="${id}"]`) as HTMLElement;
    expect(row('claude-code').querySelector('button')?.className).toBe('btn-primary');
    expect(row('codex').querySelector('button')?.className).toBe('btn-primary');
    expect(row('claude-code').querySelector('.fr-harness-tag')?.textContent).toBe('Required');
    expect(row('codex').querySelector('.fr-harness-tag')?.textContent).toBe('Optional');
    state.providers = [github(true, 'octo/config'), harness('claude-code', false, true), harness('codex', true)];
    await fr.refresh();
    expect(row('claude-code').querySelector('button')).toBeNull();
    expect(row('claude-code').querySelector('.fr-harness-state.busy')?.textContent).toBe('Waiting for the browser…');
    expect(row('codex').querySelector('.fr-harness-state.on')?.textContent).toBe('Connected');
    fr.hide();
  });

  it('knows which steps are done', () => {
    const facts: FirstRunFacts = { github: github(true, 'o/c'), claude: harness('claude-code', true), codex: null, installations: [], runners: runnersState() };
    expect(stepDone('install', facts)).toBe(false);
    expect(currentStep(facts)).toBe('install');
    expect(currentStep({ ...facts, installations: [{ id: 1, account: 'a', accountType: 'User', manageUrl: '', repositorySelection: 'all' }] })).toBe('start');
  });
});
