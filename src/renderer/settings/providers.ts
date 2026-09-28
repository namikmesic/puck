/**
 * The Settings → Providers section, grouped by kind: Harnesses (Claude
 * Code, Codex: Connect / Cancel / Disconnect), Environments (Local Docker,
 * Docker over SSH, see ssh-hosts.ts) and Integrations (GitHub, see
 * github.ts). A sign-in completes outside the app (system browser or
 * github.com), so while main reports `auth.pending` the view polls until it
 * settles. Context/elements in, controller out, no DOM lookups inside.
 */

import type { HarnessProviderInfo, ProviderInfo, PuckBridge } from '../../harness/bridge';
import { el, statusEl } from '../dom';
import { button, errText, latestToken } from '../util';
import { cardShell, loadingInto } from './cards';
import { githubCard } from './github';
import { envProviderCard } from './ssh-hosts';

export interface ProvidersElements {
  harnessCards: HTMLElement;
  envCards: HTMLElement;
  integrationCards: HTMLElement;
  msg: HTMLElement;
}

export interface ProvidersContext {
  bridge: PuckBridge | undefined;
  els: ProvidersElements;
  /** Every fresh provider list (the renderer's harness cache follows it). */
  onProviders?(infos: ProviderInfo[]): void;
  copy(text: string): Promise<void>;
  /** Poll cadence while a sign-in is pending (tests shorten it). */
  pollMs?: number;
}

export interface ProvidersView {
  render(infos?: ProviderInfo[]): Promise<void>;
  /** Stop polling a pending sign-in (leaving Settings abandons it). */
  stopPolling(): void;
  /** The window regained focus: re-check (installations may have changed on GitHub). */
  refresh(): void;
}

export function initProvidersView(ctx: ProvidersContext): ProvidersView {
  const { bridge, els } = ctx;
  const grid = latestToken();
  let poll: ReturnType<typeof setInterval> | null = null;
  let rendered = false;

  /** The message line sits at the top of the section, above the card that failed. */
  function say(text: string): void {
    els.msg.textContent = text;
    if (text) els.msg.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function stopPolling(): void {
    if (poll) clearInterval(poll);
    poll = null;
  }

  function pendingOf(infos: ProviderInfo[], id: string): boolean {
    const info = infos.find((p) => p.id === id);
    return !!info && info.kind !== 'environment' && info.auth.pending;
  }

  function pollUntilSettled(providerId: string): void {
    if (!bridge) return;
    stopPolling();
    poll = setInterval(async () => {
      const latest = await bridge.providers().catch(() => null);
      if (!latest || pendingOf(latest, providerId)) return;
      stopPolling();
      await view.render(latest);
    }, ctx.pollMs ?? 2000);
  }

  function harnessCard(info: HarnessProviderInfo): HTMLElement {
    const card = cardShell({
      title: info.label,
      headRight: statusEl(info.auth.connected, info.auth.connected ? 'connected' : 'offline'),
    });
    card.dataset.provider = info.id;
    const waiting = info.auth.pending && !info.auth.connected;
    card.appendChild(
      el(
        'div',
        'card-sub',
        waiting ? 'waiting for the sign-in in your browser… come back here when done' : info.auth.detail,
      ),
    );
    const foot = el('div', 'card-foot');
    const btn = button('btn-ghost', info.auth.connected ? 'Disconnect' : waiting ? 'Cancel' : 'Connect');
    btn.addEventListener('click', async () => {
      if (!bridge) return;
      btn.disabled = true;
      say('');
      try {
        if (info.auth.connected) {
          stopPolling();
          await bridge.providerAuthLogout(info.id);
        } else if (waiting) {
          stopPolling();
          await bridge.providerAuthCancel(info.id);
        } else {
          await bridge.providerAuthStart(info.id);
          pollUntilSettled(info.id);
        }
      } catch (err) {
        say(errText(err));
      }
      await view.render();
    });
    foot.appendChild(btn);
    card.appendChild(foot);
    return card;
  }

  const view: ProvidersView = {
    async render(given) {
      if (!bridge) return;
      const token = grid.next();
      if (!given) for (const c of [els.harnessCards, els.envCards, els.integrationCards]) loadingInto(c);
      const infos = given ?? (await bridge.providers().catch((err: unknown) => {
        say(errText(err));
        return [] as ProviderInfo[];
      }));
      if (!grid.isCurrent(token)) return;
      rendered = true;
      ctx.onProviders?.(infos);
      const shared = {
        bridge,
        say,
        copy: ctx.copy,
        onChange: (next?: ProviderInfo[]) => void view.render(next),
        onSignInStarted: (id: string) => pollUntilSettled(id),
      };
      for (const c of [els.harnessCards, els.envCards, els.integrationCards]) {
        c.removeAttribute('aria-busy');
        c.textContent = '';
      }
      for (const info of infos) {
        if (info.kind === 'harness') {
          els.harnessCards.appendChild(harnessCard(info));
        } else if (info.kind === 'environment') {
          els.envCards.appendChild(envProviderCard(shared, info));
        } else {
          els.integrationCards.appendChild(githubCard(shared, info));
        }
        // Settings reopened mid-sign-in: resume watching it.
        if (!poll && info.kind !== 'environment' && info.auth.pending && !info.auth.connected) {
          pollUntilSettled(info.id);
        }
      }
    },
    stopPolling,
    refresh() {
      if (rendered && !poll) void view.render();
    },
  };
  return view;
}
