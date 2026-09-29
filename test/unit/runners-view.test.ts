// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { EnvironmentProviderInfo, PuckBridge, RunnerRegistration, RunnersState } from '../../src/harness/bridge';
import { commandsFor, initRunnersView, runnerMeta, statusWord } from '../../src/renderer/settings/runners';
import { LOCAL_ID, RID, runnerRow, runnersInfo, runnersState } from './runners-fixtures';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

const NOW = 1_800_000_000_000;

const registration = (over: Partial<RunnerRegistration> = {}): RunnerRegistration => ({
  id: 'reg_01J8Z3X0000000000000000000',
  token: 'PRT_abcdefghijklmnopqrstuvwxyz',
  expiresAt: NOW + 59 * 60_000,
  serverUrl: 'https://puck.example.com',
  version: '0.1.0',
  assets: [
    { os: 'linux', arch: 'x64', version: '0.1.0', file: 'puck-runner-linux-x64-0.1.0.tar.gz', url: 'https://puck.example.com/runner/0.1.0/puck-runner-linux-x64-0.1.0.tar.gz', sha256: 'a'.repeat(64), size: 1 },
    { os: 'macos', arch: 'arm64', version: '0.1.0', file: 'puck-runner-macos-arm64-0.1.0.tar.gz', url: 'https://puck.example.com/runner/0.1.0/puck-runner-macos-arm64-0.1.0.tar.gz', sha256: 'b'.repeat(64), size: 1 },
  ],
  ...over,
});

function mount(state: RunnersState = runnersState(), over: Partial<PuckBridge> = {}, status?: EnvironmentProviderInfo['status']) {
  const bridge = {
    runners: vi.fn(async () => state),
    runnerRegistrationToken: vi.fn(async () => registration()),
    runnerRegistrationCancel: vi.fn(async () => undefined),
    runnerRemovalToken: vi.fn(async () => ({ id: 'reg_x', token: 'PRR_x', expiresAt: NOW + 3_600_000, command: './config.sh remove --token PRR_x' })),
    runnerForceRemove: vi.fn(async () => runnersState({ runners: [] })),
    runnerUpdate: vi.fn(async () => state),
    runnerInstallLocal: vi.fn(async () => state),
    runnerUninstallLocal: vi.fn(async () => state),
    ...over,
  } as unknown as PuckBridge;
  const say = vi.fn();
  const copy = vi.fn(async () => undefined);
  const view = initRunnersView({ bridge, say, copy, now: () => NOW });
  const card = view.card({ ...runnersInfo(), runners: state, ...(status ? { status } : {}) });
  document.body.textContent = '';
  document.body.appendChild(card);
  return { bridge, say, copy, view, card };
}

const btn = (root: Element, text: string): HTMLButtonElement =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;
const row = (card: HTMLElement, id = RID): HTMLElement => card.querySelector(`[data-runner="${id}"]`) as HTMLElement;

