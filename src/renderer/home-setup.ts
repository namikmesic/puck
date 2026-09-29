/**
 * The Puck home panel, shared by first-run step 3 and Settings → GitHub.
 * The Puck home is the one repository of agent and environment
 * definitions; Git is the only way to change them, so nothing here edits a
 * definition.
 *
 *  - Connected: the home's name, "Open on GitHub" and "Change".
 *  - Change (or no home yet): two paths.
 *    Connect picks an existing home; main checks it on selection, and a
 *    repository without `agents/` or `environments/` at its root is refused
 *    with its reason and "Initialize a new home instead".
 *    Initialize picks an empty repository (or creates one on GitHub first,
 *    through GitHub's new-repository page with the name and visibility
 *    filled in) and the repository the first environment works on; main
 *    commits the starter home and refuses a repository that has files.
 *
 * Every repository picker lists each repository once, fetches the list
 * again each time the panel is shown, and has a Refresh button, so a
 * repository created after the app started appears. The panel keeps its
 * state across a host's redraws: the host re-appends `root`. Context in,
 * controller out; no DOM lookups.
 */

import type { GithubInstallation, GithubRepo, ProviderInfo, PuckBridge } from '../harness/bridge';
import { el } from './dom';
import { button, buildSeg, errText } from './util';

/** GitHub's new-repository page with the name and private visibility filled in. */
export const NEW_HOME_URL = 'https://github.com/new?name=puck-home&visibility=private';

/** The example Puck home: the starter files Initialize commits. */
export const EXAMPLE_HOME_URL = 'https://github.com/namikmesic/puck/tree/main/docs/examples/config-repo';

const enc = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/** The home on GitHub. */
export const homeUrl = (repo: string): string => `https://github.com/${repo}`;
/** One file of the home on a branch ("Edit on GitHub"). */
export const homeFileUrl = (repo: string, branch: string, path: string): string =>
  `https://github.com/${repo}/blob/${enc(branch)}/${enc(path)}`;
/** One folder of the home on a branch. */
export const homeFolderUrl = (repo: string, branch: string, path: string): string =>
  `https://github.com/${repo}/tree/${enc(branch)}/${enc(path)}`;

