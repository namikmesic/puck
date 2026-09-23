/**
 * The environment detail editor: config form (name / image / workspace /
 * auto-install / Dockerfile), the env-vars and secrets key-value lists, the
 * page header with live status + the shared op rail, and the save flow.
 *
 * Structural twin of the agent editor: context/elements in, controller out,
 * no DOM lookups inside — which is what makes it jsdom-testable.
 */

import type { EnvironmentInfo, HarnessStatus, PuckBridge } from '../../harness/bridge';
import { el, flashSaved, statusEl } from '../dom';
import { button, errText } from '../util';
import { envOpRail } from './env-rail';

export interface EnvEditorElements {
  title: HTMLElement;
  status: HTMLElement;
  controls: HTMLElement;
  msg: HTMLElement;
  back: HTMLButtonElement;
  name: HTMLInputElement;
  image: HTMLInputElement;
  workspace: HTMLInputElement;
  autoInstall: HTMLInputElement;
  dockerfile: HTMLTextAreaElement;
  envVars: HTMLElement;
  envKey: HTMLInputElement;
  envVal: HTMLInputElement;
  envAdd: HTMLButtonElement;
  secrets: HTMLElement;
  secretKey: HTMLInputElement;
  secretVal: HTMLInputElement;
  secretAdd: HTMLButtonElement;
  save: HTMLButtonElement;
}

export interface EnvEditorContext {
  bridge: PuckBridge | undefined;
  els: EnvEditorElements;
  applyStatus(status: HarnessStatus): void;
  refreshStatus(): Promise<void>;
  /** Reveal the env-detail view (the nav module owns view switching). */
  showView(): void;
  navToEnvs(): void;
}

export function initEnvEditor(ctx: EnvEditorContext) {
  const { bridge, els } = ctx;

  /** Which environment the editor is showing; null once the user navigates away. */
  let detailEnvId: string | null = null;
  /** Working copy of the env-var map — edits stay local until Save. */
  let detailEnvVars: Record<string, string> = {};

  function kvRow(key: string, value: string, onRemove: () => void): HTMLElement {
    const row = el('div', 'kv-row');
    row.appendChild(el('span', 'kv-key', key));
    row.appendChild(el('span', 'kv-val', value));
    const remove = button('kv-remove', '✕');
    remove.addEventListener('click', onRemove);
    row.appendChild(remove);
    return row;
  }

  function renderEnvVars(): void {
    els.envVars.textContent = '';
    for (const [key, value] of Object.entries(detailEnvVars)) {
      els.envVars.appendChild(
        kvRow(key, value, () => {
          delete detailEnvVars[key];
          renderEnvVars();
        }),
      );
    }
  }

  function renderSecrets(keys: string[]): void {
    els.secrets.textContent = '';
    for (const key of keys) {
      els.secrets.appendChild(
        kvRow(key, '••••••••', async () => {
          if (!bridge || !detailEnvId) return;
          const envs = await bridge.envSecretDelete(detailEnvId, key);
          const current = envs.find((e) => e.id === detailEnvId);
          renderSecrets(current?.secretKeys ?? []);
        }),
      );
    }
  }

  /** Header of the environment page: name, live status, management controls. */
  function renderHeader(env: EnvironmentInfo): void {
    els.title.textContent = env.name;
    els.status.textContent = '';
    els.status.appendChild(statusEl(env.status === 'running', env.status));
    if (env.active) els.status.appendChild(el('span', 'badge-active', 'active'));

    els.controls.textContent = '';
    if (!bridge) return;
    envOpRail(els.controls, env, {
      bridge,
      applyStatus: ctx.applyStatus,
      message: (text) => {
        els.msg.textContent = text;
      },
      onSettled: async (latest) => {
        await ctx.refreshStatus();
        if (!detailEnvId) return; // deleted — already navigated back
        const list = latest ?? ((await bridge.envList().catch(() => [])) as EnvironmentInfo[]);
        const shown = list.find((e) => e.id === detailEnvId);
        if (shown) renderHeader(shown);
      },
      onDelete: async (target) => {
        const out = await bridge.envDelete(target.id);
        ctx.navToEnvs(); // the nav applier abandons the editor on the way out
        return out;
      },
    });
  }

  /** Populate the form from an environment and reveal the page. */
  function open(env: EnvironmentInfo): void {
    detailEnvId = env.id;
    els.msg.textContent = '';
    els.name.value = env.name;
    els.image.value = env.image;
    els.workspace.value = env.workspacePath;
    els.autoInstall.checked = env.autoInstall;
    els.dockerfile.value = env.dockerfile;
    detailEnvVars = { ...env.envVars };
    renderEnvVars();
    renderSecrets(env.secretKeys);
    renderHeader(env);
    ctx.showView();
  }

  els.back.addEventListener('click', () => ctx.navToEnvs());

  els.envAdd.addEventListener('click', () => {
    const key = els.envKey.value.trim();
    if (!key) return;
    detailEnvVars[key] = els.envVal.value;
    els.envKey.value = '';
    els.envVal.value = '';
    renderEnvVars();
  });

  els.secretAdd.addEventListener('click', async () => {
    if (!bridge || !detailEnvId) return;
    const key = els.secretKey.value.trim();
    if (!key) return;
    els.msg.textContent = '';
    try {
      const envs = await bridge.envSecretSet(detailEnvId, key, els.secretVal.value);
      els.secretKey.value = '';
      els.secretVal.value = '';
      const current = envs.find((e) => e.id === detailEnvId);
      renderSecrets(current?.secretKeys ?? []);
    } catch (err) {
      els.msg.textContent = errText(err);
    }
  });

  els.save.addEventListener('click', async () => {
    if (!bridge || !detailEnvId) return;
    els.msg.textContent = '';
    els.save.disabled = true;
    try {
      const envs = await bridge.envUpdate(detailEnvId, {
        name: els.name.value,
        image: els.image.value,
        workspacePath: els.workspace.value,
        autoInstall: els.autoInstall.checked,
        dockerfile: els.dockerfile.value,
        envVars: detailEnvVars,
      });
      const current = envs.find((e) => e.id === detailEnvId);
      if (current) renderHeader(current);
      await ctx.refreshStatus();
      flashSaved(els.save);
    } catch (err) {
      els.msg.textContent = errText(err);
    }
    els.save.disabled = false;
  });

  return {
    open,
    /** The user navigated away — a lingering id must not accept a Save. */
    abandon(): void {
      detailEnvId = null;
    },
    /** An env died elsewhere (list-card delete) — drop it if it's the one open. */
    forget(envId: string): void {
      if (detailEnvId === envId) detailEnvId = null;
    },
  };
}

export type EnvEditor = ReturnType<typeof initEnvEditor>;
