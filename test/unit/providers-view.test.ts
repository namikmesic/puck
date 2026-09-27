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
import { SSH_CONFIG_BLOCK } from '../../src/renderer/settings/ssh-hosts';

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
  auth: { connected: false, pending: false, detail: 'Not connected' },
  ...over,
});

const local: EnvironmentProviderInfo = {
  kind: 'environment',
  id: 'docker-local',
  label: 'Local Docker',
  targets: [{ id: 'local', label: 'This Mac', host: null }],
  detail: 'docker CLI at /opt/homebrew/bin/docker',
};

const ssh = (hosts: Array<{ id: string; label: string; host: string }> = []): EnvironmentProviderInfo => ({
  kind: 'environment',
  id: 'docker-ssh',
  label: 'Docker over SSH',
  targets: hosts,
  detail: `${hosts.length} hosts`,
});

const gh = (over: Partial<IntegrationProviderInfo['github']> = {}, auth: Partial<IntegrationProviderInfo['auth']> = {}): IntegrationProviderInfo => ({
  kind: 'integration',
  id: 'github',
  label: 'GitHub',
  auth: { connected: false, pending: false, detail: 'Not connected — sign in with GitHub', ...auth },
  github: {
    login: null,
    mode: 'app',
    configRepo: null,
    installUrl: 'https://github.com/apps/puck/installations/new',
    appConfigured: true,
    pendingCode: null,
    patUrl: 'https://github.com/settings/personal-access-tokens/new?name=Puck',
    ...over,
  },
});

function mount(infos: ProviderInfo[], bridgeOver: Partial<PuckBridge> = {}) {
  const bridge = {
    providers: vi.fn(async () => infos),
    providerAuthStart: vi.fn(async () => ({ url: 'https://claude.ai/oauth' })),
    providerAuthCancel: vi.fn(async () => undefined),
    providerAuthLogout: vi.fn(async () => undefined),
    targetHealth: vi.fn(async () => ({ ok: true, version: '27.3.1', problem: null, message: 'Docker 27.3.1', checkedAt: 1 })),
    sshHostAdd: vi.fn(async () => infos),
    sshHostRemove: vi.fn(async () => infos),
    githubInstallations: vi.fn(async () => []),
    githubRepos: vi.fn(async () => []),
    githubSetConfigRepo: vi.fn(async () => infos),
    githubSetPat: vi.fn(async () => infos),
    openExternal: vi.fn(async () => undefined),
    ...bridgeOver,
  } as unknown as PuckBridge;
  const els = {
    harnessCards: document.createElement('div'),
    envCards: document.createElement('div'),
    integrationCards: document.createElement('div'),
    msg: document.createElement('div'),
  } satisfies ProvidersElements;
  const copy = vi.fn(async () => undefined);
  const onProviders = vi.fn();
  const view = initProvidersView({ bridge, els, copy, onProviders, pollMs: 5 });
  return { bridge, els, copy, onProviders, view };
}

const card = (host: HTMLElement, id: string): HTMLElement =>
  host.querySelector<HTMLElement>(`[data-provider="${id}"]`) as HTMLElement;
const btn = (root: HTMLElement, text: string): HTMLButtonElement =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

