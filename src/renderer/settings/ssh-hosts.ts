/**
 * Settings → Providers → Environments: the environment-provider cards.
 * Local Docker shows where the CLI was found and its health; Docker over
 * SSH lists its hosts (label, host, health dot, Check, armed Remove), adds
 * hosts, and states what an SSH host needs - including the recommended
 * ~/.ssh/config block with a Copy button (Puck never edits that file).
 * Context in, elements built here, no DOM lookups.
 */

import type { EnvironmentProviderInfo, EnvTargetInfo, ProviderInfo, PuckBridge, TargetHealth } from '../../harness/bridge';
import { armDelete, el } from '../dom';
import { button, errText } from '../util';
import { cardShell } from './cards';

export const SSH_CONFIG_BLOCK = `Host my-docker-host
  HostName host.example.com
  User me
  ControlMaster auto
  ControlPath ~/.ssh/cm-%C
  ControlPersist 10m
  ServerAliveInterval 15
  ServerAliveCountMax 4
  BatchMode yes
  # Keys in 1Password, Secretive or gpg-agent? Point at that agent:
  # IdentityAgent ~/path/to/agent.sock`;

export const SSH_REQUIREMENTS = [
  'Key authentication through your ssh agent (ssh-add). Puck has no terminal, so passphrase prompts fail.',
  "Apps opened from Finder see only macOS's own ssh agent: keys held by another agent need IdentityAgent in the Host block.",
  'The host key already known (connect once with ssh), or StrictHostKeyChecking accept-new.',
  'A remote user in the docker group, with docker on the non-interactive PATH.',
];

export interface EnvProvidersContext {
  bridge: PuckBridge;
  /** Show text on the section's message line ('' clears it). */
  say(text: string): void;
  /** The provider list changed (a host was added or removed): re-render with it. */
  onChange(infos: ProviderInfo[]): void;
  copy(text: string): Promise<void>;
}

/** Health results survive re-renders for the lifetime of the Settings page. */
const lastHealth = new Map<string, TargetHealth>();

const healthKey = (providerId: string, targetId: string): string => `${providerId}/${targetId}`;

function healthDot(health: TargetHealth | undefined, checking: boolean): HTMLElement {
  const state = checking ? ' busy' : health ? (health.ok ? ' on' : ' bad') : '';
  const word = checking ? 'checking' : health ? (health.ok ? 'healthy' : 'problem') : 'unchecked';
  const wrap = el('span', `status${state}`);
  wrap.appendChild(el('span', 'dot'));
  wrap.appendChild(document.createTextNode(word));
  return wrap;
}

/** One target row: label, host, health, Check (and Remove for SSH hosts). */
function targetRow(
  ctx: EnvProvidersContext,
  provider: EnvironmentProviderInfo,
  target: EnvTargetInfo,
  removable: boolean,
): HTMLElement {
  const row = el('div', 'pv-target');
  row.dataset.target = target.id;
  const head = el('div', 'pv-target-head');
  head.appendChild(el('span', 'pv-target-label', target.label));
  const key = healthKey(provider.id, target.id);
  let dot = healthDot(lastHealth.get(key), false);
  head.appendChild(dot);
  row.appendChild(head);
  if (target.host) row.appendChild(el('div', 'card-sub', target.host));
  const message = el('div', 'pv-health-msg', lastHealth.get(key)?.message ?? '');
  row.appendChild(message);

  const actions = el('div', 'card-foot');
  const check = button('btn-ghost', 'Check');
  check.addEventListener('click', async () => {
    check.disabled = true;
    const next = healthDot(undefined, true);
    dot.replaceWith(next);
    dot = next;
    try {
      const health = await ctx.bridge.targetHealth(provider.id, target.id);
      lastHealth.set(key, health);
      message.textContent = health.message;
    } catch (err) {
      lastHealth.delete(key);
      message.textContent = errText(err);
    }
    const done = healthDot(lastHealth.get(key), false);
    dot.replaceWith(done);
    dot = done;
    check.disabled = false;
  });
  actions.appendChild(check);
  if (removable) {
    const remove = button('btn-ghost danger', 'Remove');
    armDelete(remove, async () => {
      remove.disabled = true;
      try {
        lastHealth.delete(key);
        ctx.onChange(await ctx.bridge.sshHostRemove(target.id));
      } catch (err) {
        ctx.say(errText(err));
        remove.disabled = false;
      }
    });
    actions.appendChild(remove);
  }
  row.appendChild(actions);
  return row;
}

function addHostForm(ctx: EnvProvidersContext): HTMLElement {
  const form = el('form', 'pv-add-host config-form');
  const label = el('input', '');
  label.placeholder = 'Label (optional)';
  label.maxLength = 64;
  label.setAttribute('aria-label', 'Host label');
  const host = el('input', '');
  host.placeholder = 'ssh://user@host or a Host alias';
  host.setAttribute('aria-label', 'SSH host');
  host.spellcheck = false;
  host.autocapitalize = 'off';
  const add = el('button', 'btn-ghost', 'Add host');
  add.type = 'submit';
  form.append(label, host, add);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!host.value.trim()) return host.focus();
    add.disabled = true;
    ctx.say('');
    try {
      ctx.onChange(await ctx.bridge.sshHostAdd({ label: label.value.trim(), host: host.value.trim() }));
    } catch (err) {
      ctx.say(errText(err));
      add.disabled = false;
    }
  });
  return form;
}

function requirements(ctx: EnvProvidersContext): HTMLElement {
  const box = el('div', 'pv-ssh-reqs');
  box.appendChild(el('div', 'pv-subhead', 'Each host needs'));
  const list = el('ul', 'pv-list');
  for (const line of SSH_REQUIREMENTS) list.appendChild(el('li', '', line));
  box.appendChild(list);
  box.appendChild(el('div', 'pv-subhead', 'Recommended ~/.ssh/config block'));
  box.appendChild(el('pre', 'pv-code', SSH_CONFIG_BLOCK));
  const copy = button('btn-ghost', 'Copy');
  copy.addEventListener('click', async () => {
    try {
      await ctx.copy(SSH_CONFIG_BLOCK);
      copy.textContent = 'Copied ✓';
      setTimeout(() => (copy.textContent = 'Copy'), 1600);
    } catch (err) {
      ctx.say(errText(err));
    }
  });
  const foot = el('div', 'card-foot');
  foot.appendChild(copy);
  box.appendChild(foot);
  return box;
}

/** One card per environment provider. */
export function envProviderCard(ctx: EnvProvidersContext, provider: EnvironmentProviderInfo): HTMLElement {
  const ssh = provider.id === 'docker-ssh';
  const card = cardShell({ title: provider.label, headRight: ssh ? 'SSH' : 'local' });
  card.classList.add('pv-card');
  card.dataset.provider = provider.id;
  card.appendChild(el('div', 'card-sub', provider.detail));
  for (const target of provider.targets) card.appendChild(targetRow(ctx, provider, target, ssh));
  if (ssh) {
    card.appendChild(addHostForm(ctx));
    card.appendChild(requirements(ctx));
  }
  return card;
}
