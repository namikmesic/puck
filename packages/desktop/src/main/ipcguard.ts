/**
 * Validation at the IPC boundary. The renderer is inside our app, but treat
 * its payloads as untrusted: ids feed file paths and docker argv. (The
 * conversation payload codec lives with its format in conversations.ts.)
 */

import type { AgentConfig, EnvironmentConfig } from '../harness/bridge';
import { isPlainObject } from '../harness/options';

/** Store ids we mint (crypto.randomUUID() plus seeded slugs like `claude-default`). */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function requireId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new Error(`Invalid ${what} id.`);
  }
  return value;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Multi-argument channels ship one plain-object payload; anything else is a bug. */
export function objArgs(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error('Invalid IPC payload.');
  return value;
}

/** Required string field with no format constraint (prompts, opaque turn ids). */
export function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${what}.`);
  return value;
}

/** Ask answers: null (dismissed) or a string→string record keyed by question. */
export function askAnswersFrom(value: unknown): Record<string, string> | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) throw new Error('Invalid ask answers.');
  const out: Record<string, string> = {};
  for (const [key, answer] of Object.entries(value)) {
    if (typeof answer !== 'string') throw new Error('Invalid ask answers.');
    out[key] = answer;
  }
  return out;
}

/** Plain-object-or-empty; per-key schema validation happens in the agent store. */
function settingsFrom(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? { ...value } : {};
}

export function agentConfigFrom(raw: unknown): Omit<AgentConfig, 'id'> {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid agent config.');
  const cfg = raw as Record<string, unknown>;
  return {
    name: str(cfg.name),
    provider: str(cfg.provider),
    model: str(cfg.model, 'auto'),
    systemPrompt: str(cfg.systemPrompt),
    effort: str(cfg.effort, 'auto'),
    options: settingsFrom(cfg.options),
    advanced: str(cfg.advanced),
  };
}

/** Secret keys and env var keys both become env var names inside containers. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function requireSecretKey(value: unknown): string {
  if (typeof value !== 'string' || !ENV_NAME_RE.test(value)) {
    throw new Error('Invalid secret key.');
  }
  return value;
}

export function envConfigFrom(raw: unknown): EnvironmentConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('Invalid environment config.');
  const cfg = raw as Record<string, unknown>;
  const image = str(cfg.image).trim();
  const workspacePath = str(cfg.workspacePath).trim();
  // Leading-dash values would be parsed by docker as flags, not operands.
  if (image.startsWith('-')) throw new Error('Invalid image name.');
  if (workspacePath.startsWith('-')) throw new Error('Invalid workspace path.');
  const envVars: Record<string, string> = {};
  if (typeof cfg.envVars === 'object' && cfg.envVars !== null) {
    for (const [key, value] of Object.entries(cfg.envVars as Record<string, unknown>)) {
      if (ENV_NAME_RE.test(key) && typeof value === 'string') {
        envVars[key] = value;
      }
    }
  }
  return {
    name: str(cfg.name),
    image,
    workspacePath,
    autoInstall: cfg.autoInstall !== false,
    dockerfile: str(cfg.dockerfile),
    envVars,
  };
}
