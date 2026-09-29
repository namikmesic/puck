/**
 * The top bar: the environment switcher, its status, and what needs the
 * user's attention.
 *
 * - The current environment's name opens the switcher menu (see
 *   instance-menu.ts).
 * - The status chip: the runner, a lifecycle dot, and the pin with its
 *   short SHA; while the app or the daemon works on the environment it
 *   shows the stage and the elapsed time. Hover shows the details.
 * - Chips: "Update available" (the apply dialog, with the changes grouped
 *   by how they apply), a GitHub warning when the environment's GitHub
 *   access is not ok, a reconnecting spinner, and the daemon upgrading.
 * - The banner above the chat says when the environment cannot be reached
 *   ("Can't reach build-box. Work continues there; Puck keeps trying."),
 *   is incompatible, or is not connected, with Reconnect where it helps.
 *
 * Context in, controller out; no DOM lookups.
 */

import type { InstanceUpdate, PuckBridge } from '../harness/bridge';
import type { DefinitionChange, UpdateClass } from '../harness/definitions/types';
import { el } from './dom';
import type { InstanceStore } from './instance-store';
import type { AttachView } from './instance-sync';
import { renderInstanceMenu } from './instance-menu';
import { pinText, progressLine, statusWord, toneOf } from './instance-progress';
import { button, errText } from './util';

export interface TopbarElements {
  env: HTMLButtonElement;
  envName: HTMLElement;
  menu: HTMLElement;
  status: HTMLElement;
  chips: HTMLElement;
  banner: HTMLElement;
  /** The apply dialog's host (a small modal). */
  dialog: HTMLElement;
}

export interface TopbarContext {
  els: TopbarElements;
  bridge: PuckBridge;
  store: InstanceStore;
  attach(): AttachView;
  open(envId: string): void;
  reconnect(): void;
  startFlow(): void;
  say(text: string): void;
  now?(): number;
}

const CLASS_TITLE: Record<UpdateClass, string> = {
  hot: 'Applies now, interrupting nothing',
  reprovision: 'Runs provisioning again (installs, repositories)',
  rebuild: 'Rebuilds the container (work is kept)',
};

