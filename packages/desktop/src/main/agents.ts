/**
 * Agent primitive (main process).
 *
 * An agent is a named, persisted provider configuration — provider, model,
 * system instructions, thinking level, schema-driven provider settings
 * (validated against the provider's configOptions), and an advanced JSON
 * passthrough for anything else the provider's API exposes. Chat turns run
 * through the active agent inside the active environment.
 */

import type { AgentConfig, AgentInfo } from '../harness/bridge';
import { isPlainObject, validateSettings } from '../harness/options';
import { defaultProvider, providerById } from './providers';
import { defineStore } from './store';

interface Store {
  agents: AgentConfig[];
  activeAgentId: string | null;
}

const store = defineStore<Store>({
  file: 'puck-agents.json',
  defaults: () => ({ agents: [], activeAgentId: null }),
  // Dual-read legacy on-disk keys (`settings`/`thinking`); writes use the
  // new names only, so records converge on save.
  migrate: (raw) => ({
    ...raw,
    agents: raw.agents.map((entry) => {
      const legacy = entry as AgentConfig & {
        settings?: Record<string, unknown>;
        thinking?: string;
      };
      const { settings: legacyOptions, thinking: legacyEffort, ...rest } = legacy;
      return {
        ...rest,
        options: legacy.options ?? legacyOptions ?? {},
        effort: legacy.effort ?? legacyEffort ?? 'auto',
      };
    }),
  }),
});

function load(): Store {
  const s = store.read();
  if (!s.agents.length) {
    // First run: seed one agent per built-in provider, with stable ids.
    s.agents = [
      {
        id: 'claude-default',
        name: 'Claude',
        provider: 'claude-code',
        model: 'auto',
        systemPrompt: '',
        effort: 'auto',
        options: {},
        advanced: '',
      },
      {
        id: 'codex-default',
        name: 'Codex',
        provider: 'codex',
        model: 'auto',
        systemPrompt: '',
        effort: 'auto',
        options: {},
        advanced: '',
      },
    ];
    s.activeAgentId = 'claude-default';
    store.persist();
  }
  return s;
}

const save = store.persist;

function sanitize(cfg: Omit<AgentConfig, 'id'>): Omit<AgentConfig, 'id'> {
  if (cfg.advanced?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cfg.advanced);
    } catch {
      throw new Error('Advanced options must be valid JSON.');
    }
    if (!isPlainObject(parsed)) throw new Error('Advanced options must be a JSON object.');
  }
  const provider = providerById(cfg.provider) ?? defaultProvider();
  return {
    name: cfg.name.trim() || 'agent',
    provider: provider.id,
    model: cfg.model.trim() || 'auto',
    systemPrompt: cfg.systemPrompt ?? '',
    effort: cfg.effort.trim() || 'auto',
    // Schema-validate against the (possibly fallback) provider — a provider
    // switch drops the old provider's option ids here.
    options: validateSettings(provider.configOptions, cfg.options),
    advanced: cfg.advanced?.trim() ?? '',
  };
}

export function list(): AgentInfo[] {
  const s = load();
  return s.agents.map((a) => ({ ...a, active: a.id === s.activeAgentId }));
}

export function create(cfg: Omit<AgentConfig, 'id'>): AgentInfo[] {
  const s = load();
  s.agents.push({ id: crypto.randomUUID(), ...sanitize(cfg) });
  save();
  return list();
}

export function update(id: string, cfg: Omit<AgentConfig, 'id'>): AgentInfo[] {
  const s = load();
  const idx = s.agents.findIndex((a) => a.id === id);
  if (idx === -1) throw new Error('Unknown agent');
  s.agents[idx] = { id, ...sanitize(cfg) };
  save();
  return list();
}

export function remove(id: string): AgentInfo[] {
  const s = load();
  s.agents = s.agents.filter((a) => a.id !== id);
  if (s.activeAgentId === id) s.activeAgentId = s.agents[0]?.id ?? null;
  save();
  return list();
}

export function select(id: string): void {
  const s = load();
  if (s.agents.some((a) => a.id === id)) {
    s.activeAgentId = id;
    save();
  }
}

export function byId(id: string): AgentConfig | null {
  return load().agents.find((a) => a.id === id) ?? null;
}

export function active(): AgentConfig | null {
  const s = load();
  return s.agents.find((a) => a.id === s.activeAgentId) ?? null;
}
