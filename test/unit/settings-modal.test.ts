// @vitest-environment jsdom

/**
 * The environment window's Settings has exactly Providers, Runners and
 * Support: harnesses and GitHub under Providers, the runner list in its own
 * section, and the support facts.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ProviderInfo } from '../../src/harness/bridge';
import { initSettingsModal } from '../../src/renderer/settings/modal';
import { runnerRow, runnersInfo, runnersState } from './runners-fixtures';
import { fakeBridge } from './v2-fixtures';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const PROVIDERS: ProviderInfo[] = [
  {
    kind: 'harness',
    id: 'claude-code',
    label: 'Claude Code',
    models: [],
    thinkingLevels: [],
    systemPromptHint: '',
    configOptions: [],
    capabilities: { supportsAsk: true, subAgents: true, subAgentTranscript: true, streamsTokens: true, reportsCost: true },
    status: { state: 'connected', detail: '' },
    auth: { connected: true, detail: 'signed in', pending: false },
  },
  runnersInfo(),
  {
    kind: 'integration',
    id: 'github',
    label: 'GitHub',
    status: { state: 'disconnected', detail: '' },
    auth: { connected: false, detail: 'signed out', pending: false },
    github: { login: null, configRepo: null, installUrl: null, server: 'http://localhost:8765' },
  },
];

function setup() {
  document.body.innerHTML = `
    <div id="overlay" class="hidden">
      <nav id="nav"><button data-section="providers"></button><button data-section="runners"></button><button data-section="support"></button></nav>
      <button id="close"></button>
      <div id="sec-providers"><h2 class="page-title" tabindex="-1">Providers</h2><p id="pmsg"></p><div id="harness"></div><div id="integration"></div></div>
      <div id="sec-runners"><h2 class="page-title" tabindex="-1">Runners</h2><p id="rmsg"></p><div id="rn"></div></div>
      <div id="sec-support"><h2 class="page-title" tabindex="-1">Support</h2><dd id="ver"></dd><dd id="dir"></dd><dd id="log"></dd><button id="exp"></button><p id="smsg"></p></div>
    </div>`;
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const fake = fakeBridge({
    providers: vi.fn(async () => PROVIDERS),
    supportInfo: vi.fn(async () => ({ version: '0.0.1', dataDir: '/tmp/puck', logFile: '/tmp/puck/logs/puck.log' })),
  } as never);
  const pick = vi.fn();
  const requestClose = vi.fn();
  const modal = initSettingsModal({
    bridge: fake.bridge,
    els: {
      overlay: byId('overlay'),
      nav: byId('nav'),
      close: byId('close'),
      sections: { providers: byId('sec-providers'), runners: byId('sec-runners'), support: byId('sec-support') },
      providers: { harnessCards: byId('harness'), integrationCards: byId('integration'), msg: byId('pmsg') },
      runners: { cards: byId('rn'), msg: byId('rmsg') },
      support: { version: byId('ver'), dataDir: byId('dir'), logFile: byId('log'), exportBtn: byId('exp'), msg: byId('smsg') },
    },
    copy: async () => undefined,
    pick,
    requestClose,
  });
  return { ...fake, modal, byId, pick, requestClose };
}

describe('settings modal', () => {
  it('shows Providers without runners, and Runners in its own section', async () => {
    const { modal, byId } = setup();
    modal.show('providers');
    await flush();
    expect(byId('overlay').classList.contains('hidden')).toBe(false);
    expect(byId('harness').querySelectorAll('[data-provider]')).toHaveLength(1);
    expect(byId('integration').querySelector('[data-provider="github"]')).not.toBeNull();
    expect(document.querySelector('#sec-providers [data-provider="runner"]')).toBeNull();
    expect(byId('sec-runners').classList.contains('hidden')).toBe(true);
    modal.show('runners');
    await flush();
    expect(byId('sec-providers').classList.contains('hidden')).toBe(true);
    expect(byId('rn').querySelector('[data-provider="runner"]')).not.toBeNull();
    expect(byId('nav').querySelector('.active')?.getAttribute('data-section')).toBe('runners');
    modal.runnersChanged(runnersState({ runners: [] }));
    expect(byId('rn').textContent).toContain('No runners yet');
  });

  it('when signed out, the Runners section points at Providers, not Integrations below', async () => {
    const { modal, byId, bridge } = setup();
    (bridge.providers as ReturnType<typeof vi.fn>).mockResolvedValue([
      ...PROVIDERS.filter((p) => p.kind !== 'environment'),
      runnersInfo({ signedIn: false, runners: [] }),
    ]);
    modal.show('runners');
    await flush();
    const text = byId('rn').textContent ?? '';
    expect(text).toContain('Sign in to Puck with GitHub on the Providers page to add runners.');
    expect(text).not.toContain('Integrations below');
    expect([...byId('rn').querySelectorAll('button')].some((b) => b.textContent === 'Add runner')).toBe(false);
  });

  it('keeps an unsaved rename or labels edit across the focus refresh and a runner push', async () => {
    const { modal, byId } = setup();
    modal.show('runners');
    await flush();
    const press = (text: string): void => {
      const found = [...byId('rn').querySelectorAll('button')].find((b) => b.textContent === text);
      if (!found) throw new Error(`no ${text} button`);
      found.click();
    };
    const editor = (): HTMLInputElement => byId('rn').querySelector('form.rn-edit input') as HTMLInputElement;

    press('Rename');
    await flush();
    let input = editor();
    expect(input.value).toBe('build-box');
    input.value = 'big-box';
    input.focus();

    modal.refresh();
    await flush();
    input = editor();
    expect(input.value).toBe('big-box');
    expect(document.activeElement).toBe(input);

    modal.runnersChanged(runnersState({ runners: [runnerRow({ name: 'server-name' })] }));
    await flush();
    input = editor();
    expect(input.value).toBe('big-box');
    expect(document.activeElement).toBe(input);

    press('Labels');
    await flush();
    input = editor();
    expect(input.value).toBe('gpu');
    input.value = '';
    input.focus();
    modal.refresh();
    await flush();
    input = editor();
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
  });

  it('shows the support facts, and hands nav and close to the owner', async () => {
    const { modal, byId, pick, requestClose } = setup();
    modal.show('support');
    await flush();
    expect(byId('ver').textContent).toBe('0.0.1');
    (byId('nav').querySelector('[data-section="runners"]') as HTMLButtonElement).click();
    expect(pick).toHaveBeenCalledWith('runners');
    byId('close').click();
    expect(requestClose).toHaveBeenCalled();
    modal.hide();
    expect(modal.isOpen()).toBe(false);
    expect(byId('overlay').classList.contains('hidden')).toBe(true);
  });
});
