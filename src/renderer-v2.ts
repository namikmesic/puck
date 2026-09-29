/**
 * Renderer entry for PUCK_UI=v2: the runner shell plus Settings → Providers
 * (Puck sign-in and runners). The legacy chat stays on the default window.
 */

import './styles/shell.css';
import './styles/settings.css';
import './styles/overlays.css';
import './styles/v2.css';
import './harness/bridge';
import { initProvidersView } from './renderer/settings/providers';
import { initV2Shell } from './renderer/v2-shell';

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const bridge = window.puck;
const overlay = byId('settings-overlay');
const providersView = initProvidersView({
  bridge,
  els: {
    harnessCards: byId('pv-harness-cards'),
    envCards: byId('pv-env-cards'),
    integrationCards: byId('pv-integration-cards'),
    msg: byId('provider-msg'),
  },
  copy: async (text) => {
    await navigator.clipboard?.writeText(text);
  },
});

function openSettings(): void {
  overlay.classList.remove('hidden');
  void providersView.render();
}

function closeSettings(): void {
  overlay.classList.add('hidden');
  providersView.close();
}

byId('open-settings').addEventListener('click', openSettings);
byId('settings-close').addEventListener('click', closeSettings);
byId('settings-nav').addEventListener('click', (ev) => {
  const item = (ev.target as HTMLElement).closest('.nav-item');
  if (item) void providersView.render();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !overlay.classList.contains('hidden')) closeSettings();
});
window.addEventListener('focus', () => {
  if (!overlay.classList.contains('hidden')) void providersView.refresh();
});

if (bridge) {
  initV2Shell({
    bridge,
    els: {
      list: byId('v2-envs'),
      startForm: byId('v2-start'),
      refSelect: byId('v2-ref'),
      defSelect: byId('v2-def'),
      runnerSelect: byId('v2-runner'),
      secrets: byId('v2-secrets'),
      startBtn: byId('v2-start-btn'),
      progress: byId('v2-progress'),
      chat: byId('v2-chat'),
      composer: byId('v2-composer'),
      prompt: byId('v2-prompt'),
      send: byId('v2-send'),
      error: byId('v2-error'),
    },
  });
  bridge.onRunnerEvent((event) => {
    if (event.kind === 'state') providersView.runnersChanged(event.state);
    else void bridge.runners().then((state) => providersView.runnersChanged(state));
  });
}
