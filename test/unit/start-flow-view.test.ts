// @vitest-environment jsdom

/**
 * The start flow gates each step on the one before it: a ref and a valid
 * definition, a runner that can take it, connected harnesses and filled
 * secrets; then it starts, switches the window, shows progress and closes
 * once the environment is ready.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DefinitionListing, HarnessProviderInfo, RunnersState } from '../../src/harness/bridge';
import { createInstanceStore } from '../../src/renderer/instance-store';
import { errorsFor, harnessesFor, initStartFlow, orderRunners } from '../../src/renderer/start-flow';
import { LOCAL_ID, RID, runnerRow, runnersState } from './runners-fixtures';
import { ENV, fakeBridge, instance } from './v2-fixtures';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const PIN = { kind: 'tag' as const, name: 'v1.2.0', sha: 'c'.repeat(40) };

function listing(): DefinitionListing {
  return {
    repo: 'octo/config',
    pin: PIN,
    sha: PIN.sha,
    environments: [
      { name: 'example', path: 'environments/example.yaml', description: 'The example', valid: true, startable: true, orchestrator: 'lead', agents: ['implementer'], secrets: ['NPM_TOKEN'], resources: { cpus: 2, memory: '4g' } },
      { name: 'broken', path: 'environments/broken.yaml', description: '', valid: false, startable: false, orchestrator: null, agents: [], secrets: [], resources: { cpus: null, memory: null } },
    ],
    agents: [
      { name: 'lead', path: 'agents/lead.yaml', description: '', harness: 'claude-code', valid: true },
      { name: 'implementer', path: 'agents/implementer.yaml', description: '', harness: 'codex', valid: true },
    ],
    errors: [{ file: 'environments/broken.yaml', line: 4, column: 3, field: 'image', rule: 'image.required', message: 'image is required', url: 'https://github.com/octo/config/blob/ccc/environments/broken.yaml#L4' }],
  };
}

function harness(id: string, connected: boolean): HarnessProviderInfo {
  return {
    kind: 'harness',
    id,
    label: id === 'codex' ? 'Codex' : 'Claude Code',
    models: [],
    thinkingLevels: [],
    systemPromptHint: '',
    configOptions: [],
    capabilities: { supportsAsk: true, subAgents: true, subAgentTranscript: true, streamsTokens: true, reportsCost: true },
    status: { state: connected ? 'connected' : 'disconnected', detail: '' },
    auth: { connected, detail: '', pending: false },
  };
}

function setup(runners: RunnersState = runnersState({ runners: [runnerRow(), runnerRow({ id: LOCAL_ID, name: 'This Mac', local: true, labels: ['local'] })] })) {
  document.body.innerHTML = '<div id="body"></div>';
  let codexConnected = false;
  const fake = fakeBridge({
    definitionRefs: vi.fn(async () => ({ tags: [{ name: 'v1.2.0', sha: PIN.sha }, { name: 'v1.1.0', sha: 'd'.repeat(40) }], branches: [{ name: 'main', sha: 'e'.repeat(40) }], defaultTag: 'v1.2.0' })),
    definitionsAt: vi.fn(async () => listing()),
    providers: vi.fn(async () => [harness('claude-code', true), harness('codex', codexConnected)]),
    providerAuthStart: vi.fn(async () => {
      codexConnected = true;
      return { url: 'https://auth' };
    }),
    instanceStart: vi.fn(async () => ({ envId: ENV })),
  });
  const store = createInstanceStore({ requestResync: () => undefined });
  const opened = vi.fn();
  const close = vi.fn();
  const openRunners = vi.fn();
  const body = document.getElementById('body') as HTMLElement;
  const flow = initStartFlow({ body, bridge: fake.bridge, store, runners: () => runners, opened, close, openRunners, pollMs: 1, now: () => 30_000 });
  const q = <T extends HTMLElement>(sel: string) => body.querySelector(sel) as T;
  const startBtn = () => q<HTMLButtonElement>('.sf-start');
  return { ...fake, store, flow, opened, close, openRunners, body, q, startBtn };
}

describe('start flow', () => {
  it('preselects the newest tag and lists definitions, invalid ones with their errors', async () => {
    const { flow, q, body, bridge } = setup();
    await flow.open();
    await flush();
    expect(q<HTMLSelectElement>('.sf-ref').value).toBe('tag:v1.2.0');
    expect(bridge.definitionsAt).toHaveBeenCalledWith({ kind: 'tag', name: 'v1.2.0' });
    const broken = q('[data-definition="broken"]');
    expect(broken.classList.contains('invalid')).toBe(true);
    expect((broken.querySelector('input') as HTMLInputElement).disabled).toBe(true);
    expect(broken.querySelector('.sf-err-where')?.textContent).toBe('environments/broken.yaml:4');
    (broken.querySelector('.sf-err-open') as HTMLButtonElement).click();
    expect(bridge.openExternal).toHaveBeenCalledWith('https://github.com/octo/config/blob/ccc/environments/broken.yaml#L4');
    // The only startable definition is picked for you.
    expect(q('[data-definition="example"]').classList.contains('selected')).toBe(true);
    expect(body.querySelector('[data-step="2"]')?.classList.contains('disabled')).toBe(false);
    expect(body.querySelector('[data-step="3"]')?.classList.contains('disabled')).toBe(true);
  });

  it('lists This Mac first, filters by label, and blocks runners that cannot take it', async () => {
    const small = runnerRow({ id: 'rnr_small', name: 'tiny', docker: { ok: true, version: '27', problem: null, ncpu: 1, memTotal: 1024 ** 3 } });
    const offline = runnerRow({ id: 'rnr_off', name: 'old-nuc', status: 'offline' });
    const { flow, q, body } = setup(runnersState({ runners: [runnerRow(), small, offline, runnerRow({ id: LOCAL_ID, name: 'This Mac', local: true, labels: ['local'] })] }));
    await flow.open();
    await flush();
    const names = [...body.querySelectorAll('.sf-runner-name')].map((n) => n.textContent);
    expect(names).toEqual(['This Mac', 'build-box', 'old-nuc', 'tiny']);
    expect(q('[data-runner="rnr_small"] .sf-runner-why').textContent).toBe('The environment asks for 2 CPUs; tiny has 1.');
    expect(q<HTMLInputElement>('[data-runner="rnr_off"] input').disabled).toBe(true);
    (body.querySelector('.sf-label') as HTMLButtonElement).click(); // "gpu"
    expect([...body.querySelectorAll('.sf-runner-name')].map((n) => n.textContent)).toEqual(['build-box', 'old-nuc', 'tiny']);
  });

  it('asks for harnesses and secrets before Start, then starts, switches and closes when ready', async () => {
    const { flow, q, startBtn, bridge, opened, close, store } = setup();
    await flow.open();
    await flush();
    const pick = q<HTMLInputElement>(`[data-runner="${RID}"] input`);
    pick.checked = true;
    pick.dispatchEvent(new Event('change'));
    expect(startBtn().disabled).toBe(true);
    expect(q('.sf-why').textContent).toBe('Connect Codex.');
    expect(q('[data-harness="claude-code"] .sf-harness-state').textContent).toBe('connected');
    (q('[data-harness="codex"] button') as HTMLButtonElement).click();
    await flush();
    expect(bridge.providerAuthStart).toHaveBeenCalledWith('codex');
    expect(q('.sf-why').textContent).toBe('Enter a value for NPM_TOKEN.');
    const secret = q<HTMLInputElement>('input[name="NPM_TOKEN"]');
    secret.value = 's3cret';
    secret.dispatchEvent(new Event('input'));
    expect(startBtn().disabled).toBe(false);
    startBtn().click();
    await flush();
    expect(bridge.instanceStart).toHaveBeenCalledWith({ pin: { kind: 'tag', name: 'v1.2.0' }, definition: 'example', runnerId: RID, secrets: { NPM_TOKEN: 's3cret' } });
    expect(opened).toHaveBeenCalledWith(ENV);
    store.setInstances([instance({ daemon: { status: 'provisioning', stage: 'installing-clis', detail: 'npm i' } })]);
    flow.changed();
    expect(q('.sf-progress-line').textContent).toBe('installing harness CLIs · npm i');
    expect(close).not.toHaveBeenCalled();
    store.setInstances([instance({ daemon: { status: 'ready' } })]);
    flow.changed();
    expect(close).toHaveBeenCalled();
  });

  it('shows why a start was refused and keeps the form', async () => {
    const { flow, q, startBtn, bridge } = setup();
    (bridge.instanceStart as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('build-box is offline.'));
    (bridge.providers as ReturnType<typeof vi.fn>).mockResolvedValue([harness('claude-code', true), harness('codex', true)]);
    await flow.open();
    await flush();
    const pick = q<HTMLInputElement>(`[data-runner="${RID}"] input`);
    pick.checked = true;
    pick.dispatchEvent(new Event('change'));
    const secret = q<HTMLInputElement>('input[name="NPM_TOKEN"]');
    secret.value = 'x';
    secret.dispatchEvent(new Event('input'));
    startBtn().click();
    await flush();
    expect(q('.sf-error').textContent).toBe('build-box is offline.');
    expect(startBtn()).not.toBeNull();
  });

  it('sends people with no runner to Settings, and takes a commit SHA', async () => {
    const { flow, q, openRunners, bridge } = setup(runnersState({ runners: [] }));
    await flow.open();
    await flush();
    (q('[data-step="2"] button') as HTMLButtonElement).click();
    expect(openRunners).toHaveBeenCalled();
    const ref = q<HTMLSelectElement>('.sf-ref');
    ref.value = 'commit';
    ref.dispatchEvent(new Event('change'));
    await flush();
    const sha = q<HTMLInputElement>('.sf-sha');
    sha.value = 'ABCDEF1';
    sha.dispatchEvent(new Event('change'));
    await flush();
    expect(bridge.definitionsAt).toHaveBeenLastCalledWith({ kind: 'commit', name: 'abcdef1' });
  });

  it('orders runners and finds harnesses and errors', () => {
    expect(orderRunners([runnerRow({ name: 'b' }), runnerRow({ name: 'a' }), runnerRow({ name: 'z', local: true })]).map((r) => r.name)).toEqual(['z', 'a', 'b']);
    const l = listing();
    expect(harnessesFor(l.environments[0] as never, l)).toEqual(['claude-code', 'codex']);
    expect(errorsFor(l.environments[1] as never, l)).toHaveLength(1);
  });
});
