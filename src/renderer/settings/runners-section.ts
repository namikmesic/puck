/**
 * Settings → Runners (`rn-*`): the machines that host environments, as the
 * runner list with Rename, Labels and Remove in each row's menu, and Add
 * runner (the card itself is runners.ts). Runner events update the list
 * in place. Context/elements in, controller out.
 */

import type { EnvironmentProviderInfo, ProviderInfo, PuckBridge, RunnersState } from '../../harness/bridge';
import { initRunnersView } from './runners';
import { loadingInto } from './cards';
import { errText } from '../util';

export interface RunnersSectionContext {
  bridge: PuckBridge;
  els: { cards: HTMLElement; msg: HTMLElement };
  copy(text: string): Promise<void>;
}

export function initRunnersSection(ctx: RunnersSectionContext) {
  const { els } = ctx;
  const say = (text: string): void => {
    els.msg.textContent = text;
  };
  const view = initRunnersView({
    bridge: ctx.bridge,
    say,
    copy: ctx.copy,
  });
  let shown = false;

  return {
    async render(): Promise<void> {
      if (!shown) loadingInto(els.cards);
      const infos: ProviderInfo[] = await ctx.bridge.providers().catch((err: unknown) => {
        say(errText(err));
        return [];
      });
      const info = infos.find((p): p is EnvironmentProviderInfo => p.kind === 'environment');
      els.cards.removeAttribute('aria-busy');
      if (!info) {
        els.cards.textContent = '';
        shown = false;
        return;
      }
      const card = view.card(info);
      if (card.parentElement !== els.cards) {
        els.cards.textContent = '';
        els.cards.appendChild(card);
      }
      shown = true;
    },
    runnersChanged(state: RunnersState): void {
      if (shown) view.update(state);
    },
    close(): void {
      view.close();
    },
  };
}

export type RunnersSection = ReturnType<typeof initRunnersSection>;
