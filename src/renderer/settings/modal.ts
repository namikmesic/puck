/**
 * The environment window's Settings modal: Providers (harnesses and
 * GitHub), Runners, and Support. Nothing is created or deleted here except
 * runners, which are provider configuration. The section nav marks the one
 * shown; a sign-in finishing in the browser is picked up when the window
 * gets focus back. Context/elements in, controller out.
 */

import type { ProviderInfo, PuckBridge, RunnersState } from '../../harness/bridge';
import type { SettingsSection } from '../view-nav';
import { initProvidersView, type ProvidersElements } from './providers';
import { initRunnersSection } from './runners-section';
import { initSupportView, type SupportElements } from './support';

export interface SettingsModalElements {
  overlay: HTMLElement;
  nav: HTMLElement;
  close: HTMLButtonElement;
  sections: Record<SettingsSection, HTMLElement>;
  providers: Omit<ProvidersElements, 'envCards'>;
  runners: { cards: HTMLElement; msg: HTMLElement };
  support: SupportElements;
}

export interface SettingsModalContext {
  bridge: PuckBridge;
  els: SettingsModalElements;
  copy(text: string): Promise<void>;
  /** The nav asked for a section (the owner's navigation applies it). */
  pick(section: SettingsSection): void;
  /** The close button (the owner's navigation closes the modal). */
  requestClose(): void;
  /** Fresh provider lists (sign-ins changed): the owner may refresh what depends on them. */
  onProviders?(infos: ProviderInfo[]): void;
}

export function initSettingsModal(ctx: SettingsModalContext) {
  const { els, bridge } = ctx;
  const providers = initProvidersView({ bridge, els: els.providers, copy: ctx.copy, onProviders: ctx.onProviders });
  const runners = initRunnersSection({ bridge, els: els.runners, copy: ctx.copy });
  const support = initSupportView({ bridge, els: els.support });
  let open: SettingsSection | null = null;

  els.close.addEventListener('click', () => ctx.requestClose());
  for (const item of els.nav.querySelectorAll<HTMLButtonElement>('[data-section]')) {
    item.addEventListener('click', () => ctx.pick(item.dataset.section as SettingsSection));
  }

  function renderSection(section: SettingsSection): void {
    if (section === 'providers') void providers.render();
    else if (section === 'runners') void runners.render();
    else void support.render();
  }

  return {
    /** Show the modal on `section` (or switch sections). */
    show(section: SettingsSection): void {
      const was = open;
      open = section;
      els.overlay.classList.remove('hidden');
      for (const [id, node] of Object.entries(els.sections)) node.classList.toggle('hidden', id !== section);
      for (const item of els.nav.querySelectorAll<HTMLButtonElement>('[data-section]')) {
        item.classList.toggle('active', item.dataset.section === section);
        item.setAttribute('aria-current', item.dataset.section === section ? 'page' : 'false');
      }
      if (was !== section) {
        renderSection(section);
        els.sections[section].querySelector<HTMLElement>('.page-title')?.focus();
      }
    },
    hide(): void {
      if (open === null) return;
      open = null;
      els.overlay.classList.add('hidden');
      providers.close();
      runners.close();
    },
    isOpen: (): boolean => open !== null,
    /** The window got focus back: a browser sign-in may have finished. */
    refresh(): void {
      if (open === 'providers') void providers.refresh();
      else if (open === 'runners') void runners.render();
    },
    runnersChanged(state: RunnersState): void {
      runners.runnersChanged(state);
      providers.runnersChanged(state);
    },
  };
}

export type SettingsModal = ReturnType<typeof initSettingsModal>;
