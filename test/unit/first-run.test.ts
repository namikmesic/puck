// @vitest-environment jsdom

/**
 * First run walks a new user through sign-in, the app installation, the
 * config repo, Claude Code, a runner and the first environment, one step
 * at a time.
 */

import { describe, expect, it, vi } from 'vitest';
import type { HarnessProviderInfo, IntegrationProviderInfo, ProviderInfo, RunnersState } from '../../src/harness/bridge';
import { currentStep, EXAMPLE_CONFIG_URL, initFirstRun, stepDone, type FirstRunFacts } from '../../src/renderer/first-run';
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

function harness(id: string, connected: boolean): HarnessProviderInfo {
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
    auth: { connected, detail: '', pending: false },
  };
}

function setup(state: { providers: ProviderInfo[]; installs?: number; runners?: RunnersState; environments?: number }) {
  document.body.innerHTML = '<div id="root"></div>';
  const fake = fakeBridge({
    providers: vi.fn(async () => state.providers),
    providerAuthStart: vi.fn(async () => ({ url: 'https://auth' })),
    githubInstallations: vi.fn(async () => Array.from({ length: state.installs ?? 0 }, (_, i) => ({ id: i, account: `acct${i}`, accountType: 'User', manageUrl: '', repositorySelection: 'all' }))),
    githubRepos: vi.fn(async () => [{ fullName: 'octo/config', private: true, defaultBranch: 'main', htmlUrl: '' }]),
    githubSetConfigRepo: vi.fn(async () => []),
    definitionRefs: vi.fn(async () => ({ tags: [{ name: 'v1.0.0', sha: 'a' }], branches: [], defaultTag: 'v1.0.0' })),
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

  it('moves to the installation, then the config repo, and points an empty repo at the example', async () => {
    const state = { providers: [github(true), harness('claude-code', false)] as ProviderInfo[], installs: 0, environments: 0 };
    const { fr, open, bridge } = setup(state);
    await fr.show();
    expect(open().dataset.step).toBe('install');
    (open().querySelector('.btn-primary') as HTMLButtonElement).click();
    expect(bridge.openExternal).toHaveBeenCalledWith('https://github.com/apps/puck/installations/new');
    state.installs = 1;
    await fr.refresh();
    expect(open().dataset.step).toBe('config-repo');
    await flush();
    await fr.refresh();
    const again = open().querySelector('select') as HTMLSelectElement;
    expect([...again.options].map((o) => o.value)).toEqual(['', 'octo/config']);
    again.value = 'octo/config';
    again.dispatchEvent(new Event('change'));
    await flush();
    expect(bridge.githubSetConfigRepo).toHaveBeenCalledWith('octo/config');
    state.providers = [github(true, 'octo/config'), harness('claude-code', false)];
    await fr.refresh();
    // Claude is the current step now; the config repo step shows the example when opened.
    expect(open().dataset.step).toBe('claude');
    const configHead = document.querySelector('[data-step="config-repo"] .fr-step-head') as HTMLButtonElement;
    configHead.click();
    const example = [...open().querySelectorAll('button')].find((b) => b.textContent === 'Open the example config repo');
    example?.click();
    expect(bridge.openExternal).toHaveBeenCalledWith(EXAMPLE_CONFIG_URL);
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

  it('knows which steps are done', () => {
    const facts: FirstRunFacts = { github: github(true, 'o/c'), claude: harness('claude-code', true), codex: null, installations: [], runners: runnersState() };
    expect(stepDone('install', facts)).toBe(false);
    expect(currentStep(facts)).toBe('install');
    expect(currentStep({ ...facts, installations: [{ id: 1, account: 'a', accountType: 'User', manageUrl: '', repositorySelection: 'all' }] })).toBe('start');
  });
});
