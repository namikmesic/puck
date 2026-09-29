import { describe, expect, it } from 'vitest';
import { escapeTarget, INITIAL_NAV, navTransition } from '../../src/renderer/view-nav';

describe('view nav', () => {
  it('opens work detail and returns to the orchestrator on Esc', () => {
    const work = navTransition(INITIAL_NAV, { view: 'work', itemId: 'itm_1' });
    expect(work).toMatchObject({ center: 'work', itemId: 'itm_1', tab: 'conversation' });
    expect(escapeTarget(work)).toEqual({ view: 'orchestrator' });
    expect(escapeTarget(navTransition(work, { view: 'orchestrator' }))).toBeNull();
  });

  it('keeps the tab when reopening the same item and resets it for another', () => {
    const changes = navTransition(INITIAL_NAV, { view: 'work', itemId: 'itm_1', tab: 'changes' });
    expect(navTransition(changes, { view: 'work', itemId: 'itm_1' }).tab).toBe('changes');
    expect(navTransition(changes, { view: 'work', itemId: 'itm_2' }).tab).toBe('conversation');
  });

  it('closes modals before leaving work detail, and keeps the center under them', () => {
    const work = navTransition(INITIAL_NAV, { view: 'work', itemId: 'itm_1' });
    const settings = navTransition(work, { view: 'settings', section: 'runners' });
    expect(settings).toMatchObject({ center: 'work', modal: 'settings', section: 'runners' });
    expect(escapeTarget(settings)).toEqual({ view: 'close-modal' });
    const closed = navTransition(settings, { view: 'close-modal' });
    expect(closed).toMatchObject({ center: 'work', modal: null });
    expect(navTransition(closed, { view: 'settings' }).section).toBe('runners');
    expect(navTransition(closed, { view: 'start' }).modal).toBe('start');
    expect(navTransition(settings, { view: 'first-run' })).toMatchObject({ center: 'first-run', modal: null });
  });
});
