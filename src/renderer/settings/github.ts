/**
 * Settings → Providers → Integrations → GitHub: signing in to Puck with
 * GitHub. Signed out: "Sign in with GitHub" opens GitHub's sign-in page in
 * the browser, through the Puck server; while it is open, a waiting line
 * and Cancel. Signed in: the login, the app installations with Manage
 * links and "Install Puck on an account", the config-repo picker with
 * "Open repo", and "Sign out of Puck". Tokens never reach this module; main
 * returns the login and settings only. Context in, elements built here, no
 * DOM lookups.
 */

import type {
  GithubInstallation,
  GithubRepo,
  IntegrationProviderInfo,
  ProviderInfo,
  PuckBridge,
} from '../../harness/bridge';
import { el, statusEl } from '../dom';
import { button, errText } from '../util';
import { cardShell } from './cards';

export interface GitHubCardContext {
  bridge: PuckBridge;
  /** Show text on the section's message line ('' clears it). */
  say(text: string): void;
  /** Provider state changed: re-render the section (optionally with the new list). */
  onChange(infos?: ProviderInfo[]): void;
  /** A sign-in started: poll until it settles. */
  onSignInStarted(providerId: string): void;
  copy(text: string): Promise<void>;
}

function installationsBlock(ctx: GitHubCardContext, info: IntegrationProviderInfo): HTMLElement {
  const box = el('div', 'pv-installs');
  box.appendChild(el('div', 'pv-subhead', 'Installations'));
  const list = el('ul', 'pv-list');
  list.appendChild(el('li', 'pv-loading', 'Loading…'));
  box.appendChild(list);
  const installUrl = info.github.installUrl;
  if (installUrl) {
    const install = button('btn-ghost', 'Install Puck on an account');
    install.addEventListener('click', () => void ctx.bridge.openExternal(installUrl));
    const foot = el('div', 'card-foot');
    foot.appendChild(install);
    box.appendChild(foot);
  }

  void ctx.bridge
    .githubInstallations()
    .then((installs: GithubInstallation[]) => {
      list.textContent = '';
      if (!installs.length) {
        list.appendChild(
          el('li', 'pv-note', 'Puck is not installed on any account yet. Install it where your config repo lives.'),
        );
      }
      for (const inst of installs) {
        const row = el('li', 'pv-install');
        row.dataset.installation = String(inst.id);
        row.appendChild(el('span', '', inst.account));
        row.appendChild(el('span', 'card-tag', inst.repositorySelection === 'all' ? 'all repos' : 'selected repos'));
        const manage = button('btn-ghost', 'Manage');
        manage.addEventListener('click', () => void ctx.bridge.openExternal(inst.manageUrl));
        row.appendChild(manage);
        list.appendChild(row);
      }
    })
    .catch((err: unknown) => {
      list.textContent = '';
      list.appendChild(el('li', 'pv-note', errText(err)));
    });
  return box;
}

function configRepoBlock(ctx: GitHubCardContext, info: IntegrationProviderInfo): HTMLElement {
  const box = el('div', 'pv-config-repo config-form');
  box.appendChild(el('div', 'pv-subhead', 'Config repo'));
  const current = info.github.configRepo;
  const select = el('select', '');
  select.setAttribute('aria-label', 'Config repo');
  select.disabled = true;
  const placeholder = el('option', '', current ?? 'Loading repositories…');
  placeholder.value = current ?? '';
  select.appendChild(placeholder);
  const open = button('btn-ghost', 'Open repo');
  open.disabled = !current;
  open.addEventListener('click', () => {
    if (current) void ctx.bridge.openExternal(`https://github.com/${current}`);
  });
  const row = el('div', 'pv-repo-row');
  row.append(select, open);
  box.appendChild(row);
  if (!current) box.appendChild(el('p', 'pv-note', 'Choose the repository that holds your agent and environment definitions.'));

  void ctx.bridge
    .githubRepos()
    .then((repos: GithubRepo[]) => {
      select.textContent = '';
      if (!current) {
        const none = el('option', '', repos.length ? 'Choose a repository…' : 'No repositories reachable');
        none.value = '';
        select.appendChild(none);
      }
      const names = repos.map((r) => r.fullName);
      if (current && !names.includes(current)) names.unshift(current);
      for (const name of names) {
        const opt = el('option', '', name);
        opt.value = name;
        opt.selected = name === current;
        select.appendChild(opt);
      }
      select.disabled = repos.length === 0;
    })
    .catch((err: unknown) => {
      placeholder.textContent = current ?? 'Repositories unavailable';
      ctx.say(errText(err));
    });

  select.addEventListener('change', async () => {
    if (!select.value || select.value === current) return;
    select.disabled = true;
    ctx.say('');
    try {
      ctx.onChange(await ctx.bridge.githubSetConfigRepo(select.value));
    } catch (err) {
      ctx.say(errText(err));
      select.disabled = false;
    }
  });
  return box;
}

export function githubCard(ctx: GitHubCardContext, info: IntegrationProviderInfo): HTMLElement {
  const { auth, github } = info;
  const card = cardShell({
    title: info.label,
    headRight: statusEl(auth.connected, auth.connected ? 'connected' : 'offline'),
  });
  card.classList.add('pv-card', 'pv-github');
  card.dataset.provider = info.id;
  const waiting = auth.pending && !auth.connected;
  card.appendChild(
    el('div', 'card-sub', waiting ? 'Waiting for the sign-in in your browser… come back here when done' : auth.detail),
  );

  if (waiting) {
    const foot = el('div', 'card-foot');
    const cancel = button('btn-ghost', 'Cancel');
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      await ctx.bridge.providerAuthCancel(info.id).catch((err: unknown) => ctx.say(errText(err)));
      ctx.onChange();
    });
    foot.appendChild(cancel);
    card.appendChild(foot);
    return card;
  }

  if (!auth.connected) {
    card.appendChild(el('p', 'pv-note', `Puck signs you in through its server at ${github.server}; your runners and environments belong to that account.`));
    const foot = el('div', 'card-foot');
    const signIn = button('btn-primary', 'Sign in with GitHub');
    signIn.addEventListener('click', async () => {
      signIn.disabled = true;
      ctx.say('');
      try {
        await ctx.bridge.providerAuthStart(info.id);
        ctx.onSignInStarted(info.id);
      } catch (err) {
        ctx.say(errText(err));
      }
      ctx.onChange();
    });
    foot.appendChild(signIn);
    card.appendChild(foot);
    return card;
  }

  const facts = el('dl', 'facts');
  facts.append(el('dt', '', 'Account'), el('dd', '', github.login ?? '—'));
  card.appendChild(facts);
  card.appendChild(installationsBlock(ctx, info));
  card.appendChild(configRepoBlock(ctx, info));

  const foot = el('div', 'card-foot');
  const signOut = button('btn-ghost', 'Sign out of Puck');
  signOut.addEventListener('click', async () => {
    signOut.disabled = true;
    ctx.say('');
    try {
      await ctx.bridge.providerAuthLogout(info.id);
    } catch (err) {
      ctx.say(errText(err));
    }
    ctx.onChange();
  });
  foot.appendChild(signOut);
  card.appendChild(foot);
  return card;
}
