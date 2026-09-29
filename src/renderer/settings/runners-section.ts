/**
 * Settings → Runners (`rn-*`), the environment window's own section for
 * the machines that host environments: the runner list with Rename,
 * Labels and Remove in each row's menu, and Add runner (see runners.ts,
 * which the older window shows inside Providers). Runner events update the
 * list in place. Context/elements in, controller out.
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
    signedOutNote: 'Sign in to Puck with GitHub on the Providers page to add runners. Runners belong to your Puck account.',
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
      els.cards.textContent = '';
      if (info) els.cards.appendChild(view.card(info));
      shown = !!info;
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
