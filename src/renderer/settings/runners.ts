/**
 * Settings → Runners: the machines that host the user's environments.
 *
 * - The list: one row per runner, This Mac first: status (Idle, Active ·
 *   n environments, Offline · last seen), platform, Docker version, CPUs,
 *   memory and labels; Details (id, version, key fingerprint, the
 *   environments it hosts, a Docker problem, a changed key); Rename,
 *   Labels, and Remove, which shows the `./config.sh remove --token …`
 *   command, with Force remove for a machine that is gone (armed on first
 *   click). This Mac's Remove uninstalls it.
 * - Add runner, GitHub's self-hosted runner flow: pick This Mac or a
 *   platform, copy the download, checksum, configure and run commands with
 *   a one-hour registration token (Cancel revokes it), and watch the runner
 *   come online with its Docker version and capacity.
 *
 * A controller that survives re-renders: runner events update the list in
 * place without losing an open dialog or a half-typed rename. Context in,
 * elements built here, no DOM lookups.
 */

import type {
  EnvironmentProviderInfo,
  ProviderStatus,
  PuckBridge,
  RunnerAsset,
  RunnerRegistration,
  RunnerRemoval,
  RunnerRow,
  RunnersState,
} from '../../harness/bridge';
import { armDelete, el } from '../dom';
import { relTime } from '../format';
import { button, errText } from '../util';
import { cardShell } from './cards';

const SIGNED_OUT =
  'Sign in to Puck with GitHub on the Providers page to add runners. Runners belong to your Puck account.';

export interface RunnersContext {
  bridge: PuckBridge;
  say(text: string): void;
  copy(text: string): Promise<void>;
  now?(): number;
}

export interface RunnersView {
  /** The card for the Runners provider (the same node across renders). */
  card(info: EnvironmentProviderInfo): HTMLElement;
  /** A pushed runner event or a fresh state: update in place. */
  update(state: RunnersState): void;
  /** Settings closed: stop timers (an open dialog's token stays valid until it expires). */
  close(): void;
}

type Platform = 'this-mac' | 'linux-x64' | 'linux-arm64' | 'macos-arm64';

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: 'this-mac', label: 'This Mac' },
  { id: 'linux-x64', label: 'Linux x64' },
  { id: 'linux-arm64', label: 'Linux ARM64' },
  { id: 'macos-arm64', label: 'macOS ARM64' },
];

const OS_LABEL: Record<string, string> = { linux: 'Linux', macos: 'macOS' };
const ARCH_LABEL: Record<string, string> = { x64: 'x64', arm64: 'ARM64' };

