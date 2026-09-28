/**
 * The Settings → Providers section, grouped by kind: Harnesses (Claude
 * Code, Codex: Connect / Cancel / Disconnect), Runners (the machines that
 * host environments, see runners.ts) and Integrations (GitHub, signing in
 * to Puck, see github.ts). A sign-in completes in the system browser, so
 * while main reports `auth.pending` the view polls until it settles.
 * Runner events update the Runners card in place. Context/elements in,
 * controller out, no DOM lookups inside.
 */

import type { HarnessProviderInfo, ProviderInfo, PuckBridge, RunnersState } from '../../harness/bridge';
import { el, statusEl } from '../dom';
import { button, errText, latestToken } from '../util';
import { cardShell, loadingInto } from './cards';
import { githubCard } from './github';
import { initRunnersView } from './runners';

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
  /** Rebuild every card (a save or sign-in change: forms start empty). */
  render(infos?: ProviderInfo[]): Promise<void>;
  /** Stop polling a pending sign-in (leaving Settings abandons it). */
  stopPolling(): void;
  /**
   * The window regained focus: re-check (installations may have changed on
   * GitHub), keeping what the user was typing - they often switch away to
   * run the runner commands in a terminal, and come back to finish.
   */
  refresh(): Promise<void>;
  /** A pushed runner-list or connection change. */
  runnersChanged(state: RunnersState): void;
  /** Leaving Settings: stop polling and close the Add runner dialog. */
  close(): void;
}

export function initProvidersView(ctx: ProvidersContext): ProvidersView {
  const { bridge, els } = ctx;
  const grid = latestToken();
  const runners = initRunnersView({ bridge: bridge as PuckBridge, say: (t) => say(t), copy: ctx.copy });
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

  const containers = [els.harnessCards, els.envCards, els.integrationCards];

  /** In-progress form state, keyed by the `data-keep` tags the cards set. */
  type FormState = Map<string, string>;

  function snapshotForms(): FormState {
    const state: FormState = new Map();
    for (const c of containers) {
      c.querySelectorAll<HTMLInputElement>('input[data-keep]').forEach((i) => {
        if (i.value) state.set(i.dataset.keep as string, i.value);
      });
    }
    return state;
  }

  function restoreForms(state: FormState): void {
    for (const c of containers) {
      c.querySelectorAll<HTMLInputElement>('input[data-keep]').forEach((i) => {
        const value = state.get(i.dataset.keep as string);
        if (value !== undefined) i.value = value;
      });
    }
  }

  async function draw(given: ProviderInfo[] | undefined, keepForms: boolean): Promise<void> {
    if (!bridge) return;
    const token = grid.next();
    if (!given && !keepForms) for (const c of containers) loadingInto(c);
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
    // Taken as late as possible, so typing during the fetch is kept too.
    const kept = keepForms ? snapshotForms() : null;
    for (const c of containers) {
      c.removeAttribute('aria-busy');
      c.textContent = '';
    }
    for (const info of infos) {
      if (info.kind === 'harness') {
        els.harnessCards.appendChild(harnessCard(info));
      } else if (info.kind === 'environment') {
        els.envCards.appendChild(runners.card(info));
      } else {
        els.integrationCards.appendChild(githubCard(shared, info));
      }
      // Settings reopened mid-sign-in: resume watching it.
      if (!poll && info.kind !== 'environment' && info.auth.pending && !info.auth.connected) {
        pollUntilSettled(info.id);
      }
    }
    if (kept) restoreForms(kept);
  }

  const view: ProvidersView = {
    render: (given) => draw(given, false),
    stopPolling,
    async refresh() {
      if (rendered && !poll) await draw(undefined, true);
    },
    runnersChanged(state) {
      if (rendered) runners.update(state);
    },
    close() {
      stopPolling();
      runners.close();
    },
  };
  return view;
}
