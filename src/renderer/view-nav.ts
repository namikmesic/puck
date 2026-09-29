/**
 * Navigation for the environment window, as a pure state machine.
 *
 * The center shows the orchestrator chat, one work item's detail, or the
 * first-run sequence. Settings and the start flow are modals over it, so
 * closing one returns to whatever the center showed. Esc closes the modal
 * first, then leaves work detail for the orchestrator (the palette, menus
 * and the full-turn overlay are closed by their owners before this).
 */

export type Center = 'orchestrator' | 'work' | 'first-run';
export type Modal = 'settings' | 'start';
export type SettingsSection = 'providers' | 'runners' | 'support';
export type WorkTab = 'conversation' | 'changes' | 'details';

export interface NavState {
  center: Center;
  /** The item work detail shows (kept when leaving it, for "back"). */
  itemId: string | null;
  tab: WorkTab;
  modal: Modal | null;
  section: SettingsSection;
}

export type NavTarget =
  | { view: 'orchestrator' }
  | { view: 'work'; itemId: string; tab?: WorkTab }
  | { view: 'first-run' }
  | { view: 'settings'; section?: SettingsSection }
  | { view: 'start' }
  | { view: 'close-modal' };

export const INITIAL_NAV: NavState = { center: 'orchestrator', itemId: null, tab: 'conversation', modal: null, section: 'providers' };

export function navTransition(state: NavState, target: NavTarget): NavState {
  switch (target.view) {
    case 'orchestrator':
      return { ...state, center: 'orchestrator', modal: null };
    case 'work':
      return {
        ...state,
        center: 'work',
        itemId: target.itemId,
        tab: target.tab ?? (target.itemId === state.itemId && state.center === 'work' ? state.tab : 'conversation'),
        modal: null,
      };
    case 'first-run':
      return { ...state, center: 'first-run', modal: null };
    case 'settings':
      return { ...state, modal: 'settings', section: target.section ?? state.section };
    case 'start':
      return { ...state, modal: 'start' };
    case 'close-modal':
      return { ...state, modal: null };
  }
}

/** Where Esc goes from here; null when there is nothing to close. */
export function escapeTarget(state: NavState): NavTarget | null {
  if (state.modal) return { view: 'close-modal' };
  if (state.center === 'work') return { view: 'orchestrator' };
  return null;
}