export function platformText(r: { os: string; arch: string }): string {
  return `${OS_LABEL[r.os] ?? r.os} ${ARCH_LABEL[r.arch] ?? r.arch}`;
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** "Linux x64 · Docker 27.3.1 · 16 CPUs · 62.8 GB · gpu" */
export function runnerMeta(r: RunnerRow): string {
  const parts = [platformText(r)];
  if (r.status === 'offline') {
    if (r.lastSeenAt) parts.push(`last seen ${relTime(r.lastSeenAt)}`);
  } else if (r.docker?.version) {
    parts.push(`Docker ${r.docker.version}`);
    if (r.docker.ncpu) parts.push(`${r.docker.ncpu} CPUs`);
    if (r.docker.memTotal) parts.push(gb(r.docker.memTotal));
  }
  const custom = r.labels.filter((l) => l !== r.os && l !== r.arch);
  if (custom.length) parts.push(custom.join(', '));
  return parts.join(' · ');
}

/** Header for a pushed runner list, once that list is known. */
function runnerHeaderStatus(s: RunnersState): ProviderStatus {
  if (!s.signedIn) return { state: 'disconnected', detail: 'Sign in to Puck to use your runners' };
  if (s.connection === 'offline') return { state: 'error', detail: `Can't reach the Puck server at ${s.server}; Puck keeps trying.` };
  const online = s.runners.filter((r) => r.status !== 'offline').length;
  const n = s.runners.length;
  if (n === 0) return { state: 'disconnected', detail: 'No runners yet' };
  return { state: 'connected', detail: `${n} ${n === 1 ? 'runner' : 'runners'}, ${online} online` };
}

/** Idle, Active · 2 environments, Offline. */
export function statusWord(r: RunnerRow): string {
  if (r.status === 'offline') return 'Offline';
  if (r.status === 'active') return `Active · ${r.running} ${r.running === 1 ? 'environment' : 'environments'}`;
  return 'Idle';
}

/** The copy-paste blocks for one platform's tarball. */
export function commandsFor(asset: RunnerAsset, reg: { serverUrl: string; token: string }): { download: string[]; configure: string[]; run: string[] } {
  const mac = asset.os === 'macos';
  return {
    download: [
      'mkdir puck-runner && cd puck-runner',
      `curl -fLo ${asset.file} ${asset.url}`,
      `echo "${asset.sha256}  ${asset.file}" | shasum -a 256 -c`,
      `tar xzf ./${asset.file}`,
    ],
    configure: [`./config.sh --url ${reg.serverUrl} --token ${reg.token}`],
    run: ['./run.sh', mac ? './svc.sh install && ./svc.sh start' : 'sudo ./svc.sh install && sudo ./svc.sh start'],
  };
}

export function initRunnersView(ctx: RunnersContext): RunnersView {
  const now = (): number => (ctx.now ?? Date.now)();
  let state: RunnersState | null = null;
  let info: EnvironmentProviderInfo | null = null;
  const expanded = new Set<string>();
  /** The one row whose inline editor is open. */
  let editing: { runnerId: string; field: 'name' | 'labels' } | null = null;
  const removals = new Map<string, RunnerRemoval>();

  const root = cardShell({ title: 'Runners' });
  root.classList.add('pv-card', 'rn-card');
  root.dataset.provider = 'runner';
  const headStatus = el('span', 'status');
  root.querySelector('.card-head')?.appendChild(headStatus);
  const sub = el('div', 'card-sub');
  const list = el('div', 'rn-list');
  const addPanel = el('div', 'rn-add hidden');
  addPanel.id = 'rn-add';
  const foot = el('div', 'card-foot rn-foot');
  root.append(sub, list, addPanel, foot);

  /* ---------- Add runner ---------- */

  let add: {
    platform: Platform;
    reg: RunnerRegistration | null;
    error: string | null;
    openedAt: number;
    known: Set<string>;
    online: RunnerRow | null;
    timer: ReturnType<typeof setInterval> | null;
  } | null = null;

  function openAdd(platform: Platform = 'linux-x64'): void {
    if (add) return;
    add = {
      platform,
      reg: null,
      error: null,
      openedAt: now(),
      known: new Set((state?.runners ?? []).map((r) => r.id)),
      online: null,
      timer: setInterval(() => drawAdd(), 30_000),
    };
    drawAdd();
    void fetchToken();
  }

  async function fetchToken(): Promise<void> {
    if (!add) return;
    const mine = add;
    mine.error = null;
    drawAdd();
    try {
      mine.reg = await ctx.bridge.runnerRegistrationToken();
    } catch (err) {
      mine.error = errText(err);
    }
    if (add === mine) drawAdd();
  }

  function closeAdd(): void {
    const was = add;
    add = null;
    if (was?.timer) clearInterval(was.timer);
    addPanel.classList.add('hidden');
    addPanel.textContent = '';
    drawFoot();
  }

  function codeBlock(title: string, lines: string[]): HTMLElement {
    const box = el('div', 'rn-block');
    const head = el('div', 'rn-block-head');
    head.appendChild(el('span', 'pv-subhead', title));
    const copy = button('btn-ghost', 'Copy');
    copy.addEventListener('click', async () => {
      try {
        await ctx.copy(lines.join('\n'));
        copy.textContent = 'Copied ✓';
        setTimeout(() => (copy.textContent = 'Copy'), 1600);
      } catch (err) {
        ctx.say(errText(err));
      }
    });
    head.appendChild(copy);
    box.appendChild(head);
    box.appendChild(el('pre', 'pv-code', lines.map((l) => `$ ${l}`).join('\n')));
    return box;
  }

  function thisMacBlock(): HTMLElement {
    const box = el('div', 'rn-this-mac');
    const local = state?.local;
    if (!local?.supported) {
      box.appendChild(el('p', 'pv-note', 'The one-click runner needs macOS on Apple silicon. Pick a platform above and run the commands on this Mac instead.'));
      return box;
    }
    if (local.installed) {
      box.appendChild(el('p', 'pv-note', 'This Mac is already a runner.'));
      return box;
    }
    box.appendChild(
      el('p', 'pv-note', 'Puck installs its runner on this Mac as a LaunchAgent and registers it. Environments then run in Docker Desktop, colima or OrbStack here, and keep running when Puck is closed.'),
    );
    if (local.busy) box.appendChild(el('div', 'rn-waiting', `◌ ${local.detail}`));
    if (local.error) box.appendChild(el('div', 'pv-health-msg', local.error));
    const go = button('btn-primary', 'Set up This Mac');
    go.disabled = !!local.busy;
    go.addEventListener('click', () => void installLocal(go));
    const f = el('div', 'card-foot');
    f.appendChild(go);
    box.appendChild(f);
    return box;
  }

  function drawAdd(): void {
    if (!add) return;
    addPanel.classList.remove('hidden');
    addPanel.textContent = '';
    addPanel.appendChild(el('div', 'pv-subhead', 'Add a runner'));
    addPanel.appendChild(el('p', 'pv-note', 'A runner is a machine that hosts Puck environments. It connects out to Puck; Puck never connects in.'));
    const picker = el('div', 'seg rn-os');
    picker.id = 'rn-add-os';
    picker.setAttribute('role', 'radiogroup');
    for (const p of PLATFORMS) {
      const b = button('seg-btn', p.label);
      b.dataset.platform = p.id;
      b.setAttribute('aria-pressed', String(p.id === add.platform));
      b.addEventListener('click', () => {
        if (!add) return;
        add.platform = p.id;
        drawAdd();
      });
      picker.appendChild(b);
    }
    addPanel.appendChild(picker);

    if (add.platform === 'this-mac') {
      addPanel.appendChild(thisMacBlock());
    } else {
      const host = new URL(add.reg?.serverUrl || state?.server || 'http://puck').host;
      addPanel.appendChild(
        el('p', 'pv-note', `Needs: Docker Engine 24 or newer that the runner's user can use without sudo, and outbound HTTPS to ${host}. Membership in the docker group is equivalent to root on that machine; a dedicated user is safer.`),
      );
      const commands = el('div', 'rn-commands');
      commands.id = 'rn-add-commands';
      if (add.error) {
        commands.appendChild(el('div', 'pv-health-msg', add.error));
        const retry = button('btn-ghost', 'Try again');
        retry.addEventListener('click', () => void fetchToken());
        commands.appendChild(retry);
      } else if (!add.reg) {
        commands.appendChild(el('div', 'cards-loading', 'Getting a registration token…'));
      } else {
        const [os, arch] = add.platform.split('-');
        const asset = add.reg.assets.find((a) => a.os === os && a.arch === arch);
        if (!asset) {
          commands.appendChild(el('div', 'pv-health-msg', `The Puck server publishes no runner for ${platformText({ os, arch })} yet.`));
        } else {
          const c = commandsFor(asset, add.reg);
          commands.appendChild(codeBlock('Download', c.download));
          commands.appendChild(codeBlock('Configure', c.configure));
          const left = add.reg.expiresAt - now();
          if (left > 0) {
            commands.appendChild(el('div', 'rn-expiry', `The token expires in ${Math.max(1, Math.round(left / 60_000))} min and can register several runners until then.`));
          } else {
            const again = button('btn-ghost', 'The token expired — get a new one');
            again.addEventListener('click', () => void fetchToken());
            commands.appendChild(again);
          }
          commands.appendChild(codeBlock('Run', c.run));
          commands.appendChild(el('p', 'pv-note', asset.os === 'macos' ? 'Run it in a terminal, or as a LaunchAgent (no sudo).' : 'Run it in a terminal, or as a systemd service.'));
        }
      }
      addPanel.appendChild(commands);
    }

    const status = el('div', add.online ? 'rn-online' : 'rn-waiting');
    status.id = 'rn-add-status';
    status.textContent = add.online
      ? `✓ ${add.online.name} is online · ${runnerMeta(add.online)}`
      : add.platform === 'this-mac'
        ? ''
        : '◌ Waiting for a runner to register…';
    addPanel.appendChild(status);
    const f = el('div', 'card-foot');
    const done = button(add.online ? 'btn-primary' : 'btn-ghost', add.online ? 'Done' : 'Cancel');
    done.addEventListener('click', () => {
      const was = add;
      if (was?.reg && !was.online) void ctx.bridge.runnerRegistrationCancel(was.reg.id).catch(() => undefined);
      closeAdd();
    });
    f.appendChild(done);
    addPanel.appendChild(f);
  }

  /** A runner that was not there when the dialog opened is online now. */
  function watchNew(): void {
    if (!add || add.online || !state) return;
    const fresh = state.runners.find((r) => !add?.known.has(r.id) && r.status !== 'offline' && !r.local);
    if (fresh) {
      add.online = fresh;
      drawAdd();
    }
  }

  async function installLocal(btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    ctx.say('');
    try {
      view.update(await ctx.bridge.runnerInstallLocal());
      if (add?.platform === 'this-mac') closeAdd();
    } catch (err) {
      ctx.say(errText(err));
      btn.disabled = false;
      const next = await ctx.bridge.runners().catch(() => null);
      if (next) view.update(next);
    }
  }

  /* ---------- Rows ---------- */

  function details(r: RunnerRow): HTMLElement {
    const box = el('dl', 'facts rn-details');
    const fact = (k: string, v: string): void => void box.append(el('dt', '', k), el('dd', '', v));
    fact('Runner id', r.id);
    fact('Runner version', r.version || '—');
    fact('Key', r.fingerprint || '—');
    fact('Most environments', r.maxEnvironments === null ? 'no limit' : String(r.maxEnvironments));
    fact(
      'Environments',
      r.environments.length ? r.environments.map((e) => `${e.definition || e.envId}${e.status === 'active' ? '' : ` (${e.status})`}`).join(', ') : 'none',
    );
    if (r.docker && !r.docker.ok) fact('Docker problem', r.docker.problem ?? 'unknown');
    return box;
  }

  function inlineEditor(r: RunnerRow, field: 'name' | 'labels', draft: ReadonlyMap<string, string>): HTMLElement {
    const form = el('form', 'rn-edit config-form');
    const input = el('input', '');
    const key = `${field}:${r.id}`;
    input.dataset.keep = key;
    input.setAttribute('aria-label', field === 'name' ? 'Runner name' : 'Labels, comma-separated');
    const saved = field === 'name' ? r.name : r.labels.filter((l) => l !== r.os && l !== r.arch).join(', ');
    const kept = draft.get(key);
    input.value = kept !== undefined ? kept : saved;
    input.spellcheck = false;
    const save = el('button', 'btn-primary', 'Save');
    save.type = 'submit';
    const cancel = button('btn-ghost', 'Cancel');
    cancel.addEventListener('click', () => {
      editing = null;
      drawList();
    });
    form.append(input, save, cancel);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      ctx.say('');
      const patch = field === 'name' ? { name: input.value.trim() } : { labels: input.value.split(',').map((l) => l.trim()).filter(Boolean) };
      try {
        const next = await ctx.bridge.runnerUpdate(r.id, patch);
        editing = null;
        view.update(next);
      } catch (err) {
        ctx.say(errText(err));
        save.disabled = false;
      }
    });
    setTimeout(() => input.focus(), 0);
    return form;
  }

  function removalBlock(r: RunnerRow, removal: RunnerRemoval): HTMLElement {
    const box = el('div', 'rn-removal');
    box.appendChild(codeBlock(`Run this in the runner's folder on ${r.name}`, [removal.command]));
    box.appendChild(
      el('p', 'pv-note', 'It asks whether to keep or delete the environments on that machine, uninstalls the service, and deregisters the runner. The token expires in an hour.'),
    );
    return box;
  }

  function rowEl(r: RunnerRow, draft: ReadonlyMap<string, string>): HTMLElement {
    const row = el('div', `rn-row rn-${r.status}`);
    row.dataset.runner = r.id;
    const head = el('div', 'rn-row-head');
    const dot = el('span', `rn-dot ${r.status === 'offline' ? '' : 'on'}`);
    head.appendChild(dot);
    head.appendChild(el('span', 'rn-name', r.name));
    if (r.local) head.appendChild(el('span', 'card-tag', 'This Mac'));
    head.appendChild(el('span', 'rn-status', statusWord(r)));
    row.appendChild(head);
    row.appendChild(el('div', 'card-sub rn-meta', runnerMeta(r)));
    if (r.keyChanged) {
      row.appendChild(el('div', 'pv-health-msg', 'The Puck server lists a different key for this runner than Puck first saw. Channels to it are refused; remove it and register it again if you did not.'));
    } else if (r.docker && !r.docker.ok && r.status !== 'offline') {
      row.appendChild(el('div', 'pv-health-msg', `Docker problem on this runner: ${r.docker.problem ?? 'unknown'}.`));
    }
    if (r.status === 'offline' && r.lastSeenAt && now() - r.lastSeenAt > 14 * 86_400_000) {
      row.appendChild(el('div', 'pv-note', 'Offline for more than two weeks. Remove it if the machine is gone.'));
    }
    if (expanded.has(r.id)) row.appendChild(details(r));
    if (editing?.runnerId === r.id) row.appendChild(inlineEditor(r, editing.field, draft));
    const removal = removals.get(r.id);
    if (removal) row.appendChild(removalBlock(r, removal));

    const actions = el('div', 'card-foot rn-actions');
    const more = button('btn-ghost', expanded.has(r.id) ? 'Hide details' : 'Details');
    more.addEventListener('click', () => {
      if (expanded.has(r.id)) expanded.delete(r.id);
      else expanded.add(r.id);
      drawList();
    });
    actions.appendChild(more);
    for (const field of ['name', 'labels'] as const) {
      const b = button('btn-ghost', field === 'name' ? 'Rename' : 'Labels');
      b.addEventListener('click', () => {
        editing = { runnerId: r.id, field };
        drawList();
      });
      actions.appendChild(b);
    }
    if (r.local) {
      const remove = button('btn-ghost danger', 'Remove');
      armDelete(remove, async () => {
        remove.disabled = true;
        ctx.say('');
        try {
          view.update(await ctx.bridge.runnerUninstallLocal());
        } catch (err) {
          ctx.say(errText(err));
          remove.disabled = false;
        }
      });
      actions.appendChild(remove);
    } else if (r.status !== 'offline' && !removal) {
      const remove = button('btn-ghost', 'Remove');
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        ctx.say('');
        try {
          removals.set(r.id, await ctx.bridge.runnerRemovalToken(r.id));
        } catch (err) {
          ctx.say(errText(err));
        }
        drawList();
      });
      actions.appendChild(remove);
    }
    if (!r.local && (r.status === 'offline' || removal)) {
      const force = button('btn-ghost danger', 'Force remove');
      force.title = 'For a machine that is gone: Puck forgets the runner; its environments read as lost.';
      armDelete(force, async () => {
        force.disabled = true;
        ctx.say('');
        try {
          removals.delete(r.id);
          view.update(await ctx.bridge.runnerForceRemove(r.id));
        } catch (err) {
          ctx.say(errText(err));
          force.disabled = false;
        }
      });
      actions.appendChild(force);
    }
    row.appendChild(actions);
    return row;
  }

  function drawList(): void {
    const draft = new Map<string, string>();
    let focused: string | null = null;
    for (const input of list.querySelectorAll<HTMLInputElement>('input[data-keep]')) {
      const key = input.dataset.keep;
      if (!key) continue;
      draft.set(key, input.value);
      if (input === document.activeElement) focused = key;
    }
    list.textContent = '';
    if (!state) return;
    if (!state.signedIn) {
      list.appendChild(el('p', 'pv-note', SIGNED_OUT));
      return;
    }
    if (state.connection === 'offline') {
      list.appendChild(el('div', 'pv-health-msg', `Can't reach the Puck server at ${state.server}. Runners keep working; Puck keeps trying.`));
    }
    if (!state.runners.length) {
      list.appendChild(el('p', 'pv-note', 'Set up This Mac, or add a Linux machine with Add runner.'));
    }
    for (const r of state.runners) list.appendChild(rowEl(r, draft));
    const local = state.local;
    if (local.busy || (local.error && !add)) {
      list.appendChild(el('div', local.busy ? 'rn-waiting' : 'pv-health-msg', local.busy ? `◌ This Mac: ${local.detail}` : `This Mac: ${local.error}`));
    }
    if (!focused) return;
    for (const input of list.querySelectorAll<HTMLInputElement>('input[data-keep]')) {
      if (input.dataset.keep === focused && input.isConnected) input.focus();
    }
  }

  function drawFoot(): void {
    foot.textContent = '';
    if (!state?.signedIn || add) return;
    const addBtn = button('btn-primary', 'Add runner');
    addBtn.id = 'rn-add-open';
    addBtn.addEventListener('click', () => openAdd());
    foot.appendChild(addBtn);
    if (state.local.supported && !state.local.installed) {
      const mac = button('btn-ghost', state.local.busy ? 'Setting up This Mac…' : 'Set up This Mac');
      mac.disabled = !!state.local.busy;
      mac.addEventListener('click', () => void installLocal(mac));
      foot.appendChild(mac);
    }
  }

  function drawHead(): void {
    const s = info?.status;
    headStatus.className = `status${s?.state === 'connected' ? ' on' : ''}`;
    headStatus.textContent = '';
    headStatus.appendChild(el('span', 'dot'));
    headStatus.appendChild(document.createTextNode(s?.state === 'connected' ? 'connected' : s?.state === 'error' ? 'offline' : 'not set up'));
    sub.textContent = s?.detail ?? '';
  }

  function redraw(): void {
    for (const id of [...removals.keys()]) if (state && !state.runners.some((r) => r.id === id)) removals.delete(id);
    drawHead();
    drawList();
    drawFoot();
    watchNew();
    if (add && add.platform === 'this-mac') drawAdd();
  }

  const view: RunnersView = {
    card(next) {
      info = next;
      state = next.runners;
      redraw();
      return root;
    },
    update(next) {
      state = next;
      if (info) info = { ...info, runners: next, status: runnerHeaderStatus(next) };
      redraw();
    },
    close() {
      if (add) closeAdd();
      editing = null;
      removals.clear();
    },
  };
  return view;
}
