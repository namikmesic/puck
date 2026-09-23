/**
 * The agent editor: identity fields (segmented model/thinking pickers with a
 * free-text Custom escape hatch), the schema-driven options form, the sticky
 * section rail with scroll-spy, dirty tracking against a saved snapshot, and
 * the save flow.
 *
 * All async population is guarded by an epoch: bumped on every (re)open and
 * provider switch, checked after each await — without it, opening agent A
 * then quickly agent B lets A's slower continuation fill the form while the
 * open id is B, and Save would write A's fields onto B.
 */

import type { AgentConfig, AgentInfo, ProviderInfo, PuckBridge } from '../../harness/bridge';
import { el, flashSaved } from '../dom';
import { renderOptionsForm, type OptionsForm } from '../options';
import { buildSeg, button, errText, latestToken, stableJson } from '../util';

export interface AgentEditorElements {
  view: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  controls: HTMLElement;
  msg: HTMLElement;
  back: HTMLButtonElement;
  name: HTMLInputElement;
  provider: HTMLSelectElement;
  modelSeg: HTMLElement;
  model: HTMLInputElement;
  thinkingSeg: HTMLElement;
  system: HTMLTextAreaElement;
  systemHint: HTMLElement;
  options: HTMLElement;
  advanced: HTMLTextAreaElement;
  advancedWarn: HTMLElement;
  save: HTMLButtonElement;
  nav: HTMLElement;
  editorMain: HTMLElement;
  dirty: HTMLElement;
  identityCard: HTMLElement;
  /** Change-count badge in the identity card's head (slotted options). */
  identityModBadge: HTMLElement;
  instructionsCard: HTMLElement;
  advancedCard: HTMLElement;
}

export interface AgentEditorContext {
  bridge: PuckBridge | undefined;
  els: AgentEditorElements;
  loadProviders(): Promise<ProviderInfo[]>;
  /** Reveal the editor view (the nav module owns view switching). */
  showView(): void;
  navToAgents(): void;
  refreshStatus(): Promise<void>;
  /** Make the agent active and open its chat. */
  openAgentChat(agentId: string): void;
}

/** Sentinel segment in the model picker that reveals the free-text field. */
const CUSTOM_MODEL = '__custom__';