export function initTopbar(ctx: TopbarContext) {
  const { els, bridge, store } = ctx;
  const now = ctx.now ?? Date.now;
  let update: { envId: string; info: InstanceUpdate } | null = null;
  let checking: string | null = null;
  let menuOpen = false;

  function current() {
    const id = store.envId();
    return id ? store.instance(id) : undefined;
  }

  function closeMenu(): boolean {
    if (!menuOpen) return false;
    menuOpen = false;
    els.menu.classList.add('hidden');
    els.env.setAttribute('aria-expanded', 'false');
    return true;
  }

  function openMenu(): void {
    menuOpen = true;
    renderInstanceMenu(els.menu, {
      bridge,
      instances: store.instances(),
      currentId: store.envId(),
      open: ctx.open,
      start: ctx.startFlow,
      say: ctx.say,
      close: closeMenu,
    });
    els.menu.classList.remove('hidden');
    els.env.setAttribute('aria-expanded', 'true');
    els.menu.querySelector<HTMLButtonElement>('button')?.focus();
  }

  els.env.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (menuOpen) closeMenu();
    else openMenu();
  });

  function closeDialog(): boolean {
    if (els.dialog.classList.contains('hidden')) return false;
    els.dialog.classList.add('hidden');
    els.dialog.textContent = '';
    return true;
  }

  function showDialog(): void {
    const u = update;
    if (!u) return;
    els.dialog.textContent = '';
    const box = el('div', 'tb-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Update the environment');
    box.appendChild(el('h3', 'tb-dialog-title', `Update to ${pinText(u.info.pin)}`));
    const total = u.info.changes.hot.length + u.info.changes.reprovision.length + u.info.changes.rebuild.length;
    if (!total) box.appendChild(el('p', 'tb-dialog-note', 'The definition did not change; only the pin moves.'));
    for (const cls of ['hot', 'reprovision', 'rebuild'] as const) {
      const changes: DefinitionChange[] = u.info.changes[cls];
      if (!changes.length) continue;
      const group = el('section', `tb-dialog-group ${cls}`);
      group.appendChild(el('h4', '', CLASS_TITLE[cls]));
      const list = el('ul', '');
      for (const c of changes) {
        const li = el('li', '', c.summary);
        li.title = c.field;
        list.appendChild(li);
      }
      group.appendChild(list);
      box.appendChild(group);
    }
    const foot = el('div', 'tb-dialog-foot');
    const cancel = button('btn-ghost', 'Cancel');
    cancel.addEventListener('click', closeDialog);
    const apply = button('btn-primary', u.info.changes.rebuild.length ? 'Rebuild and update' : 'Apply');
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      cancel.disabled = true;
      const { pin } = u.info;
      try {
        await bridge.instanceApplyUpdate(u.envId, { kind: pin.kind, name: pin.kind === 'commit' ? pin.sha : pin.name });
        if (update === u) update = null;
        closeDialog();
        ctx.say('');
        render();
      } catch (err) {
        apply.disabled = false;
        cancel.disabled = false;
        ctx.say(errText(err));
      }
    });
    foot.append(cancel, apply);
    box.appendChild(foot);
    els.dialog.appendChild(box);
    els.dialog.classList.remove('hidden');
    apply.focus();
  }

  function chip(cls: string, text: string, title = ''): HTMLElement {
    const c = el('span', `tb-chip ${cls}`, text);
    if (title) c.title = title;
    return c;
  }

  function renderStatus(): void {
    const info = current();
    const live = store.state();
    els.status.textContent = '';
    els.env.disabled = false;
    if (!info) {
      els.envName.textContent = store.instances().length ? 'Choose an environment' : 'No environment';
      els.status.classList.add('hidden');
      return;
    }
    els.envName.textContent = info.name || info.id;
    els.status.classList.remove('hidden');
    const daemon = live?.instance ?? null;
    const tone = toneOf(info, daemon);
    const line = progressLine(info, now(), daemon);
    els.status.append(el('span', 'tb-where', info.runnerName), el('span', `tb-dot tone-${tone}`), el('span', 'tb-word', line || statusWord(info, daemon)));
    const pin = pinText(live?.instance.pin ?? null);
    if (pin && !line) els.status.appendChild(el('span', 'tb-pin', pin));
    els.status.title = [
      `${info.name} on ${info.runnerName}`,
      `Status: ${statusWord(info, daemon)}`,
      live?.instance.detail ? `Detail: ${live.instance.detail}` : '',
      live?.instance.error ? `Error: ${live.instance.error}` : '',
      pin ? `Definition: ${pin}` : '',
      live ? `Daemon ${live.daemon.version} (${live.daemon.build})` : '',
      info.attachDetail ? `Connection: ${info.attachDetail}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  function renderChips(): void {
    els.chips.textContent = '';
    const info = current();
    const live = store.state();
    if (!info) return;
    if (info.attach === 'reconnecting' || info.attach === 'connecting') {
      const c = chip('reconnecting', info.attach === 'connecting' ? 'Connecting' : 'Reconnecting');
      c.prepend(el('span', 'tb-spinner'));
      els.chips.appendChild(c);
    }
    if (update && update.envId === info.id) {
      const b = button('tb-chip update', 'Update available');
      b.title = `${pinText(update.info.pin)} is available`;
      b.addEventListener('click', showDialog);
      els.chips.appendChild(b);
    }
    if (live && live.github.state !== 'ok') {
      const text = live.github.state === 'expiring' ? 'GitHub access expiring' : live.github.state === 'revoked' ? 'GitHub access revoked' : 'No GitHub access';
      els.chips.appendChild(chip('github bad', text, 'The runner keeps GitHub tokens coming from the Puck server; check that the runner is online and Puck is installed on the repositories.'));
    }
    if (live?.upgrading) els.chips.appendChild(chip('upgrading', 'Daemon updating', live.upgrading === 'drain' ? 'Updating once running turns finish' : 'Updating now'));
  }

  function renderBanner(): void {
    const view = ctx.attach();
    els.banner.textContent = '';
    const show = view.phase === 'unreachable' || view.phase === 'incompatible' || view.phase === 'detached' || view.phase === 'lost';
    els.banner.classList.toggle('hidden', !show);
    if (!show) return;
    els.banner.dataset.phase = view.phase;
    els.banner.appendChild(el('span', 'tb-banner-text', view.text));
    if (view.retry) {
      const again = button('btn-ghost', 'Reconnect');
      again.addEventListener('click', () => ctx.reconnect());
      els.banner.appendChild(again);
    }
  }

  function render(): void {
    renderStatus();
    renderChips();
    renderBanner();
    if (menuOpen) openMenu();
  }

  return {
    render,
    closeMenu,
    closeDialog,
    /** Ask main whether the environment on screen has a newer definition. */
    async checkUpdate(): Promise<void> {
      const envId = store.envId();
      if (!envId || checking === envId) return;
      checking = envId;
      try {
        const info = await bridge.instanceCheckUpdate(envId);
        if (store.envId() !== envId) return;
        update = info ? { envId, info } : null;
        renderChips();
      } catch {
        // Not reachable right now (GitHub, the config repo): try again later.
      } finally {
        if (checking === envId) checking = null;
      }
    },
    /** The ticker: move the elapsed time. */
    tick(): void {
      renderStatus();
    },
    menuOpen: (): boolean => menuOpen,
  };
}

export type Topbar = ReturnType<typeof initTopbar>;
