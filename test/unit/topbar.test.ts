// @vitest-environment jsdom

/**
 * The top bar switches environments, shows the status chip, the update,
 * GitHub and reconnecting chips, and the banner for an environment it
 * cannot reach; the switcher menu offers the environment operations.
 */

import { describe, expect, it, vi } from 'vitest';
import type { InstanceInfo, InstanceUpdate } from '../../src/harness/bridge';
import { createInstanceStore } from '../../src/renderer/instance-store';
import { attachViewOf, type AttachView } from '../../src/renderer/instance-sync';
import { instanceOps } from '../../src/renderer/instance-menu';
import { initTopbar } from '../../src/renderer/topbar';
import { ENV, ENV2, fakeBridge, instance, snap } from './v2-fixtures';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const UPDATE: InstanceUpdate = {
  pin: { kind: 'tag', name: 'v1.1.0', sha: 'b2c3d4e5f6a7' },
  changes: { hot: [{ field: 'agents[implementer].maxParallel', class: 'hot', summary: 'implementer runs up to 3 at once' }], reprovision: [], rebuild: [] },
};

function setup(list: InstanceInfo[] = [instance()], attach?: () => AttachView) {
  document.body.innerHTML = `
    <button id="env"><span id="name"></span></button><div id="menu" class="hidden"></div>
    <div id="status"></div><div id="chips"></div><div id="banner" class="hidden"></div><div id="dialog" class="hidden"></div>`;
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const fake = fakeBridge({
    instanceCheckUpdate: vi.fn(async () => UPDATE),
    instanceApplyUpdate: vi.fn(async () => undefined),
    instanceStop: vi.fn(async () => undefined),
    instanceDelete: vi.fn(async () => undefined),
    instanceForget: vi.fn(async () => undefined),
  });
  const store = createInstanceStore({ requestResync: () => undefined });
  store.setInstances(list);
  store.reset(ENV);
  const open = vi.fn();
  const reconnect = vi.fn();
  const startFlow = vi.fn();
  const say = vi.fn();
  const tb = initTopbar({
    els: { env: byId('env'), envName: byId('name'), menu: byId('menu'), status: byId('status'), chips: byId('chips'), banner: byId('banner'), dialog: byId('dialog') },
    bridge: fake.bridge,
    store,
    attach: attach ?? (() => attachViewOf(store.instance(ENV), store.hasSnapshot())),
    open,
    reconnect,
    startFlow,
    say,
    now: () => 20_000,
  });
  tb.render();
  return { ...fake, store, tb, open, reconnect, startFlow, say, byId };
}