export function initAgentEditor(ctx: AgentEditorContext) {
  const { bridge, els } = ctx;

  /** Which agent the editor is showing; null once the user navigates away. */
  let detailAgentId: string | null = null;
  /** Live controller for the schema-driven options section. */
  let optionsForm: OptionsForm | null = null;
  const editorReq = latestToken();

  /** Current picks behind the segmented controls (buttons hold no form value). */
  let modelSel = 'auto';
  let thinkingSel = 'auto';

  /** Effective model id: the curated pick, or the typed id when "Custom…" is on. */
  function modelValue(): string {
    if (modelSel !== CUSTOM_MODEL) return modelSel;
    return els.model.value.trim() || 'auto';
  }

  /**
   * Model picker: curated provider models as segments plus a "Custom…"
   * segment that reveals a free-text id — Codex's lineup shifts faster than
   * any list.
   */
  function setModelControls(models: readonly string[], model: string): void {
    const listed = models.includes(model);
    modelSel = listed ? model : CUSTOM_MODEL;
    buildSeg(
      els.modelSeg,
      [...models.map((m) => ({ value: m, label: m })), { value: CUSTOM_MODEL, label: 'Custom…' }],
      modelSel,
      (value) => {
        modelSel = value;
        const custom = value === CUSTOM_MODEL;
        els.model.classList.toggle('hidden', !custom);
        if (custom) els.model.focus();
      },
    );
    els.model.value = listed ? '' : model;
    els.model.classList.toggle('hidden', listed);
  }

  /** Populates provider-dependent controls (models, thinking levels, options form). */
  function syncProviderFields(
    infos: ProviderInfo[],
    providerId: string,
    model: string,
    selectedThinking: string,
    settings: Record<string, unknown>,
  ): void {
    const info = infos.find((p) => p.id === providerId);
    setModelControls(info?.models ?? ['auto'], model);
    const levels = info?.thinkingLevels ?? ['auto'];
    thinkingSel = levels.includes(selectedThinking) ? selectedThinking : levels[0] ?? 'auto';
    buildSeg(
      els.thinkingSeg,
      levels.map((level) => ({ value: level, label: level })),
      thinkingSel,
      (value) => {
        thinkingSel = value;
      },
    );
    els.systemHint.textContent = info?.systemPromptHint ?? '';
    // Options declaring the identity slot join the identity card itself.
    optionsForm = renderOptionsForm(els.options, info?.configOptions ?? [], settings, {
      identity: { host: els.identityCard, badge: els.identityModBadge },
    });
    buildNav();
    refreshMarkers();
  }

  /* ----- Section nav: sticky rail with scroll-spy and per-group change dots ----- */

  interface NavEntry {
    btn: HTMLButtonElement;
    target: HTMLElement;
  }
  let navEntries: NavEntry[] = [];

  /** Rebuilds the section rail: fixed sections plus one entry per schema group. */
  function buildNav(): void {
    els.nav.textContent = '';
    navEntries = [];
    const add = (label: string, target: HTMLElement): void => {
      const btn = button('section-nav-item');
      btn.appendChild(el('span', 'section-nav-text', label));
      btn.appendChild(el('span', 'section-nav-dot'));
      btn.addEventListener('click', () =>
        target.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
      els.nav.appendChild(btn);
      navEntries.push({ btn, target });
    };
    add('Identity', els.identityCard);
    add('Instructions', els.instructionsCard);
    const groups = optionsForm?.groups ?? [];
    if (groups.length) els.nav.appendChild(el('span', 'section-nav-label', 'Options'));
    for (const group of groups) add(group.name, group.el);
    add('Advanced JSON', els.advancedCard);
    updateNavActive();
  }

  /** Scroll-spy: highlight the last section whose top has passed the fold line. */
  function updateNavActive(): void {
    if (!navEntries.length) return;
    const viewTop = els.view.getBoundingClientRect().top;
    const atEnd = els.view.scrollTop + els.view.clientHeight >= els.view.scrollHeight - 4;
    let active = navEntries[0];
    for (const entry of navEntries) {
      if (entry.target.getBoundingClientRect().top - viewTop <= 96) active = entry;
    }
    if (atEnd) active = navEntries[navEntries.length - 1];
    for (const entry of navEntries) entry.btn.classList.toggle('active', entry === active);
  }

  els.view.addEventListener('scroll', updateNavActive, { passive: true });

  /* ----- Dirty state: the save bar announces unsaved edits ----- */

  /** The exact `bridge.agentUpdate` payload the editor would save right now. */
  function payload(): Omit<AgentConfig, 'id'> {
    return {
      name: els.name.value,
      provider: els.provider.value,
      model: modelValue(),
      systemPrompt: els.system.value,
      effort: thinkingSel,
      options: optionsForm?.values() ?? {},
      advanced: els.advanced.value,
    };
  }

  /** Snapshot of the last saved payload; null while no agent is open. */
  let snapshot: string | null = null;

  /** Re-derives the save-bar dirty flag and the nav's per-group change dots. */
  function refreshMarkers(): void {
    if (snapshot !== null) {
      const dirty = stableJson(payload()) !== snapshot;
      els.dirty.textContent = dirty ? 'Unsaved changes' : '';
      els.dirty.classList.toggle('on', dirty);
    }
    // Any nav target carrying dataset.modified (group cards, the slotted
    // Identity card — written by renderOptionsForm) gets the change dot;
    // sections without it never do.
    for (const entry of navEntries) {
      entry.btn.classList.toggle('mod', Number(entry.target.dataset.modified ?? '0') > 0);
    }
  }

  // One delegated listener catches every control kind (inputs, selects,
  // segmented buttons, reset chips); rAF coalesces bursts into one recompute.
  let markersQueued = false;
  function scheduleMarkers(): void {
    if (markersQueued) return;
    markersQueued = true;
    requestAnimationFrame(() => {
      markersQueued = false;
      refreshMarkers();
    });
  }
  for (const type of ['input', 'change', 'click'] as const) {
    els.editorMain.addEventListener(type, scheduleMarkers);
  }

  /** Flags syntactically broken Advanced JSON while it's being typed. */
  function syncAdvancedWarn(): void {
    const text = els.advanced.value.trim();
    let bad = false;
    if (text) {
      try {
        JSON.parse(text);
      } catch {
        bad = true;
      }
    }
    els.advancedWarn.classList.toggle('hidden', !bad);
    els.advanced.classList.toggle('invalid', bad);
  }

  els.advanced.addEventListener('input', syncAdvancedWarn);

  // The page title mirrors the name field so renames read back immediately.
  els.name.addEventListener('input', () => {
    els.title.textContent = els.name.value.trim() || 'agent';
  });

  els.back.addEventListener('click', () => ctx.navToAgents());

  function renderHeader(agent: { id: string; name: string; active: boolean }): void {
    els.title.textContent = agent.name;
    els.status.textContent = '';
    if (agent.active) els.status.appendChild(el('span', 'badge-active', 'active'));
    els.controls.textContent = '';
    if (bridge) {
      const use = button('btn-ghost', 'Open chat');
      use.addEventListener('click', () => ctx.openAgentChat(agent.id));
      els.controls.appendChild(use);
    }
  }

  async function open(agent: AgentInfo): Promise<void> {
    const epoch = editorReq.next();
    detailAgentId = agent.id;
    snapshot = null; // pause dirty tracking while fields repopulate
    els.msg.textContent = '';
    els.name.value = agent.name;
    const infos = await ctx.loadProviders();
    if (!editorReq.isCurrent(epoch)) return; // a newer open/switch owns the form now
    els.provider.textContent = '';
    for (const info of infos) {
      const opt = document.createElement('option');
      opt.value = info.id;
      opt.textContent = info.label;
      if (info.id === agent.provider) opt.selected = true;
      els.provider.appendChild(opt);
    }
    els.system.value = agent.systemPrompt;
    els.advanced.value = agent.advanced;
    syncAdvancedWarn();
    syncProviderFields(infos, agent.provider, agent.model, agent.effort, agent.options);
    snapshot = stableJson(payload());
    refreshMarkers();
    renderHeader(agent);
    ctx.showView();
    els.view.scrollTop = 0;
    updateNavActive();
  }

  els.provider.addEventListener('change', () => {
    // Settings are provider-specific: switching providers starts from defaults.
    const epoch = editorReq.next();
    void ctx.loadProviders().then((infos) => {
      if (!editorReq.isCurrent(epoch)) return;
      syncProviderFields(infos, els.provider.value, 'auto', 'auto', {});
    });
  });

  els.save.addEventListener('click', async () => {
    if (!bridge || !detailAgentId) return;
    els.msg.textContent = '';
    els.save.disabled = true;
    try {
      const body = payload();
      const list = await bridge.agentUpdate(detailAgentId, body);
      const currentAgent = list.find((a) => a.id === detailAgentId);
      if (currentAgent) renderHeader(currentAgent);
      await ctx.refreshStatus();
      snapshot = stableJson(body);
      refreshMarkers();
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
      detailAgentId = null;
    },
  };
}

export type AgentEditor = ReturnType<typeof initAgentEditor>;