describe('providers view', () => {
  it('groups cards by kind and shares the list with the harness cache', async () => {
    const infos = [harness(), harness({ id: 'codex', label: 'Codex' }), local, ssh(), gh()];
    const { els, view, onProviders } = mount(infos);
    await view.render();
    expect([...els.harnessCards.querySelectorAll('[data-provider]')].map((n) => (n as HTMLElement).dataset.provider)).toEqual(['claude-code', 'codex']);
    expect([...els.envCards.querySelectorAll('.pv-card')].map((n) => (n as HTMLElement).dataset.provider)).toEqual(['docker-local', 'docker-ssh']);
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

describe('environment providers', () => {
  it('Check shows the health dot and message for a target', async () => {
    const targetHealth = vi.fn(async () => ({
      ok: false,
      version: null,
      problem: 'ssh-auth' as const,
      message: 'SSH sign-in to box failed.',
      checkedAt: 1,
    }));
    const { els, view } = mount([ssh([{ id: 'h1', label: 'Box', host: 'ssh://me@box' }])], { targetHealth });
    await view.render();
    const row = els.envCards.querySelector<HTMLElement>('[data-target="h1"]') as HTMLElement;
    expect(row.textContent).toContain('ssh://me@box');
    expect(row.querySelector('.status')?.textContent).toBe('unchecked');
    btn(row, 'Check').click();
    expect(row.querySelector('.status')?.textContent).toBe('checking');
    await settle();
    expect(targetHealth).toHaveBeenCalledWith('docker-ssh', 'h1');
    expect(row.querySelector('.status.bad')?.textContent).toBe('problem');
    expect(row.querySelector('.pv-health-msg')?.textContent).toBe('SSH sign-in to box failed.');
  });

  it('Add host submits label and host and re-renders from the returned list', async () => {
    const after = [local, ssh([{ id: 'h2', label: 'New', host: 'buildbox' }])];
    const sshHostAdd = vi.fn(async () => after);
    const { els, view } = mount([local, ssh()], { sshHostAdd });
    await view.render();
    const form = els.envCards.querySelector('form.pv-add-host') as HTMLFormElement;
    const [label, host] = [...form.querySelectorAll('input')];
    label.value = 'New';
    host.value = ' buildbox ';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    await settle();
    expect(sshHostAdd).toHaveBeenCalledWith({ label: 'New', host: 'buildbox' });
    expect(els.envCards.querySelector('[data-target="h2"]')).toBeTruthy();
  });

  it('Remove is armed (two clicks) and only SSH hosts have it', async () => {
    const sshHostRemove = vi.fn(async () => [local, ssh()]);
    const { els, view } = mount([local, ssh([{ id: 'h1', label: 'Box', host: 'box' }])], { sshHostRemove });
    await view.render();
    expect(btn(card(els.envCards, 'docker-local'), 'Remove')).toBeUndefined();
    const remove = btn(card(els.envCards, 'docker-ssh'), 'Remove');
    remove.click();
    expect(sshHostRemove).not.toHaveBeenCalled();
    remove.click();
    await settle();
    expect(sshHostRemove).toHaveBeenCalledWith('h1');
  });

  it('shows the SSH requirements and copies the recommended config block', async () => {
    const { els, view, copy } = mount([ssh()]);
    await view.render();
    const sshCard = card(els.envCards, 'docker-ssh');
    expect(sshCard.querySelector('.pv-code')?.textContent).toBe(SSH_CONFIG_BLOCK);
    expect(SSH_CONFIG_BLOCK).toContain('ControlMaster auto');
    expect(SSH_CONFIG_BLOCK).toContain('BatchMode yes');
    btn(sshCard, 'Copy').click();
    await settle();
    expect(copy).toHaveBeenCalledWith(SSH_CONFIG_BLOCK);
  });
});

describe('GitHub card', () => {
  it('signed out: starts the device flow and shows the code with copy-and-open', async () => {
    const code = { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 900_000 };
    let state = gh();
    const providerAuthStart = vi.fn(async () => {
      state = gh({ pendingCode: code }, { pending: true });
      return code;
    });
    const { els, view, bridge, copy } = mount([], { providerAuthStart, providers: vi.fn(async () => [state]) });
    await view.render();
    btn(card(els.integrationCards, 'github'), 'Sign in with GitHub').click();
    await settle();
    await settle();
    const ghCard = card(els.integrationCards, 'github');
    expect(ghCard.querySelector('.pv-user-code')?.textContent).toBe('ABCD-1234');
    btn(ghCard, 'Copy code and open github.com/login/device').click();
    await settle();
    expect(copy).toHaveBeenCalledWith('ABCD-1234');
    expect(bridge.openExternal).toHaveBeenCalledWith('https://github.com/login/device');
    // Approved on GitHub: the poll sees pending clear and re-renders signed in.
    state = gh({ login: 'octocat', configRepo: null }, { connected: true, detail: 'Signed in as octocat (GitHub App)' });
    await new Promise((r) => setTimeout(r, 20));
    expect(card(els.integrationCards, 'github').querySelector('.pv-user-code')).toBeNull();
    expect(btn(card(els.integrationCards, 'github'), 'Sign out')).toBeTruthy();
    view.stopPolling();
  });

  it('without a registered app the button is disabled and the token form is open', async () => {
    const { els, view } = mount([gh({ appConfigured: false })]);
    await view.render();
    const ghCard = card(els.integrationCards, 'github');
    expect(btn(ghCard, 'Sign in with GitHub').disabled).toBe(true);
    expect((ghCard.querySelector('details.pv-pat') as HTMLDetailsElement).open).toBe(true);
  });

  it('submits a personal access token and clears the field', async () => {
    const githubSetPat = vi.fn(async () => [gh({ login: 'octocat', mode: 'pat' }, { connected: true })]);
    const { els, view } = mount([gh()], { githubSetPat });
    await view.render();
    const form = card(els.integrationCards, 'github').querySelector('form.pv-pat-form') as HTMLFormElement;
    const input = form.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('password');
    input.value = 'github_pat_x';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(githubSetPat).toHaveBeenCalledWith('github_pat_x');
    expect(input.value).toBe('');
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

  it('token mode hides installations; Sign out calls logout', async () => {
    const { els, view, bridge } = mount([gh({ login: 'me', mode: 'pat' }, { connected: true })]);
    await view.render();
    const ghCard = card(els.integrationCards, 'github');
    expect(ghCard.querySelector('.pv-installs')).toBeNull();
    expect(bridge.githubInstallations).not.toHaveBeenCalled();
    btn(ghCard, 'Sign out').click();
    await settle();
    expect(bridge.providerAuthLogout).toHaveBeenCalledWith('github');
  });
});
