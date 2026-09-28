/**
 * Settings → Providers → Integrations → GitHub. Signed out: device-flow
 * sign-in (the code, "Copy code and open github.com/login/device") and the
 * personal-token fallback. Signed in: the login, the app installations
 * with Manage links and "Install Puck on an account", the config-repo
 * picker with "Open repo", the mode, and Sign out. Tokens never reach this
 * module; main returns the login and settings only. Context in, elements
 * built here, no DOM lookups.
 */

import type {
  DeviceCodePrompt,
  GitHubInstallation,
  GitHubRepo,
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

function codeBlock(ctx: GitHubCardContext, info: IntegrationProviderInfo, code: DeviceCodePrompt): HTMLElement {
  const box = el('div', 'pv-device');
  box.appendChild(el('div', 'pv-subhead', 'Enter this code on GitHub'));
  box.appendChild(el('div', 'pv-user-code', code.userCode));
  box.appendChild(
    el('div', 'card-sub', `Waiting for approval — the code expires at ${new Date(code.expiresAt).toLocaleTimeString()}`),
  );
  const foot = el('div', 'card-foot');
  const open = button('btn-primary', 'Copy code and open github.com/login/device');
  open.addEventListener('click', async () => {
    try {
      await ctx.copy(code.userCode);
    } catch {
      /* the code is on screen; opening the page still helps */
    }
    await ctx.bridge.openExternal(code.verificationUri);
  });
  const cancel = button('btn-ghost', 'Cancel');
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    await ctx.bridge.providerAuthCancel(info.id).catch((err: unknown) => (ctx.say(errText(err))));
    ctx.onChange();
  });
  foot.append(open, cancel);
  box.appendChild(foot);
  return box;
}

function patForm(ctx: GitHubCardContext, info: IntegrationProviderInfo, open: boolean): HTMLElement {
  const details = el('details', 'pv-pat');
  details.open = open;
  details.appendChild(el('summary', '', 'Use a personal access token instead'));
  details.appendChild(
    el(
      'p',
      'pv-note',
      'A fine-grained token with Contents and Pull requests read/write on the repositories Puck should reach.',
    ),
  );
  const create = button('btn-ghost', 'Create a token on GitHub');
  create.addEventListener('click', () => void ctx.bridge.openExternal(info.github.patUrl));
  const form = el('form', 'pv-pat-form config-form');
  const input = el('input', '');
  input.type = 'password';
  input.placeholder = 'github_pat_…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 255;
  input.setAttribute('aria-label', 'Personal access token');
  const save = el('button', 'btn-ghost', 'Use token');
  save.type = 'submit';
  form.append(input, save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return input.focus();
    save.disabled = true;
    ctx.say('');
    try {
      const infos = await ctx.bridge.githubSetPat(input.value);
      input.value = '';
      ctx.onChange(infos);
    } catch (err) {
      ctx.say(errText(err));
      save.disabled = false;
    }
  });
  const foot = el('div', 'card-foot');
  foot.appendChild(create);
  details.append(foot, form);
  return details;
}

function installationsBlock(ctx: GitHubCardContext, info: IntegrationProviderInfo): HTMLElement {
  const box = el('div', 'pv-installs');
  box.appendChild(el('div', 'pv-subhead', 'Installations'));
  const list = el('ul', 'pv-list');
  list.appendChild(el('li', 'pv-loading', 'Loading…'));
  box.appendChild(list);
  const install = button('btn-ghost', 'Install Puck on an account');
  install.addEventListener('click', () => void ctx.bridge.openExternal(info.github.installUrl));
  const foot = el('div', 'card-foot');
  foot.appendChild(install);
  box.appendChild(foot);

  void ctx.bridge
    .githubInstallations()
    .then((installs: GitHubInstallation[]) => {
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
    .then((repos: GitHubRepo[]) => {
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
  card.appendChild(el('div', 'card-sub', auth.detail));

  if (github.pendingCode && !auth.connected) {
    card.appendChild(codeBlock(ctx, info, github.pendingCode));
    return card;
  }

  if (!auth.connected) {
    const foot = el('div', 'card-foot');
    const signIn = button('btn-primary', 'Sign in with GitHub');
    signIn.disabled = !github.appConfigured;
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
    card.appendChild(patForm(ctx, info, !github.appConfigured));
    return card;
  }

  const facts = el('dl', 'facts');
  facts.append(el('dt', '', 'Account'), el('dd', '', github.login ?? '—'));
  facts.append(el('dt', '', 'Mode'), el('dd', '', github.mode === 'pat' ? 'Personal access token' : 'GitHub App'));
  card.appendChild(facts);
  if (github.mode === 'app') card.appendChild(installationsBlock(ctx, info));
  card.appendChild(configRepoBlock(ctx, info));

  const foot = el('div', 'card-foot');
  const signOut = button('btn-ghost', 'Sign out');
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
  if (github.mode === 'app') card.appendChild(patForm(ctx, info, false));
  return card;
}