describe('top bar', () => {
  it('shows the environment, its runner, status and pin', () => {
    const { store, tb, byId } = setup();
    store.applySnapshot(snap(), ENV);
    tb.render();
    expect(byId('name').textContent).toBe('example');
    expect(byId('status').querySelector('.tb-where')?.textContent).toBe('build-box');
    expect(byId('status').querySelector('.tb-dot')?.className).toBe('tb-dot tone-on');
    expect(byId('status').querySelector('.tb-pin')?.textContent).toBe('v1.0.0 (a1b2c3d)');
    expect(byId('status').title).toContain('Daemon 0.0.1 (test)');
  });

  it('shows the stage and elapsed time while working', () => {
    const { store, tb, byId } = setup([instance({ op: { kind: 'starting', stage: 'pulling-image', detail: '', startedAt: 8_000, error: null } })]);
    tb.render();
    expect(byId('status').querySelector('.tb-word')?.textContent).toBe('pulling the image · 12s');
    expect(byId('status').querySelector('.tb-pin')).toBeNull();
    void store;
  });

  it('offers an update and applies it from the dialog', async () => {
    const { store, tb, byId, bridge } = setup();
    store.applySnapshot(snap(), ENV);
    await tb.checkUpdate();
    const chip = byId('chips').querySelector<HTMLButtonElement>('.tb-chip.update') as HTMLButtonElement;
    expect(chip.textContent).toBe('Update available');
    chip.click();
    const dialog = byId('dialog');
    expect(dialog.classList.contains('hidden')).toBe(false);
    expect(dialog.querySelector('.tb-dialog-group.hot')?.textContent).toContain('implementer runs up to 3 at once');
    (dialog.querySelector('.btn-primary') as HTMLButtonElement).click();
    await flush();
    expect(bridge.instanceApplyUpdate).toHaveBeenCalledWith(ENV, UPDATE.pin);
    expect(dialog.classList.contains('hidden')).toBe(true);
    expect(byId('chips').querySelector('.tb-chip.update')).toBeNull();
  });

  it('warns about GitHub access and shows reconnecting', () => {
    const { store, tb, byId } = setup([instance({ attach: 'reconnecting' })]);
    store.applySnapshot(snap({ github: { state: 'revoked' } }), ENV);
    tb.render();
    const chips = [...byId('chips').querySelectorAll('.tb-chip')].map((c) => c.textContent);
    expect(chips).toEqual(['Reconnecting', 'GitHub access revoked']);
  });

  it('shows a failed snapshot load with Reconnect', () => {
    const { tb, byId, reconnect } = setup([instance()], () => ({
      phase: 'snapshot-failed',
      text: "Couldn't load the environment: snapshot broke",
      retry: true,
    }));
    tb.render();
    const banner = byId('banner');
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(banner.textContent).toContain('snapshot broke');
    (banner.querySelector('button') as HTMLButtonElement).click();
    expect(reconnect).toHaveBeenCalled();
  });

  it('shows the unreachable banner with Reconnect', () => {
    const { tb, byId, reconnect } = setup([instance({ attach: 'unreachable' })]);
    tb.render();
    const banner = byId('banner');
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(banner.textContent).toContain("Can't reach build-box. Work continues there; Puck keeps trying.");
    (banner.querySelector('button') as HTMLButtonElement).click();
    expect(reconnect).toHaveBeenCalled();
  });

  it('switches environments and runs operations from the menu', async () => {
    const { tb, byId, open, startFlow, bridge } = setup([instance(), instance({ id: ENV2, name: 'docs', current: false, attach: null })]);
    (byId('env') as HTMLButtonElement).click();
    const menu = byId('menu');
    expect(tb.menuOpen()).toBe(true);
    expect([...menu.querySelectorAll('.tb-menu-name')].map((n) => n.textContent)).toEqual(['docs', 'example']);
    (menu.querySelector(`[data-env="${ENV2}"]`) as HTMLButtonElement).click();
    expect(open).toHaveBeenCalledWith(ENV2);
    expect(tb.menuOpen()).toBe(false);
    (byId('env') as HTMLButtonElement).click();
    (byId('menu').querySelector('.tb-menu-start') as HTMLButtonElement).click();
    expect(startFlow).toHaveBeenCalled();
    (byId('env') as HTMLButtonElement).click();
    const del = byId('menu').querySelector('[data-op="delete"]') as HTMLButtonElement;
    del.click();
    expect(bridge.instanceDelete).not.toHaveBeenCalled();
    del.click();
    await flush();
    expect(bridge.instanceDelete).toHaveBeenCalledWith(ENV);
    (byId('env') as HTMLButtonElement).click();
    (byId('menu').querySelector('[data-op="stop"]') as HTMLButtonElement).click();
    await flush();
    expect(bridge.instanceStop).toHaveBeenCalledWith(ENV);
  });

  it('offers the operations an environment allows', () => {
    expect(instanceOps(instance())).toEqual(['stop', 'start', 'rebuild', 'delete']);
    expect(instanceOps(instance({ status: 'lost' }))).toEqual(['forget']);
    expect(instanceOps(instance({ op: { kind: 'stopping', stage: null, detail: '', startedAt: 1, error: null } }))).toEqual([]);
    expect(instanceOps(instance({ op: { kind: 'stopping', stage: null, detail: '', startedAt: 1, error: 'x' } }))).toHaveLength(4);
  });
});

describe('daemon update', () => {
  it('offers drain or now for a daemon older than the app carries', async () => {
    const { store, tb, byId, bridge } = setup([instance({ daemonUpdate: true })]);
    (bridge as unknown as { instanceUpgradeDaemon: unknown }).instanceUpgradeDaemon = vi.fn(async () => undefined);
    store.applySnapshot(snap(), ENV);
    tb.render();
    const chip = byId('chips').querySelector<HTMLButtonElement>('.tb-chip.daemon') as HTMLButtonElement;
    expect(chip.textContent).toBe('Daemon update');
    chip.click();
    (byId('dialog').querySelector('[data-mode="drain"]') as HTMLButtonElement).click();
    await flush();
    expect(bridge.instanceUpgradeDaemon).toHaveBeenCalledWith(ENV, 'drain');
    expect(byId('dialog').classList.contains('hidden')).toBe(true);
    store.applyEvent(11, { kind: 'daemon.upgrading', mode: 'drain' }, ENV);
    tb.render();
    expect([...byId('chips').querySelectorAll('.tb-chip')].map((c) => c.textContent)).toEqual(['Daemon updating']);
  });
});
