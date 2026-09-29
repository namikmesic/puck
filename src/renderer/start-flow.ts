/**
 * The start flow (a modal): start an environment from a definition in the
 * Puck home on one of the user's runners.
 *
 * 1. Definition: the Puck home version (tags newest first with the highest
 *    semver tag preselected, branches, or a pasted commit SHA) and the
 *    environment definitions at that version, each with its description,
 *    agents and validation state. Invalid ones list their errors with
 *    file:line and "Open in GitHub", and cannot be picked. Every definition
 *    and agent offers "Edit on GitHub" on the home's default branch: Git is
 *    the only way to change a definition. A version without definitions says
 *    where they must live, links that folder and the example Puck home, and
 *    offers a different home.
 * 2. Where: the runners, This Mac first, with status, Docker version,
 *    capacity and labels; labels filter the list. Offline runners, full
 *    ones, and ones too small for the definition cannot be picked.
 * 3. Access: every harness the definition's agents use shows as connected
 *    or offers Connect (the sign-in runs in the browser); one password
 *    field per secret the definition names.
 * 4. Start: main checks everything again first (preflight), then the
 *    progress shows the runner's stages and the daemon's provisioning with
 *    the elapsed time. The window switches to the new environment at once;
 *    the dialog closes itself when it is ready.
 *
 * Each step opens once the one before it is complete; a closed step says
 * what it waits for. Context in, controller out; no DOM lookups.
 */

import type {
  DefinitionListing,
  DefinitionRefs,
  HarnessProviderInfo,
  InstanceInfo,
  IntegrationProviderInfo,
  PinSpec,
  PuckBridge,
  RunnerRow,
  RunnersState,
} from '../harness/bridge';
import type { EnvironmentSummary, ListedError } from '../harness/definitions/types';
import { placement } from '../harness/placement';
import { el } from './dom';
import { EXAMPLE_HOME_URL, homeFileUrl, homeFolderUrl } from './home-setup';
import type { InstanceStore } from './instance-store';
import { progressLine, statusWord, toneOf } from './instance-progress';
import { platformText, runnerMeta } from './settings/runners';
import { button, errText } from './util';

export interface StartFlowContext {
  body: HTMLElement;
  bridge: PuckBridge;
  store: InstanceStore;
  runners(): RunnersState | null;
  /** The window should show the new environment. */
  opened(envId: string): void;
  /** Close the modal. */
  close(): void;
  /** Settings → Runners (no runner to pick yet). */
  openRunners(): void;
  /** Settings → Providers (choose a different Puck home). */
  openProviders(): void;
  /** Poll cadence while a harness sign-in is pending (tests shorten it). */
  pollMs?: number;
  now?(): number;
}

const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Runners in picking order: This Mac first, then by name. */
export function orderRunners(runners: readonly RunnerRow[]): RunnerRow[] {
  return [...runners].sort((a, b) => Number(b.local) - Number(a.local) || a.name.localeCompare(b.name));
}

/** The errors that make a definition unstartable: its own file's and its agents'. */
export function errorsFor(env: EnvironmentSummary, listing: DefinitionListing): ListedError[] {
  const files = new Set([env.path, ...listing.agents.filter((a) => env.agents.includes(a.name) || a.name === env.orchestrator).map((a) => a.path)]);
  return listing.errors.filter((e) => files.has(e.file));
}

/** The harness ids a definition's agents (and orchestrator) run on. */
export function harnessesFor(env: EnvironmentSummary, listing: DefinitionListing): string[] {
  const names = new Set([...env.agents, ...(env.orchestrator ? [env.orchestrator] : [])]);
  return [...new Set(listing.agents.filter((a) => names.has(a.name) && a.harness).map((a) => a.harness as string))].sort();
}