describe('runner rows', () => {
  it('say Idle, Active or Offline with the platform, Docker version and capacity', () => {
    expect(statusWord(runnerRow())).toBe('Idle');
    expect(statusWord(runnerRow({ status: 'active', running: 2 }))).toBe('Active · 2 environments');
    expect(statusWord(runnerRow({ status: 'active', running: 1 }))).toBe('Active · 1 environment');
    expect(statusWord(runnerRow({ status: 'offline' }))).toBe('Offline');
    expect(runnerMeta(runnerRow())).toBe('Linux x64 · Docker 27.3.1 · 16 CPUs · 62.8 GB · gpu');
    expect(runnerMeta(runnerRow({ status: 'offline', lastSeenAt: Date.now() - 3 * 86_400_000 }))).toMatch(/^Linux x64 · last seen /);
  });

  it('list This Mac first with its tag, and show details on demand', async () => {
    const mac = runnerRow({ id: LOCAL_ID, name: 'This Mac (mbp)', os: 'macos', arch: 'arm64', labels: ['macos', 'arm64', 'local'], local: true });
    const { card } = mount(runnersState({ runners: [mac, runnerRow({ environments: [{ envId: 'env_1', definition: 'example', status: 'active' }] })] }));
    const names = [...card.querySelectorAll('.rn-name')].map((n) => n.textContent);
    expect(names).toEqual(['This Mac (mbp)', 'build-box']);
    expect(row(card, LOCAL_ID).textContent).toContain('This Mac');
    btn(row(card), 'Details').click();
    const facts = row(card).querySelector('.rn-details') as HTMLElement;
    expect(facts.textContent).toContain(RID);
    expect(facts.textContent).toContain('SHA256:q1w2e3');
    expect(facts.textContent).toContain('example');
  });

  it('warn about a changed key and a Docker problem', () => {
    const { card } = mount(runnersState({ runners: [runnerRow({ keyChanged: true }), runnerRow({ id: LOCAL_ID, name: 'b', docker: { ok: false, version: null, problem: 'daemon-down', ncpu: null, memTotal: null } })] }));
    expect(row(card).textContent).toMatch(/different key/);
    expect(row(card, LOCAL_ID).textContent).toMatch(/Docker problem on this runner: daemon-down/);
  });

  it('rename and relabel through the Puck server', async () => {
    const { card, bridge } = mount();
    btn(row(card), 'Rename').click();
    const input = row(card).querySelector('form.rn-edit input') as HTMLInputElement;
    expect(input.value).toBe('build-box');
    input.value = ' big-box ';
    (row(card).querySelector('form.rn-edit') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(bridge.runnerUpdate).toHaveBeenCalledWith(RID, { name: 'big-box' });

    btn(row(card), 'Labels').click();
    const labels = row(card).querySelector('form.rn-edit input') as HTMLInputElement;
    expect(labels.value).toBe('gpu');
    labels.value = 'gpu, fast';
    (row(card).querySelector('form.rn-edit') as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(bridge.runnerUpdate).toHaveBeenCalledWith(RID, { labels: ['gpu', 'fast'] });
  });

  it('Remove shows the config.sh remove command, with an armed Force remove', async () => {
    const { card, bridge, copy } = mount();
    btn(row(card), 'Remove').click();
    await settle();
    expect(bridge.runnerRemovalToken).toHaveBeenCalledWith(RID);
    expect(row(card).querySelector('.rn-removal .pv-code')?.textContent).toBe('$ ./config.sh remove --token PRR_x');
    btn(row(card).querySelector('.rn-removal') as Element, 'Copy').click();
    await settle();
    expect(copy).toHaveBeenCalledWith('./config.sh remove --token PRR_x');
    const force = btn(row(card), 'Force remove');
    force.click();
    expect(bridge.runnerForceRemove).not.toHaveBeenCalled();
    force.click();
    await settle();
    expect(bridge.runnerForceRemove).toHaveBeenCalledWith(RID);
  });

  it('an offline runner offers Force remove; This Mac offers an armed uninstall', async () => {
    const mac = runnerRow({ id: LOCAL_ID, name: 'This Mac', local: true });
    const { card, bridge } = mount(runnersState({ runners: [mac, runnerRow({ status: 'offline' })] }));
    expect(btn(row(card), 'Remove')).toBeUndefined();
    expect(btn(row(card), 'Force remove')).toBeTruthy();
    const remove = btn(row(card, LOCAL_ID), 'Remove');
    remove.click();
    remove.click();
    await settle();
    expect(bridge.runnerUninstallLocal).toHaveBeenCalled();
    expect(btn(row(card, LOCAL_ID), 'Force remove')).toBeUndefined();
  });

  it('signed out: a note and no Add runner', () => {
    const { card } = mount(runnersState({ signedIn: false, runners: [] }));
    expect(card.textContent).toMatch(/Sign in to Puck with GitHub/);
    expect(btn(card, 'Add runner')).toBeUndefined();
  });

  it('refreshes the card header when a runner appears after an empty list', () => {
    const { card, view } = mount(runnersState({ runners: [] }), {}, { state: 'disconnected', detail: 'No runners yet' });
    expect(card.querySelector('.card-head .status')?.textContent).toBe('not set up');
    expect(card.querySelector('.card-sub')?.textContent).toBe('No runners yet');

    view.update(runnersState({ runners: [runnerRow()] }));
    expect(card.querySelector('.rn-name')?.textContent).toBe('build-box');
    expect(card.querySelector('.card-head .status')?.textContent).toBe('connected');
    expect(card.querySelector('.card-head .status')?.classList.contains('on')).toBe(true);
    expect(card.querySelector('.card-sub')?.textContent).toBe('1 runner, 1 online');

    view.update(runnersState({ runners: [] }));
    expect(card.querySelector('.rn-name')).toBeNull();
    expect(card.querySelector('.card-head .status')?.textContent).toBe('not set up');
    expect(card.querySelector('.card-sub')?.textContent).toBe('No runners yet');
  });
});

describe('Add runner', () => {
  it('builds GitHub-style download, checksum, configure and run commands', () => {
    const reg = registration();
    const linux = commandsFor(reg.assets[0], reg);
    expect(linux.download).toEqual([
      'mkdir puck-runner && cd puck-runner',
      'curl -fLo puck-runner-linux-x64-0.1.0.tar.gz https://puck.example.com/runner/0.1.0/puck-runner-linux-x64-0.1.0.tar.gz',
      `echo "${'a'.repeat(64)}  puck-runner-linux-x64-0.1.0.tar.gz" | shasum -a 256 -c`,
      'tar xzf ./puck-runner-linux-x64-0.1.0.tar.gz',
    ]);
    expect(linux.configure).toEqual(['./config.sh --url https://puck.example.com --token PRT_abcdefghijklmnopqrstuvwxyz']);
    expect(linux.run).toEqual(['./run.sh', 'sudo ./svc.sh install && sudo ./svc.sh start']);
    expect(commandsFor(reg.assets[1], reg).run[1]).toBe('./svc.sh install && ./svc.sh start');
  });

  it('shows the commands for the picked platform with the token expiry, then the runner coming online', async () => {
    const { card, bridge, view, copy } = mount();
    btn(card, 'Add runner').click();
    await settle();
    expect(bridge.runnerRegistrationToken).toHaveBeenCalledTimes(1);
    const panel = card.querySelector('#rn-add') as HTMLElement;
    expect(panel.classList.contains('hidden')).toBe(false);
    const codes = [...panel.querySelectorAll('.pv-code')].map((c) => c.textContent);
    expect(codes[0]).toContain('curl -fLo puck-runner-linux-x64-0.1.0.tar.gz');
    expect(codes[1]).toBe('$ ./config.sh --url https://puck.example.com --token PRT_abcdefghijklmnopqrstuvwxyz');
    expect(panel.textContent).toContain('expires in 59 min');
    expect(panel.querySelector('#rn-add-status')?.textContent).toBe('◌ Waiting for a runner to register…');
    btn(panel.querySelector('.rn-block') as Element, 'Copy').click();
    await settle();
    expect((copy.mock.calls[0] as unknown as string[])[0]).toMatch(/^mkdir puck-runner && cd puck-runner\ncurl /);

    // Linux ARM64 has no published tarball on this server.
    btn(panel, 'Linux ARM64').click();
    expect(card.querySelector('#rn-add-commands')?.textContent).toMatch(/publishes no runner for Linux ARM64/);
    btn(card.querySelector('#rn-add') as Element, 'macOS ARM64').click();
    expect(card.querySelector('#rn-add-commands')?.textContent).toContain('./svc.sh install && ./svc.sh start');

    // The runner registers and connects: pushed as a new row.
    const fresh = runnerRow({ id: 'rnr_01J8Z3X0000000000000000009', name: 'build-2' });
    view.update(runnersState({ runners: [runnerRow(), fresh] }));
    expect(card.querySelector('#rn-add-status')?.textContent).toBe('✓ build-2 is online · Linux x64 · Docker 27.3.1 · 16 CPUs · 62.8 GB · gpu');
    btn(card.querySelector('#rn-add') as Element, 'Done').click();
    expect(bridge.runnerRegistrationCancel).not.toHaveBeenCalled();
    expect(card.querySelector('#rn-add')?.classList.contains('hidden')).toBe(true);
  });

  it('Cancel revokes the token, and closing Settings leaves it valid', async () => {
    const { card, bridge, view } = mount();
    btn(card, 'Add runner').click();
    await settle();
    btn(card.querySelector('#rn-add') as Element, 'Cancel').click();
    expect(bridge.runnerRegistrationCancel).toHaveBeenCalledWith('reg_01J8Z3X0000000000000000000');
    btn(card, 'Add runner').click();
    await settle();
    view.close();
    expect(bridge.runnerRegistrationCancel).toHaveBeenCalledTimes(1);
    expect(card.querySelector('#rn-add')?.classList.contains('hidden')).toBe(true);
  });

  it('an expired token offers a new one', async () => {
    const { card, bridge } = mount(runnersState(), { runnerRegistrationToken: vi.fn(async () => registration({ expiresAt: NOW - 1 })) });
    btn(card, 'Add runner').click();
    await settle();
    btn(card.querySelector('#rn-add') as Element, 'The token expired — get a new one').click();
    await settle();
    expect(bridge.runnerRegistrationToken).toHaveBeenCalledTimes(2);
  });

  it('This Mac installs the runner in one click', async () => {
    const installed = runnersState({ local: { supported: true, installed: true, runnerId: LOCAL_ID, busy: null, detail: '', error: null } });
    const { card, bridge } = mount(runnersState(), { runnerInstallLocal: vi.fn(async () => installed) });
    btn(card, 'Add runner').click();
    await settle();
    btn(card.querySelector('#rn-add') as Element, 'This Mac').click();
    btn(card.querySelector('#rn-add') as Element, 'Set up This Mac').click();
    await settle();
    expect(bridge.runnerInstallLocal).toHaveBeenCalled();
    expect(bridge.runnerRegistrationCancel).not.toHaveBeenCalled();
    expect(card.querySelector('#rn-add')?.classList.contains('hidden')).toBe(true);
    expect(btn(card, 'Set up This Mac')).toBeUndefined();
  });

  it('shows install progress and failures for This Mac', async () => {
    const { card, say, view } = mount(runnersState(), { runnerInstallLocal: vi.fn(async () => Promise.reject(new Error('Docker is not running'))) });
    btn(card, 'Set up This Mac').click();
    await settle();
    expect(say).toHaveBeenCalledWith('Docker is not running');
    view.update(runnersState({ local: { supported: true, installed: false, runnerId: null, busy: 'installing', detail: 'Downloading runner 0.1.0…', error: null } }));
    expect(card.textContent).toContain('This Mac: Downloading runner 0.1.0…');
    expect(btn(card, 'Setting up This Mac…').disabled).toBe(true);
  });
});
