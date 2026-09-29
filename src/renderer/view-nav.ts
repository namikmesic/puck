/**
 * Navigation for the environment window, as a pure state machine.
 *
 * An environment shows one of two views, Chat (the orchestrator) or Board
 * (the work items), switched from the top bar (⌘1, ⌘2) and remembered per
 * environment. One work item's detail opens in a side sheet over either
 * view. First run replaces both. Settings and the start flow are modals
 * over whatever is showing, so closing one returns to it. Esc closes the
 * modal first, then the sheet (the palette, menus and the full-turn
 * overlay are closed by their owners before this).
 */

export type View = 'chat' | 'board';
export type Center = 'env' | 'first-run';
export type Modal = 'settings' | 'start';
export type SettingsSection = 'providers' | 'runners' | 'support';
export type WorkTab = 'conversation' | 'changes' | 'details';

export interface NavState {
  center: Center;
  view: View;
  /** The item open in the side sheet, or null when it is closed. */
  itemId: string | null;
  tab: WorkTab;
  modal: Modal | null;
  section: SettingsSection;
}

export type NavTarget =
  | { view: 'chat' }
  | { view: 'board' }
  | { view: 'item'; itemId: string; tab?: WorkTab }
  | { view: 'close-item' }
  | { view: 'first-run' }
  | { view: 'settings'; section?: SettingsSection }
  | { view: 'start' }
  | { view: 'close-modal' };

export const INITIAL_NAV: NavState = { center: 'env', view: 'chat', itemId: null, tab: 'conversation', modal: null, section: 'providers' };

export function navTransition(state: NavState, target: NavTarget): NavState {
  switch (target.view) {
    case 'chat':
    case 'board':
      return { ...state, center: 'env', view: target.view, modal: null };
    case 'item':
      return {
        ...state,
        center: 'env',
        itemId: target.itemId,
        tab: target.tab ?? (target.itemId === state.itemId ? state.tab : 'conversation'),
        modal: null,
      };
    case 'close-item':
      return { ...state, itemId: null };
    case 'first-run':
      return { ...state, center: 'first-run', itemId: null, modal: null };
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
  if (state.itemId) return { view: 'close-item' };
  return null;
}

const VIEW_KEY = 'puck.view.';

/** The view an environment showed last (a per-machine convenience); Chat when none was saved. */
export function readView(storage: Pick<Storage, 'getItem'> | null | undefined, envId: string): View {
  try {
    return storage?.getItem(VIEW_KEY + envId) === 'board' ? 'board' : 'chat';
  } catch {
    return 'chat';
  }
}

export function saveView(storage: Pick<Storage, 'setItem'> | null | undefined, envId: string, view: View): void {
  try {
    storage?.setItem(VIEW_KEY + envId, view);
  } catch {
    /* a convenience */
  }
}