/** Each repository once (names compare without case), by name, with `extra` added when missing. */
export function uniqueRepos(repos: readonly GithubRepo[], extra?: string | null): string[] {
  const byKey = new Map<string, string>();
  for (const name of [...repos.map((r) => r.fullName), ...(extra ? [extra] : [])]) {
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

export type HomeMode = 'connect' | 'initialize';

export interface HomeSetupContext {
  bridge: PuckBridge;
  /** The connected home (`owner/name`), null when none is. */
  current(): string | null;
  /** A home was connected or initialized: the new provider list. */
  connected(infos: ProviderInfo[]): void;
}

export function initHomeSetup(ctx: HomeSetupContext) {
  const { bridge } = ctx;
  const root = el('div', 'home-panel');
  let repos: GithubRepo[] | null = null;
  let reposError = '';
  let installs: GithubInstallation[] = [];
  let fetches = 0;
  let changing = false;
  let mode: HomeMode = 'connect';
  let connectPick = '';
  let initPick = '';
  let envPick = '';
  let busy = false;
  let error = '';
  /** Connect refused the pick: its reason, and whether Initialize fits it. */
  let refusal: { repo: string; message: string; empty: boolean } | null = null;

  async function loadRepos(): Promise<void> {
    const mine = ++fetches;
    reposError = '';
    render();
    const [list, inst] = await Promise.all([
      bridge.githubRepos().then(
        (r) => r,
        (err: unknown) => {
          if (mine === fetches) reposError = errText(err);
          return null;
        },
      ),
      // Initialize names the installations that reach only selected repositories.
      mode === 'initialize' ? bridge.githubInstallations().catch(() => [] as GithubInstallation[]) : Promise.resolve(installs),
    ]);
    if (mine !== fetches) return;
    repos = list ?? repos;
    installs = inst;
    render();
  }

  function repoSelect(label: string, value: string, placeholder: string, onPick: (v: string) => void, extra?: string | null): HTMLSelectElement {
    const select = el('select', 'home-repo');
    select.setAttribute('aria-label', label);
    const blank = el(
      'option',
      '',
      repos === null ? (reposError ? 'Repositories unavailable' : 'Loading repositories…') : repos.length || extra ? placeholder : 'No repositories reachable',
    );
    blank.value = '';
    select.appendChild(blank);
    for (const name of uniqueRepos(repos ?? [], extra)) {
      const o = el('option', '', name);
      o.value = name;
      select.appendChild(o);
    }
    select.value = value;
    select.disabled = busy;
    select.addEventListener('change', () => onPick(select.value));
    return select;
  }

  function refreshButton(): HTMLButtonElement {
    const again = button('btn-ghost home-refresh', repos === null && !reposError ? 'Loading…' : 'Refresh');
    again.setAttribute('aria-label', 'Refresh the repository list');
    again.disabled = busy;
    again.addEventListener('click', () => void loadRepos());
    return again;
  }

  function field(label: string, control: HTMLElement, withRefresh: boolean): HTMLElement {
    const box = el('div', 'home-field');
    box.appendChild(el('span', 'home-label', label));
    const row = el('div', 'home-row');
    row.appendChild(control);
    if (withRefresh) row.appendChild(refreshButton());
    box.appendChild(row);
    return box;
  }

  async function connect(name: string): Promise<void> {
    connectPick = name;
    refusal = null;
    error = '';
    if (!name) return render();
    busy = true;
    render();
    try {
      const result = await bridge.githubConnectHome(name);
      if (result.connected) {
        changing = false;
        connectPick = '';
        busy = false;
        ctx.connected(result.providers);
      } else refusal = { repo: name, message: result.message, empty: result.state === 'empty' };
    } catch (err) {
      error = errText(err);
    }
    busy = false;
    render();
  }

  async function initialize(): Promise<void> {
    if (!initPick || !envPick) return;
    busy = true;
    error = '';
    render();
    try {
      const infos = await bridge.githubInitHome(initPick, envPick);
      changing = false;
      initPick = '';
      envPick = '';
      busy = false;
      ctx.connected(infos);
    } catch (err) {
      error = errText(err);
    }
    busy = false;
    render();
  }

  function renderConnect(box: HTMLElement): void {
    box.appendChild(el('p', 'home-note', 'Pick the repository that holds your definitions: agents/ and environments/ at its root.'));
    box.appendChild(field('Puck home', repoSelect('Puck home', connectPick, 'Choose a repository…', (v) => void connect(v)), true));
    if (busy) box.appendChild(el('p', 'home-note', 'Checking the repository…'));
    if (refusal) {
      const r = refusal;
      box.appendChild(el('p', 'home-refusal', r.message));
      const init = button('btn-ghost home-offer-init', 'Initialize a new home instead');
      init.addEventListener('click', () => {
        mode = 'initialize';
        if (r.empty) initPick = r.repo;
        refusal = null;
        void loadRepos();
      });
      box.appendChild(init);
    }
  }

  function renderInitialize(box: HTMLElement): void {
    box.appendChild(
      el(
        'p',
        'home-note',
        'Puck commits a starter home into an empty repository as one commit: three agents and their prompts, one environment, the JSON schema, a validation workflow and a README. It tags the commit v1.0.0. Puck never writes to a repository that already has files.',
      ),
    );
    const create = el('div', 'home-create');
    const go = button('btn-ghost home-new', 'Create a repository on GitHub');
    go.addEventListener('click', () => void bridge.openExternal(NEW_HOME_URL));
    create.appendChild(go);
    create.appendChild(el('span', 'home-hint', 'Leave "Add a README" off, so the repository stays empty. Then refresh the list.'));
    box.appendChild(create);
    const selected = installs.filter((i) => i.repositorySelection !== 'all');
    if (selected.length) {
      const note = el('div', 'home-installs');
      note.appendChild(el('span', 'home-hint', 'Puck reaches only the repositories you selected for it. Add a new repository there:'));
      for (const inst of selected) {
        const manage = button('btn-ghost home-manage', `Manage ${inst.account}`);
        manage.addEventListener('click', () => void bridge.openExternal(inst.manageUrl));
        note.appendChild(manage);
      }
      box.appendChild(note);
    }
    box.appendChild(
      field(
        'Empty repository for the home',
        repoSelect('Empty repository for the home', initPick, 'Choose a repository…', (v) => {
          initPick = v;
          error = '';
          render();
        }),
        true,
      ),
    );
    box.appendChild(
      field(
        'Repository your first environment works on',
        repoSelect('Repository your first environment works on', envPick, 'Choose a repository…', (v) => {
          envPick = v;
          error = '';
          render();
        }),
        false,
      ),
    );
    const run = button('btn-primary home-init', busy ? 'Initializing…' : 'Initialize the Puck home');
    run.disabled = busy || !initPick || !envPick;
    run.addEventListener('click', () => void initialize());
    box.appendChild(run);
  }

  function render(): void {
    root.textContent = '';
    const current = ctx.current();
    if (current && !changing) {
      const row = el('div', 'home-current');
      const name = el('span', 'home-current-name');
      name.append('Your Puck home is ', el('code', '', current), '.');
      row.appendChild(name);
      const open = button('btn-ghost home-open', 'Open on GitHub');
      open.addEventListener('click', () => void bridge.openExternal(homeUrl(current)));
      const change = button('btn-ghost home-change', 'Change');
      change.addEventListener('click', () => {
        changing = true;
        render();
        void loadRepos();
      });
      row.append(open, change);
      root.appendChild(row);
      root.appendChild(el('p', 'home-note', 'Definitions change only through Git: commit to the Puck home, and Puck reads the new version.'));
      return;
    }
    const seg = el('div', 'seg home-modes');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Connect or initialize');
    buildSeg(
      seg,
      [
        { value: 'connect', label: 'Connect an existing home' },
        { value: 'initialize', label: 'Initialize a new home' },
      ],
      mode,
      (v) => {
        mode = v as HomeMode;
        error = '';
        if (mode === 'initialize') void loadRepos();
        else render();
      },
    );
    root.appendChild(seg);
    const box = el('div', `home-path home-${mode}`);
    if (mode === 'connect') renderConnect(box);
    else renderInitialize(box);
    root.appendChild(box);
    if (reposError) root.appendChild(el('p', 'home-error', reposError));
    if (error) root.appendChild(el('p', 'home-error', error));
    if (current) {
      const cancel = button('btn-ghost home-cancel', `Keep ${current}`);
      cancel.disabled = busy;
      cancel.addEventListener('click', () => {
        changing = false;
        refusal = null;
        error = '';
        render();
      });
      root.appendChild(cancel);
    }
  }

  return {
    root,
    /** The panel came into view: draw it and fetch the repositories again. */
    show(): Promise<void> {
      render();
      if (ctx.current() && !changing) return Promise.resolve();
      return loadRepos();
    },
    /** Redraw from the host's facts (the connected home may have changed). */
    render,
    mode: (): HomeMode => mode,
  };
}

export type HomeSetup = ReturnType<typeof initHomeSetup>;