export function initStartFlow(ctx: StartFlowContext) {
  const { bridge, store } = ctx;
  const now = ctx.now ?? Date.now;
  let refs: DefinitionRefs | null = null;
  let refsError = '';
  let pinValue = '';
  let commit = '';
  let listing: DefinitionListing | null = null;
  let listingError = '';
  let listingToken = 0;
  let loading = false;
  let definition: string | null = null;
  let runnerId: string | null = null;
  const labels = new Set<string>();
  let harnesses: HarnessProviderInfo[] = [];
  const secrets = new Map<string, string>();
  let poll: ReturnType<typeof setInterval> | null = null;
  let starting = false;
  let startError = '';
  let startedId: string | null = null;
  let isOpen = false;
  let seenConfigRepo: string | null | undefined;

  function selectedPin(): PinSpec | null {
    if (pinValue === 'commit') return SHA_RE.test(commit.trim()) ? { kind: 'commit', name: commit.trim().toLowerCase() } : null;
    const split = pinValue.indexOf(':');
    if (split < 1) return null;
    const kind = pinValue.slice(0, split);
    if (kind !== 'tag' && kind !== 'branch') return null;
    return { kind, name: pinValue.slice(split + 1) };
  }

  function pinListed(next: DefinitionRefs, value: string): boolean {
    if (value === 'commit') return true;
    const split = value.indexOf(':');
    if (split < 1) return false;
    const kind = value.slice(0, split);
    const name = value.slice(split + 1);
    if (kind === 'tag') return next.tags.some((t) => t.name === name);
    if (kind === 'branch') return next.branches.some((b) => b.name === name);
    return false;
  }

  function env(): EnvironmentSummary | null {
    return listing?.environments.find((e) => e.name === definition) ?? null;
  }

  function runnerRows(): RunnerRow[] {
    return orderRunners(ctx.runners()?.runners ?? []);
  }

  function hosted(r: RunnerRow): number {
    return r.environments.filter((e) => e.status === 'active').length;
  }

  function fit(r: RunnerRow) {
    const e = env();
    return placement(
      { name: r.name, status: r.status, docker: r.docker, maxEnvironments: r.maxEnvironments, keyChanged: r.keyChanged },
      hosted(r),
      e?.resources ?? { cpus: null, memory: null },
    );
  }

  function neededHarnesses(): { id: string; info: HarnessProviderInfo | undefined }[] {
    const e = env();
    if (!e || !listing) return [];
    return harnessesFor(e, listing).map((id) => ({ id, info: harnesses.find((h) => h.id === id) }));
  }

  function missing(): string | null {
    const e = env();
    if (!e) return 'Pick an environment definition.';
    const r = runnerRows().find((x) => x.id === runnerId);
    if (!r) return 'Pick a runner.';
    if (!fit(r).ok) return fit(r).reason;
    const off = neededHarnesses().find((h) => !h.info?.auth.connected);
    if (off) return `Connect ${off.info?.label ?? off.id}.`;
    const empty = e.secrets.find((s) => !(secrets.get(s) ?? '').length);
    if (empty) return `Enter a value for ${empty}.`;
    return null;
  }

  async function loadListing(): Promise<void> {
    const pin = selectedPin();
    const mine = ++listingToken;
    listing = null;
    listingError = '';
    if (!pin) {
      loading = false;
      render();
      return;
    }
    loading = true;
    render();
    try {
      const next = await bridge.definitionsAt(pin);
      if (mine !== listingToken) return;
      listing = next;
      if (!next.environments.some((e) => e.name === definition && e.startable)) {
        const startable = next.environments.filter((e) => e.startable);
        const nextName = startable.length === 1 ? (startable[0]?.name ?? null) : null;
        if (nextName !== definition) runnerId = null;
        definition = nextName;
      }
    } catch (err) {
      if (mine !== listingToken) return;
      listingError = errText(err);
    } finally {
      if (mine === listingToken) {
        loading = false;
        render();
      }
    }
  }

  async function loadHarnesses(): Promise<string | null | undefined> {
    try {
      const infos = await bridge.providers();
      harnesses = infos.filter((p): p is HarnessProviderInfo => p.kind === 'harness');
      const github = infos.find((p): p is IntegrationProviderInfo => p.kind === 'integration' && p.id === 'github');
      return github?.github.configRepo ?? null;
    } catch {
      harnesses = [];
      return undefined;
    }
  }

  function stopPolling(): void {
    if (poll) clearInterval(poll);
    poll = null;
  }

  function pollSignIn(): void {
    stopPolling();
    poll = setInterval(async () => {
      await loadHarnesses();
      if (!harnesses.some((h) => h.auth.pending)) stopPolling();
      render();
    }, ctx.pollMs ?? 2000);
  }

  function section(n: number, title: string, enabled: boolean, waiting = ''): HTMLElement {
    const box = el('section', `sf-step${enabled ? '' : ' disabled'}`);
    box.dataset.step = String(n);
    box.appendChild(el('h3', 'sf-step-title', `${n}. ${title}`));
    if (!enabled && waiting) box.appendChild(el('p', 'sf-note sf-step-why', waiting));
    return box;
  }

  /** The version the listing was read at, as the user picked it. */
  function versionText(l: DefinitionListing): string {
    return l.pin.kind === 'commit' ? l.pin.name.slice(0, 7) : l.pin.name;
  }

  /** Where "Edit on GitHub" points: the home's default branch (GitHub's HEAD until the refs are in). */
  function homeBranch(): string {
    return refs?.defaultBranch ?? 'HEAD';
  }

  /** No environment definitions at this version: where they go, and how Git adds them. */
  function renderEmpty(box: HTMLElement, l: DefinitionListing): void {
    const empty = el('div', 'sf-empty');
    const head = el('p', 'sf-empty-head');
    head.append('No environment definitions in the Puck home ', el('code', '', l.repo), ' at ', el('code', '', versionText(l)), '.');
    const where = el('p', 'sf-note');
    where.append(
      'An environment definition names the image, repositories and agents of an environment; an agent definition names a harness, model and instructions. Environments are added by committing ',
      el('code', '', 'environments/<name>.yaml'),
      ' to the Puck home. Agents are added by committing ',
      el('code', '', 'agents/<name>.yaml'),
      ', both at the root of the Puck home. Tag a release once it is in, or pick the branch above.',
    );
    const actions = el('div', 'sf-empty-actions');
    const folder = button('btn-ghost sf-open-envs', 'Open environments/ on GitHub');
    folder.addEventListener('click', () => void bridge.openExternal(homeFolderUrl(l.repo, homeBranch(), 'environments')));
    const example = button('btn-ghost sf-example', 'Open the example Puck home');
    example.addEventListener('click', () => void bridge.openExternal(EXAMPLE_HOME_URL));
    const repo = button('btn-ghost sf-change-repo', 'Choose a different Puck home');
    repo.addEventListener('click', () => ctx.openProviders());
    actions.append(folder, example, repo);
    empty.append(head, where, actions);
    box.appendChild(empty);
  }

  function renderDefinition(host: HTMLElement): void {
    const box = section(1, 'Definition', true);
    if (refsError) box.appendChild(el('p', 'sf-error', refsError));
    const field = el('div', 'sf-field');
    const label = el('label', 'sf-label-text', 'Version');
    label.htmlFor = 'sf-ref';
    field.append(label, el('span', 'sf-hint', 'A branch, tag, or commit of the Puck home.'));
    box.appendChild(field);
    const row = el('div', 'sf-row');
    const select = el('select', 'sf-ref');
    select.id = 'sf-ref';
    const add = (value: string, label: string, group: HTMLElement): void => {
      const o = el('option', '', label);
      o.value = value;
      group.appendChild(o);
    };
    if (refs) {
      if (refs.tags.length) {
        const g = el('optgroup', '');
        g.label = 'Tags';
        for (const t of refs.tags) add(`tag:${t.name}`, t.name, g);
        select.appendChild(g);
      }
      if (refs.branches.length) {
        const g = el('optgroup', '');
        g.label = 'Branches';
        for (const b of refs.branches) add(`branch:${b.name}`, b.name, g);
        select.appendChild(g);
      }
    } else if (!refsError) add('', 'Loading refs…', select);
    add('commit', 'A commit SHA…', select);
    select.value = pinValue;
    select.addEventListener('change', () => {
      pinValue = select.value;
      void loadListing();
    });
    row.appendChild(select);
    if (pinValue === 'commit') {
      const sha = el('input', 'sf-sha');
      sha.placeholder = 'Commit SHA';
      sha.setAttribute('aria-label', 'Commit SHA');
      sha.value = commit;
      sha.addEventListener('change', () => {
        commit = sha.value;
        void loadListing();
      });
      row.appendChild(sha);
    }
    box.appendChild(row);

    if (loading) box.appendChild(el('p', 'sf-note', 'Reading definitions…'));
    if (listingError) box.appendChild(el('p', 'sf-error', listingError));
    if (listing) {
      const repo = listing.repo;
      const branch = homeBranch();
      if (!listing.environments.length) {
        renderEmpty(box, listing);
        host.appendChild(box);
        return;
      }
      const defsLabel = el('div', 'sf-field sf-field-defs');
      defsLabel.appendChild(el('span', 'sf-label-text', 'Environment definition'));
      box.appendChild(defsLabel);
      const list = el('div', 'sf-defs');
      list.setAttribute('role', 'radiogroup');
      list.setAttribute('aria-label', 'Environment definition');
      for (const e of listing.environments) {
        const card = el('label', `sf-def${e.startable ? '' : ' invalid'}${e.name === definition ? ' selected' : ''}`);
        card.dataset.definition = e.name;
        const radio = el('input', '');
        radio.type = 'radio';
        radio.name = 'sf-definition';
        radio.value = e.name;
        radio.checked = e.name === definition;
        radio.disabled = !e.startable;
        radio.addEventListener('change', () => {
          definition = e.name;
          runnerId = null;
          render();
        });
        const text = el('div', 'sf-def-text');
        text.appendChild(el('span', 'sf-def-name', e.name));
        if (e.description) text.appendChild(el('span', 'sf-def-desc', e.description));
        const names = [...(e.orchestrator ? [e.orchestrator] : []), ...e.agents.filter((a) => a !== e.orchestrator)];
        if (names.length) {
          const agents = el('span', 'sf-def-agents');
          names.forEach((name, i) => {
            if (i) agents.append(' · ');
            if (name === e.orchestrator) agents.append('orchestrator ');
            const file = listing?.agents.find((a) => a.name === name)?.path;
            if (!file) {
              agents.append(name);
              return;
            }
            const link = button('sf-agent-link', name);
            link.title = `Edit ${file} on GitHub`;
            link.addEventListener('click', (ev) => {
              ev.preventDefault();
              void bridge.openExternal(homeFileUrl(repo, branch, file));
            });
            agents.appendChild(link);
          });
          text.appendChild(agents);
        }
        const edit = button('btn-ghost sf-def-edit', 'Edit on GitHub');
        edit.title = `Edit ${e.path} on GitHub`;
        edit.addEventListener('click', (ev) => {
          ev.preventDefault();
          void bridge.openExternal(homeFileUrl(repo, branch, e.path));
        });
        text.appendChild(edit);
        const errors = errorsFor(e, listing);
        if (!e.startable) {
          const ul = el('ul', 'sf-def-errors');
          if (!errors.length) ul.appendChild(el('li', '', 'An agent it names is not valid.'));
          for (const err of errors) {
            const li = el('li', '');
            li.appendChild(el('span', 'sf-err-where', `${err.file}:${err.line}`));
            li.appendChild(el('span', 'sf-err-msg', err.message));
            const gh = button('btn-ghost sf-err-open', 'Open in GitHub');
            gh.addEventListener('click', (ev) => {
              ev.preventDefault();
              void bridge.openExternal(err.url);
            });
            li.appendChild(gh);
            ul.appendChild(li);
          }
          text.appendChild(ul);
        }
        card.append(radio, text);
        list.appendChild(card);
      }
      box.appendChild(list);
    }
    host.appendChild(box);
  }

  /** Why the steps after Definition are still closed. */
  function waitingForDefinition(): string {
    if (refsError) return 'Opens once the Puck home can be read.';
    if (listingError) return 'The chosen version could not be read.';
    if (refs && !selectedPin()) return 'Opens once you pick a version.';
    if (!listing) return 'Opens once the definitions are read.';
    if (!listing.environments.length) return 'Opens once the Puck home has an environment definition.';
    if (!listing.environments.some((x) => x.startable)) return 'Opens once a definition is valid.';
    return 'Opens once you pick an environment definition.';
  }

  function renderWhere(host: HTMLElement): void {
    const e = env();
    const box = section(2, 'Where', !!e, waitingForDefinition());
    host.appendChild(box);
    if (!e) return;
    const rows = runnerRows();
    const state = ctx.runners();
    if (!rows.length) {
      box.appendChild(el('p', 'sf-note', state?.signedIn === false ? 'Sign in to Puck to use your runners.' : 'No runners yet. Set up This Mac, or add a machine.'));
      const go = button('btn-ghost', 'Set up a runner');
      go.addEventListener('click', () => ctx.openRunners());
      box.appendChild(go);
      return;
    }
    const all = [...new Set(rows.flatMap((r) => r.labels))].sort();
    if (all.length) {
      const chips = el('div', 'sf-labels');
      for (const label of all) {
        const chip = button(`sf-label${labels.has(label) ? ' on' : ''}`, label);
        chip.setAttribute('aria-pressed', String(labels.has(label)));
        chip.addEventListener('click', () => {
          if (labels.has(label)) labels.delete(label);
          else labels.add(label);
          render();
        });
        chips.appendChild(chip);
      }
      box.appendChild(chips);
    }
    const list = el('div', 'sf-runners');
    for (const r of rows) {
      if ([...labels].some((l) => !r.labels.includes(l))) continue;
      const f = fit(r);
      const card = el('label', `sf-runner${f.ok ? '' : ' blocked'}${r.id === runnerId ? ' selected' : ''}`);
      card.dataset.runner = r.id;
      const radio = el('input', '');
      radio.type = 'radio';
      radio.name = 'sf-runner';
      radio.value = r.id;
      radio.checked = r.id === runnerId;
      radio.disabled = !f.ok;
      radio.addEventListener('change', () => {
        runnerId = r.id;
        render();
      });
      const text = el('div', 'sf-runner-text');
      const head = el('div', 'sf-runner-head');
      head.append(el('span', `tb-dot ${r.status === 'offline' ? 'tone-off' : 'tone-on'}`), el('span', 'sf-runner-name', r.name));
      const cap = r.maxEnvironments === null ? `${hosted(r)} hosted` : `${hosted(r)}/${r.maxEnvironments} hosted`;
      head.appendChild(el('span', 'sf-runner-cap', r.status === 'offline' ? 'offline' : cap));
      text.appendChild(head);
      text.appendChild(el('span', 'sf-runner-meta', r.docker ? runnerMeta(r) : platformText(r)));
      if (!f.ok && f.reason) text.appendChild(el('span', 'sf-runner-why', f.reason));
      card.append(radio, text);
      list.appendChild(card);
    }
    if (!list.children.length) list.appendChild(el('p', 'sf-note', 'No runner has all of those labels.'));
    box.appendChild(list);
  }

  function renderAccess(host: HTMLElement): void {
    const e = env();
    const ready = !!e && !!runnerId;
    const box = section(3, 'Access', ready, e ? 'Opens once you pick a runner.' : waitingForDefinition());
    host.appendChild(box);
    if (!e || !ready) return;
    const list = el('div', 'sf-harnesses');
    for (const h of neededHarnesses()) {
      const row = el('div', 'sf-harness');
      row.dataset.harness = h.id;
      const connected = !!h.info?.auth.connected;
      row.append(el('span', `tb-dot ${connected ? 'tone-on' : 'tone-off'}`), el('span', 'sf-harness-name', h.info?.label ?? h.id));
      if (connected) row.appendChild(el('span', 'sf-harness-state', 'connected'));
      else if (h.info?.auth.pending) {
        row.appendChild(el('span', 'sf-harness-state', 'waiting for the sign-in in your browser…'));
        const cancel = button('btn-ghost', 'Cancel');
        cancel.addEventListener('click', async () => {
          await bridge.providerAuthCancel(h.id).catch(() => undefined);
          await loadHarnesses();
          render();
        });
        row.appendChild(cancel);
      } else {
        const connect = button('btn-ghost', 'Connect');
        connect.addEventListener('click', async () => {
          connect.disabled = true;
          try {
            await bridge.providerAuthStart(h.id);
            await loadHarnesses();
            pollSignIn();
          } catch (err) {
            startError = errText(err);
          }
          render();
        });
        row.appendChild(connect);
      }
      list.appendChild(row);
    }
    box.appendChild(list);
    if (e.secrets.length) {
      const form = el('div', 'sf-secrets');
      form.appendChild(el('p', 'sf-note', 'Secrets go to the environment encrypted and are never written to the definition or the logs.'));
      for (const name of e.secrets) {
        const label = el('label', 'sf-secret', name);
        const input = el('input', '');
        input.type = 'password';
        input.name = name;
        input.autocomplete = 'off';
        input.value = secrets.get(name) ?? '';
        input.addEventListener('input', () => {
          secrets.set(name, input.value);
          renderFoot();
        });
        label.appendChild(input);
        form.appendChild(label);
      }
      box.appendChild(form);
    }
  }

  let foot: HTMLElement | null = null;

  function renderFoot(): void {
    if (!foot) return;
    foot.textContent = '';
    if (startedId || starting) {
      const info = startedId ? store.instance(startedId) : pendingInstance();
      const line = el('div', 'sf-progress');
      line.setAttribute('aria-live', 'polite');
      if (info) {
        line.append(el('span', `tb-dot tone-${toneOf(info)}`), el('span', 'sf-progress-line', progressLine(info, now()) || statusWord(info)));
        if (info.op?.detail) line.appendChild(el('span', 'sf-progress-detail', info.op.detail));
        else if (info.daemon?.detail) line.appendChild(el('span', 'sf-progress-detail', info.daemon.detail));
      } else line.appendChild(el('span', 'sf-progress-line', 'Checking everything…'));
      foot.appendChild(line);
      if (startError) foot.appendChild(el('p', 'sf-error', startError));
      const close = button('btn-ghost', startedId ? 'Close — keep starting' : 'Close');
      close.addEventListener('click', () => ctx.close());
      foot.appendChild(close);
      return;
    }
    const why = missing();
    if (startError) foot.appendChild(el('p', 'sf-error', startError));
    else if (why && env()) foot.appendChild(el('p', 'sf-note sf-why', why));
    const start = button('btn-primary sf-start', 'Start');
    start.disabled = !!why;
    start.addEventListener('click', () => void begin());
    foot.appendChild(start);
  }

  function pendingInstance(): InstanceInfo | undefined {
    return store.instances().find((i) => i.op?.kind === 'starting' && i.name === definition && !i.op.error);
  }

  async function begin(): Promise<void> {
    const pin = selectedPin();
    const e = env();
    if (!pin || !e || !runnerId || missing()) return;
    starting = true;
    startError = '';
    render();
    try {
      const values: Record<string, string> = {};
      for (const name of e.secrets) values[name] = secrets.get(name) ?? '';
      const { envId } = await bridge.instanceStart({ pin, definition: e.name, runnerId, secrets: values });
      startedId = envId;
      secrets.clear();
      ctx.opened(envId);
    } catch (err) {
      startError = errText(err);
    } finally {
      starting = false;
      render();
    }
  }

  function render(): void {
    if (!isOpen) return;
    const scroll = ctx.body.scrollTop;
    // A runner heartbeat re-renders the page: keep the field being typed in.
    const active = document.activeElement;
    const typing = active instanceof HTMLInputElement && ctx.body.contains(active) ? { name: active.name, cls: active.className, at: active.selectionStart } : null;
    ctx.body.textContent = '';
    renderDefinition(ctx.body);
    renderWhere(ctx.body);
    renderAccess(ctx.body);
    foot = el('div', 'sf-foot');
    ctx.body.appendChild(foot);
    renderFoot();
    ctx.body.scrollTop = scroll;
    if (typing) {
      const again = [...ctx.body.querySelectorAll('input')].find((i) => i.name === typing.name && i.className === typing.cls);
      again?.focus();
      if (again && typing.at !== null && again.type !== 'radio') again.setSelectionRange(typing.at, typing.at);
    }
  }

  return {
    async open(): Promise<void> {
      isOpen = true;
      startedId = null;
      startError = '';
      listingToken += 1;
      listing = null;
      listingError = '';
      loading = false;
      render();
      const repo = await loadHarnesses();
      if (repo !== undefined && seenConfigRepo !== undefined && repo !== seenConfigRepo) {
        pinValue = '';
        commit = '';
      }
      if (repo !== undefined) seenConfigRepo = repo;
      try {
        refs = await bridge.definitionRefs();
        refsError = '';
        if (!pinListed(refs, pinValue)) {
          pinValue = refs.defaultTag ? `tag:${refs.defaultTag}` : refs.tags[0] ? `tag:${refs.tags[0].name}` : refs.branches[0] ? `branch:${refs.branches[0].name}` : '';
        }
      } catch (err) {
        refsError = errText(err);
      }
      render();
      if (!refsError && pinValue) await loadListing();
    },
    close(): void {
      isOpen = false;
      stopPolling();
      ctx.body.textContent = '';
    },
    isOpen: (): boolean => isOpen,
    /** Instance and runner changes: the progress line and the runner list follow them. */
    changed(): void {
      if (!isOpen) return;
      if (startedId) {
        const info = store.instance(startedId);
        if (info?.daemon?.status === 'ready' && !info.op) {
          startedId = null;
          ctx.close();
          return;
        }
        renderFoot();
        return;
      }
      if (starting) renderFoot();
      else render();
    },
    /** The ticker. */
    tick(): void {
      if (isOpen && (starting || startedId)) renderFoot();
    },
    busy: (): boolean => isOpen && (starting || !!startedId),
  };
}

export type StartFlow = ReturnType<typeof initStartFlow>;
