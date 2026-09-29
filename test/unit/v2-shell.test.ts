// @vitest-environment jsdom

/**
 * The v2 shell starts an environment on a runner and talks to its daemon.
 * Events apply in seq order; a snapshot replaces the chat and is what a
 * reopen renders.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DaemonEventPayload, InstanceInfo, PuckBridge, RunnersState } from '../../src/harness/bridge';
import type { Snapshot } from '../../src/harness/daemon-protocol';
import { initV2Shell, type V2Elements } from '../../src/renderer/v2-shell';
import { runnerRow } from './runners-fixtures';

const ENV = 'env_01J8Z3X0000000000000000000';

function els(): V2Elements {
  document.body.innerHTML = `
    <div id="v2-envs"></div>
    <form id="v2-start">
      <select id="v2-ref"></select>
      <select id="v2-def"></select>
      <select id="v2-runner"></select>
      <div id="v2-secrets"></div>
      <button id="v2-start-btn" type="submit">Start</button>
      <p id="v2-progress"></p>
    </form>
    <div id="v2-chat"></div>
    <form id="v2-composer"><textarea id="v2-prompt"></textarea><button id="v2-send" type="submit">Send</button></form>
    <p id="v2-error"></p>`;
  const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  return {
    list: byId('v2-envs'),
    startForm: byId('v2-start'),
    refSelect: byId('v2-ref'),
    defSelect: byId('v2-def'),
    runnerSelect: byId('v2-runner'),
    secrets: byId('v2-secrets'),
    startBtn: byId('v2-start-btn'),
    progress: byId('v2-progress'),
    chat: byId('v2-chat'),
    composer: byId('v2-composer'),
    prompt: byId('v2-prompt'),
    send: byId('v2-send'),
    error: byId('v2-error'),
  };
}

function instance(over: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id: ENV,
    name: 'example',
    runnerId: 'rnr_ok',
    runnerName: 'build-box',
    local: true,
    status: 'active',
    repos: [],
    current: false,
    attach: null,
    attachDetail: '',
    daemon: null,
    op: null,
    lastSeq: null,
    ...over,
  };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    envId: ENV,
    name: 'example',
    daemon: { version: '0.0.1', build: 'test', protocol: 1 },
    head: 0,
    instance: { status: 'ready', pin: null, sha: null },
    github: { state: 'missing' },
    sessions: [],
    orchestratorSessionId: 'ses_orch',
    items: [],
    order: [],
    capacity: { agents: {}, workers: { running: 0, max: 1 }, paused: false },
    inflight: [],
    asks: [],
    ...over,
  };
}

async function waitFor(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 40 && !ok(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!ok()) throw new Error('timed out');
}

function mount(over: { instances?: InstanceInfo[]; history?: string; failSnapshots?: number } = {}) {
  const ui = els();
  const daemonCalls: { op: string; args: unknown }[] = [];
  let failedSnapshots = 0;
  const attachedIds = new Set((over.instances ?? []).filter((info) => info.attach === 'attached').map((info) => info.id));
  let onInstance: (e: { kind: 'upsert'; instance: InstanceInfo } | { kind: 'removed'; envId: string }) => void = () => undefined;
  let onDaemon: (e: DaemonEventPayload) => void = () => undefined;
  let onRunner: (e: never) => void = () => undefined;
  const runners: RunnersState = {
    signedIn: true,
    login: 'octo',
    server: 'http://puck.test',
    connection: 'connected',
    local: { supported: true, installed: true, runnerId: 'rnr_ok', busy: null, detail: '', error: null },
    runners: [
      runnerRow({ id: 'rnr_ok', name: 'build-box', status: 'idle', docker: { ok: true, version: '27.3.1', problem: null, ncpu: 8, memTotal: 8 * 1024 ** 3 } }),
      runnerRow({ id: 'rnr_off', name: 'offline-box', status: 'offline' }),
      runnerRow({
        id: 'rnr_full',
        name: 'full-box',
        status: 'idle',
        maxEnvironments: 1,
        environments: [{ envId: 'env_other', definition: 'example', status: 'active' }],
      }),
    ],
  };
  const bridge = {
    instanceList: vi.fn(async () => over.instances ?? [instance()]),
    instanceStart: vi.fn(async () => ({ envId: ENV })),
    instanceOpen: vi.fn(async () => undefined),
    runners: vi.fn(async () => runners),
    definitionRefs: vi.fn(async () => ({ tags: [{ name: 'v1', sha: 'abc' }], branches: [], defaultTag: 'v1' })),
    definitionsAt: vi.fn(async () => ({
      repo: 'acme/cfg',
      pin: { kind: 'tag', name: 'v1', sha: 'abc' },
      sha: 'abc',
      agents: [],
      errors: [],
      environments: [
        {
          name: 'example',
          path: 'envs/example.yaml',
          description: '',
          valid: true,
          startable: true,
          orchestrator: 'lead',
          agents: [],
          secrets: ['TOKEN'],
          resources: { cpus: 2, memory: '1g' },
        },
      ],
    })),
    daemon: vi.fn(async (envId: string, op: string, args: unknown) => {
      daemonCalls.push({ op, args });
      if (op === 'snapshot.get') {
        if (!attachedIds.has(envId)) throw new Error('The environment is not attached yet.');
        failedSnapshots += 1;
        if (over.failSnapshots && failedSnapshots <= over.failSnapshots) throw new Error('snapshot failed');
        return snap();
      }
      if (op === 'session.history') {
        return {
          entries: over.history ? [{ kind: 'user', text: over.history, author: 'user', ts: 1 }] : [],
          total: over.history ? 1 : 0,
          hasMore: false,
        };
      }
      return { queued: true };
    }),
    onInstanceEvent: (cb: typeof onInstance) => {
      onInstance = cb;
    },
    onDaemonEvent: (cb: typeof onDaemon) => {
      onDaemon = cb;
    },
    onRunnerEvent: (cb: typeof onRunner) => {
      onRunner = cb;
    },
  } as unknown as PuckBridge;
  const shell = initV2Shell({ bridge, els: ui });
  return {
    ui,
    bridge,
    shell,
    daemonCalls,
    emitInstance: (e: Parameters<typeof onInstance>[0]) => {
      if (e.kind === 'upsert' && e.instance.attach === 'attached') attachedIds.add(e.instance.id);
      else if (e.kind === 'upsert') attachedIds.delete(e.instance.id);
      else attachedIds.delete(e.envId);
      onInstance(e);
    },
    emitDaemon: (e: DaemonEventPayload) => onDaemon(e),
  };
}

async function attachCurrent(env: { bridge: PuckBridge; emitInstance: (e: { kind: 'upsert'; instance: InstanceInfo }) => void }): Promise<void> {
  await waitFor(() => (env.bridge.instanceOpen as ReturnType<typeof vi.fn>).mock.calls.length >= 1);
  env.emitInstance({ kind: 'upsert', instance: instance({ current: true, attach: 'attached' }) });
}

describe('v2 shell', () => {
  it('starts on a runner that has room and sends the definition secrets', async () => {
    const { ui, bridge } = mount();
    await waitFor(() => ui.runnerSelect.options.length > 1);
    expect(ui.defSelect.value).toBe('example');
    expect((ui.runnerSelect.querySelector('option[value="rnr_off"]') as HTMLOptionElement).disabled).toBe(true);
    expect((ui.runnerSelect.querySelector('option[value="rnr_full"]') as HTMLOptionElement).disabled).toBe(true);
    expect((ui.runnerSelect.querySelector('option[value="rnr_ok"]') as HTMLOptionElement).disabled).toBe(false);
    expect(ui.runnerSelect.querySelector('option[value="rnr_ok"]')?.textContent).toMatch(/Docker 27\.3\.1/);
    await waitFor(() => ui.secrets.querySelector('input') !== null);
    ui.runnerSelect.value = 'rnr_ok';
    const secret = ui.secrets.querySelector('input') as HTMLInputElement;
    expect(secret.name).toBe('TOKEN');
    secret.value = 's3cret';
    ui.startForm.requestSubmit();
    await waitFor(() => (bridge.instanceStart as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    expect(bridge.instanceStart).toHaveBeenCalledWith({
      pin: { kind: 'tag', name: 'v1' },
      definition: 'example',
      runnerId: 'rnr_ok',
      secrets: { TOKEN: 's3cret' },
    });
    await waitFor(() => (bridge.instanceOpen as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    expect(bridge.instanceOpen).toHaveBeenCalledWith(ENV);
  });

  it('shows start progress from instance events', async () => {
    const { ui, emitInstance, shell } = mount();
    await waitFor(() => ui.secrets.querySelector('input') !== null);
    ui.runnerSelect.value = 'rnr_ok';
    (ui.secrets.querySelector('input') as HTMLInputElement).value = 's3cret';
    ui.startForm.requestSubmit();
    await waitFor(() => shell.openEnvId() === ENV);
    emitInstance({
      kind: 'upsert',
      instance: instance({ op: { kind: 'starting', stage: 'pulling-image', detail: 'Pulling the image', startedAt: 1, error: null } }),
    });
    await waitFor(() => ui.progress.textContent?.includes('pulling-image') === true);
    expect(ui.progress.textContent).toContain('Pulling the image');
  });

  it('applies daemon events in seq order and replaces the chat on a snapshot', async () => {
    const env = mount({ instances: [instance({ current: true, attach: 'connecting' })], history: 'remember me' });
    const { ui, emitDaemon, daemonCalls } = env;
    await attachCurrent(env);
    await waitFor(() => ui.chat.textContent?.includes('remember me') === true);
    emitDaemon({
      envId: ENV,
      seq: 2,
      at: 2,
      ev: { kind: 'turn.user', sessionId: 'ses_orch', entry: { kind: 'user', text: 'second', author: 'user', ts: 2 } },
    });
    expect(ui.chat.textContent).not.toContain('second');
    emitDaemon({
      envId: ENV,
      seq: 1,
      at: 1,
      ev: { kind: 'turn.user', sessionId: 'ses_orch', entry: { kind: 'user', text: 'first', author: 'user', ts: 1 } },
    });
    expect(ui.chat.textContent).toMatch(/remember me[\s\S]*first[\s\S]*second/);
    emitDaemon({
      envId: ENV,
      seq: 1,
      at: 1,
      ev: { kind: 'turn.user', sessionId: 'ses_orch', entry: { kind: 'user', text: 'again', author: 'user', ts: 1 } },
    });
    expect(ui.chat.textContent).not.toContain('again');

    const before = daemonCalls.filter((call) => call.op === 'snapshot.get').length;
    emitDaemon({
      envId: ENV,
      seq: 4,
      at: 4,
      ev: { kind: 'turn.user', sessionId: 'ses_orch', entry: { kind: 'user', text: 'gapped', author: 'user', ts: 4 } },
    });
    await waitFor(() => daemonCalls.filter((call) => call.op === 'snapshot.get').length > before);
    expect(ui.chat.textContent).not.toContain('gapped');
  });

  it('sends the orchestrator message through the daemon', async () => {
    const env = mount({ instances: [instance({ current: true, attach: 'connecting' })], history: 'hello' });
    const { ui, daemonCalls } = env;
    await attachCurrent(env);
    await waitFor(() => ui.chat.textContent?.includes('hello') === true);
    ui.prompt.value = 'ship it';
    ui.composer.requestSubmit();
    await waitFor(() => daemonCalls.some((call) => call.op === 'chat.send'));
    expect(daemonCalls.find((call) => call.op === 'chat.send')?.args).toEqual({ sessionId: 'ses_orch', text: 'ship it' });
    expect(ui.prompt.value).toBe('');
  });

  it('reopens on the current environment and renders its transcript', async () => {
    const env = mount({ instances: [instance({ current: true, attach: 'connecting' })], history: 'still here' });
    const { ui, bridge } = env;
    await attachCurrent(env);
    await waitFor(() => ui.chat.textContent?.includes('still here') === true);
    expect(bridge.instanceOpen).toHaveBeenCalledWith(ENV);
    expect(ui.list.querySelector('.v2-env.selected')?.getAttribute('data-env')).toBe(ENV);
  });

  it('buffers daemon events until attach, then snapshots and drains them', async () => {
    const env = mount({ instances: [instance({ current: true, attach: 'connecting' })], history: 'remember me' });
    await waitFor(() => (env.bridge.instanceOpen as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    expect(env.daemonCalls.filter((call) => call.op === 'snapshot.get')).toHaveLength(0);
    env.emitDaemon({
      envId: ENV,
      seq: 1,
      at: 1,
      ev: { kind: 'turn.user', sessionId: 'ses_orch', entry: { kind: 'user', text: 'early', author: 'user', ts: 1 } },
    });
    expect(env.ui.chat.textContent).not.toContain('early');
    expect(env.ui.chat.textContent).not.toContain('remember me');
    env.emitInstance({ kind: 'upsert', instance: instance({ current: true, attach: 'attached' }) });
    await waitFor(() => env.ui.chat.textContent?.includes('remember me') === true && env.ui.chat.textContent?.includes('early') === true);
  });

  it('shows a snapshot failure and retries on the next attach', async () => {
    const env = mount({ instances: [instance({ current: true, attach: 'connecting' })], history: 'remember me', failSnapshots: 1 });
    await waitFor(() => (env.bridge.instanceOpen as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    env.emitInstance({ kind: 'upsert', instance: instance({ current: true, attach: 'attached' }) });
    await waitFor(() => env.ui.error.textContent === 'snapshot failed');
    expect(env.ui.chat.textContent).not.toContain('remember me');
    env.emitInstance({ kind: 'upsert', instance: instance({ current: true, attach: 'reconnecting' }) });
    env.emitInstance({ kind: 'upsert', instance: instance({ current: true, attach: 'attached' }) });
    await waitFor(() => env.ui.chat.textContent?.includes('remember me') === true);
  });

  it('shows an open failure for the environment that was clicked', async () => {
    const { ui, bridge } = mount();
    await waitFor(() => ui.list.querySelector('button') !== null);
    (bridge.instanceOpen as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('relay down'));
    (ui.list.querySelector('button') as HTMLButtonElement).click();
    await waitFor(() => ui.error.textContent === 'relay down');
  });
});
