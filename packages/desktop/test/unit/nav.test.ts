import { describe, expect, it } from 'vitest';
import type { AgentInfo, EnvironmentInfo } from '../../src/harness/bridge';
import { escapeTarget, navTransition, type NavState } from '../../src/renderer/nav';

const agent = {} as AgentInfo;
const env = {} as EnvironmentInfo;

const at = (view: NavState['view'], lastSection: NavState['lastSection'] = 'agents'): NavState => ({
  view,
  lastSection,
});

describe('navTransition', () => {
  it('settings without a section resumes the last-used one', () => {
    expect(navTransition(at('chat', 'envs'), { view: 'settings' })).toEqual(at('settings', 'envs'));
  });

  it('settings with a section switches and remembers it', () => {
    const s1 = navTransition(at('chat'), { view: 'settings', section: 'providers' });
    expect(s1).toEqual(at('settings', 'providers'));
    const s2 = navTransition(navTransition(s1, { view: 'chat' }), { view: 'settings' });
    expect(s2.lastSection).toBe('providers'); // survives leaving and reopening
  });

  it('detail pages set their parent section', () => {
    expect(navTransition(at('settings', 'envs'), { view: 'agent-detail', agent }).lastSection).toBe('agents');
    expect(navTransition(at('settings', 'agents'), { view: 'env-detail', env }).lastSection).toBe('envs');
  });

  it('going to chat keeps the last section for the next visit', () => {
    expect(navTransition(at('env-detail', 'envs'), { view: 'chat' })).toEqual(at('chat', 'envs'));
  });
});

describe('escapeTarget', () => {
  it('walks detail → parent list → chat → nothing', () => {
    let state = at('agent-detail', 'agents');
    const step1 = escapeTarget(state);
    expect(step1).toEqual({ view: 'settings' });
    if (!step1) throw new Error('unreachable');
    state = navTransition(state, step1);
    expect(state).toEqual(at('settings', 'agents'));

    const step2 = escapeTarget(state);
    expect(step2).toEqual({ view: 'chat' });
    if (!step2) throw new Error('unreachable');
    state = navTransition(state, step2);

    expect(escapeTarget(state)).toBeNull(); // chat: only renderer overlays remain
  });
});
