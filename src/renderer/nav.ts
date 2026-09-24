/**
 * The navigation state machine, pure so its rules are testable: which view
 * is showing and which settings section is "last used" (where the gear,
 * Cmd+comma, the Settings crumb, and Escape all land). The DOM effects —
 * toggling views, inert, the modal — live in the renderer's applier.
 */

import type { AgentInfo, EnvironmentInfo } from '../harness/bridge';

export type View = 'chat' | 'settings' | 'env-detail' | 'agent-detail';
export type SettingsSection = 'agents' | 'providers' | 'envs' | 'support';

export interface NavState {
  view: View;
  /** Last-used settings section; detail pages set it to their parent. */
  lastSection: SettingsSection;
}

export type NavTarget =
  | { view: 'chat' }
  | { view: 'settings'; section?: SettingsSection }
  | { view: 'agent-detail'; agent: AgentInfo }
  | { view: 'env-detail'; env: EnvironmentInfo };

export function navTransition(state: NavState, target: NavTarget): NavState {
  switch (target.view) {
    case 'chat':
      return { view: 'chat', lastSection: state.lastSection };
    case 'settings':
      return { view: 'settings', lastSection: target.section ?? state.lastSection };
    case 'agent-detail':
      // Parent section: crumbs, Escape, and the sidebar highlight all key off it.
      return { view: 'agent-detail', lastSection: 'agents' };
    case 'env-detail':
      return { view: 'env-detail', lastSection: 'envs' };
  }
}

/**
 * Escape steps back one level: detail → its parent section list → close the
 * settings modal. Returns null in chat (the caller may still have overlays
 * of its own — palette, menus, the full-screen turn — to dismiss first).
 */
export function escapeTarget(state: NavState): { view: 'chat' } | { view: 'settings' } | null {
  if (state.view === 'chat') return null;
  if (state.view === 'settings') return { view: 'chat' };
  return { view: 'settings' }; // lastSection was set to the parent on detail entry
}
