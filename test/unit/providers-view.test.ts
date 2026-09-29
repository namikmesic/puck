// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type {
  EnvironmentProviderInfo,
  HarnessProviderInfo,
  IntegrationProviderInfo,
  ProviderInfo,
  PuckBridge,
} from '../../src/harness/bridge';
import { initProvidersView, type ProvidersElements } from '../../src/renderer/settings/providers';
import { runnersInfo } from './runners-fixtures';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const harness = (over: Partial<HarnessProviderInfo> = {}): HarnessProviderInfo => ({
  kind: 'harness',
  id: 'claude-code',
  label: 'Claude Code',
  models: ['auto'],
  thinkingLevels: ['auto'],
  systemPromptHint: '',
  configOptions: [],
  capabilities: { supportsAsk: true, subAgents: true, subAgentTranscript: true, streamsTokens: true, reportsCost: true },
  status: { state: 'disconnected', detail: 'Not connected' },
  auth: { connected: false, pending: false, detail: 'Not connected' },
  ...over,
});

const runnersCard = (over = {}): EnvironmentProviderInfo => runnersInfo(over);

const gh = (over: Partial<IntegrationProviderInfo['github']> = {}, auth: Partial<IntegrationProviderInfo['auth']> = {}): IntegrationProviderInfo => ({
  kind: 'integration',
  id: 'github',
  label: 'GitHub',
  status: { state: 'disconnected', detail: 'Not connected — sign in with GitHub' },
  auth: { connected: false, pending: false, detail: 'Not connected — sign in with GitHub', ...auth },
  github: {
    login: null,
    configRepo: null,
    installUrl: 'https://github.com/apps/puck/installations/new',
    server: 'http://localhost:8765',
    ...over,
  },
});

function mount(infos: ProviderInfo[], bridgeOver: Partial<PuckBridge> = {}) {
  const bridge = {
    providers: vi.fn(async () => infos),
    providerAuthStart: vi.fn(async () => ({ url: 'https://claude.ai/oauth' })),
    providerAuthCancel: vi.fn(async () => undefined),
    providerAuthLogout: vi.fn(async () => undefined),
    githubInstallations: vi.fn(async () => []),
    githubRepos: vi.fn(async () => []),
    githubSetConfigRepo: vi.fn(async () => infos),
    openExternal: vi.fn(async () => undefined),
    ...bridgeOver,
  } as unknown as PuckBridge;
  const els = {
    harnessCards: document.createElement('div'),
    integrationCards: document.createElement('div'),
    msg: document.createElement('div'),
  } satisfies ProvidersElements;
  const scrollIntoView = vi.fn();
  els.msg.scrollIntoView = scrollIntoView;
  const copy = vi.fn(async () => undefined);
  const onProviders = vi.fn();
  const view = initProvidersView({ bridge, els, copy, onProviders, pollMs: 5 });
  return { bridge, els, copy, onProviders, view, scrollIntoView };
}

const card = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-provider="${id}"]`) as HTMLElement;
const btn = (root: HTMLElement, text: string): HTMLButtonElement =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

describe('providers view', () => {
  it('groups cards by kind, leaves runners to their own section, and shares the list with the harness cache', async () => {
    const infos = [harness(), harness({ id: 'codex', label: 'Codex' }), runnersCard(), gh()];
    const { els, view, onProviders } = mount(infos);
    await view.render();
    expect([...els.harnessCards.querySelectorAll('[data-provider]')].map((n) => (n as HTMLElement).dataset.provider)).toEqual(['claude-code', 'codex']);
    expect(card(els.harnessCards, 'runner') ?? card(els.integrationCards, 'runner')).toBeNull();
    expect(card(els.integrationCards, 'github')).toBeTruthy();
    expect(onProviders).toHaveBeenCalledWith(infos);
  });

  it('harness Connect starts the browser sign-in and polls until it settles', async () => {
    let pending = true;
    const { els, view, bridge } = mount([harness()], {
      providers: vi.fn(async () => [harness({ auth: { connected: !pending, pending, detail: '' } })]),
    });
    await view.render([harness()]);
    btn(card(els.harnessCards, 'claude-code'), 'Connect').click();
    await settle();
    expect(bridge.providerAuthStart).toHaveBeenCalledWith('claude-code');
    pending = false;
    await new Promise((r) => setTimeout(r, 20));
    expect(btn(card(els.harnessCards, 'claude-code'), 'Disconnect')).toBeTruthy();
    view.stopPolling();
  });
});

describe('GitHub card', () => {
  it('signed out: Sign in opens the browser through the Puck server, waits, and can be cancelled', async () => {
    let state = gh();
    const providerAuthStart = vi.fn(async () => {
      state = gh({}, { pending: true });
      return { url: 'https://github.com/login/oauth/authorize?x=1' };
    });
    const { els, view, bridge } = mount([], { providerAuthStart, providers: vi.fn(async () => [state]) });
    await view.render();
    expect(card(els.integrationCards, 'github').textContent).toContain('http://localhost:8765');
    btn(card(els.integrationCards, 'github'), 'Sign in with GitHub').click();
    await settle();
    await settle();
    expect(bridge.providerAuthStart).toHaveBeenCalledWith('github');
    const ghCard = card(els.integrationCards, 'github');
    expect(ghCard.textContent).toContain('Waiting for the sign-in in your browser');
    expect(btn(ghCard, 'Cancel')).toBeTruthy();
    // The browser sign-in landed: the poll sees pending clear and re-renders signed in.
    state = gh({ login: 'octocat', configRepo: null }, { connected: true, detail: 'Signed in to Puck as octocat' });
    await new Promise((r) => setTimeout(r, 20));
    expect(btn(card(els.integrationCards, 'github'), 'Sign out of Puck')).toBeTruthy();
    view.stopPolling();
  });

  it('never offers a device code or a token form', async () => {
    const { els, view } = mount([gh()]);
    await view.render();
    const ghCard = card(els.integrationCards, 'github');
    expect(ghCard.querySelector('.pv-user-code, details, form, input')).toBeNull();
    expect(ghCard.textContent).not.toMatch(/token|code/i);
  });

  it('signed in: installations with Manage, install link, config repo picker and Open repo', async () => {
    const githubInstallations = vi.fn(async () => [
      { id: 1, account: 'me', accountType: 'User', manageUrl: 'https://github.com/settings/installations/1', repositorySelection: 'selected' },
    ]);
    const githubRepos = vi.fn(async () => [
      { fullName: 'me/cfg', private: true, defaultBranch: 'main', htmlUrl: 'https://github.com/me/cfg' },
      { fullName: 'me/other', private: false, defaultBranch: 'main', htmlUrl: 'https://github.com/me/other' },
    ]);
    const githubSetConfigRepo = vi.fn(async () => [gh({ login: 'me', configRepo: 'me/other' }, { connected: true })]);
    const { els, view, bridge } = mount([gh({ login: 'me', configRepo: 'me/cfg' }, { connected: true })], {
      githubInstallations,
      githubRepos,
      githubSetConfigRepo,
    });
    await view.render();
    await settle();
    const ghCard = card(els.integrationCards, 'github');
    const install = ghCard.querySelector('[data-installation="1"]') as HTMLElement;
    expect(install.textContent).toContain('me');
    btn(install, 'Manage').click();
    expect(bridge.openExternal).toHaveBeenCalledWith('https://github.com/settings/installations/1');
    btn(ghCard, 'Install Puck on an account').click();
    expect(bridge.openExternal).toHaveBeenCalledWith('https://github.com/apps/puck/installations/new');
    btn(ghCard, 'Open repo').click();
    expect(bridge.openExternal).toHaveBeenCalledWith('https://github.com/me/cfg');

    const select = ghCard.querySelector('.pv-config-repo select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['me/cfg', 'me/other']);
    expect(select.value).toBe('me/cfg');
    select.value = 'me/other';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(githubSetConfigRepo).toHaveBeenCalledWith('me/other');
  });

  it('offers no install link while the app slug is unconfigured', async () => {
    const githubInstallations = vi.fn(async () => []);
    const { els, view } = mount([gh({ login: 'me', installUrl: null }, { connected: true })], { githubInstallations });
    await view.render();
    await settle();
    const ghCard = card(els.integrationCards, 'github');
    expect(ghCard.querySelector('.pv-installs')).not.toBeNull();
    expect([...ghCard.querySelectorAll('button')].some((b) => b.textContent === 'Install Puck on an account')).toBe(false);
  });

  it('signed in shows no mode line or token form; Sign out of Puck calls logout', async () => {
    const { els, view, bridge } = mount([gh({ login: 'me' }, { connected: true })]);
    await view.render();
    const ghCard = card(els.integrationCards, 'github');
    expect([...ghCard.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Account']);
    expect(ghCard.querySelector('details, form')).toBeNull();
    btn(ghCard, 'Sign out of Puck').click();
    await settle();
    expect(bridge.providerAuthLogout).toHaveBeenCalledWith('github');
  });
});

describe('focus refresh', () => {
  it('re-checks GitHub without clearing the cards', async () => {
    const githubInstallations = vi.fn(async () => []);
    const { els, view } = mount([gh({ login: 'me' }, { connected: true })], { githubInstallations });
    await view.render();
    await settle();

    // The user installed the app on GitHub and came back.
    const refreshing = view.refresh();
    expect(els.integrationCards.getAttribute('aria-busy')).toBeNull();
    await refreshing;
    await settle();

    expect(card(els.integrationCards, 'github')).toBeTruthy();
    expect(githubInstallations).toHaveBeenCalledTimes(2); // installations were re-checked
  });

  it('does nothing before the section has rendered once', async () => {
    const { view, bridge } = mount([runnersCard()]);
    await view.refresh();
    expect(bridge.providers).not.toHaveBeenCalled();
  });
});
