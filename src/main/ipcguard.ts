/**
 * Validation at the IPC boundary. The renderer is inside our app, but treat
 * its payloads as untrusted: ids feed file paths and docker argv. (The
 * conversation payload codec lives with its format in conversations.ts.)
 */

import type { AgentConfig, EnvironmentConfig, PinSpec, StartSpec } from '../harness/bridge';
import { daemonCommandFrom, type RendererOp } from '../harness/daemon-protocol';
import { COMMIT_RE, isValidRefName } from '../harness/definitions/validate';
import { NAME_RE } from '../harness/env-definition';
import { validSecretValues } from '../harness/inbox';
import { isPlainObject } from '../harness/options';
import { ENV_ID_RE } from '../harness/runner-protocol';
import { RUNNER_ID_RE } from '../harness/server-api';

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

/* ---------- Runners ---------- */

export function runnerIdFrom(value: unknown): string {
  if (typeof value !== 'string' || !RUNNER_ID_RE.test(value)) throw new Error('Invalid runner id.');
  return value;
}

/** Registration and removal token ids as the Puck server mints them. */
const ENROLL_ID_RE = /^reg_[0-9A-HJKMNP-TV-Z]{26}$/;

export function enrollTokenIdFrom(value: unknown): string {
  if (typeof value !== 'string' || !ENROLL_ID_RE.test(value)) throw new Error('Invalid token id.');
  return value;
}

/** The Puck server's rules for runner names and labels, checked here first. */
const RUNNER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/;
const RUNNER_LABEL_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

/** A runner rename or relabel: `{ name?, labels? }`, at least one. */
export function runnerPatchFrom(raw: unknown): { name?: string; labels?: string[] } {
  const a = objArgs(raw);
  const out: { name?: string; labels?: string[] } = {};
  if (a.name !== undefined) {
    const name = str(a.name).trim();
    if (!RUNNER_NAME_RE.test(name)) throw new Error('A runner name is 1-64 letters, digits, spaces and ._()-, starting with a letter or digit.');
    out.name = name;
  }
  if (a.labels !== undefined) {
    if (!Array.isArray(a.labels) || a.labels.length > 16) throw new Error('Labels are a list of at most 16.');
    const labels = a.labels.map((l) => str(l).trim().toLowerCase()).filter(Boolean);
    for (const l of labels) if (!RUNNER_LABEL_RE.test(l)) throw new Error(`Label "${l.slice(0, 64)}" must be lowercase letters, digits and :._-.`);
    out.labels = [...new Set(labels)];
  }
  if (out.name === undefined && out.labels === undefined) throw new Error('Nothing to change.');
  return out;
}

/* ---------- Environments ---------- */

export function instanceIdFrom(value: unknown): string {
  if (typeof value !== 'string' || !ENV_ID_RE.test(value)) throw new Error('Invalid environment id.');
  return value;
}

/** What the start flow sends: a pin, a definition name, a runner, and secret values. */
export function startSpecFrom(raw: unknown): StartSpec {
  const a = objArgs(raw);
  const definition = str(a.definition);
  if (!NAME_RE.test(definition)) throw new Error('Invalid environment definition name.');
  const secrets = a.secrets === undefined ? {} : validSecretValues(a.secrets);
  if (!secrets) throw new Error('Secret names must be variable names that do not start with PUCK_, each value at most 64KB.');
  return { pin: pinFrom(a.pin), definition, runnerId: runnerIdFrom(a.runnerId), secrets };
}

/** The renderer's daemon passthrough: an environment id and an allowlisted op. */
export function daemonCallFrom(raw: unknown): { envId: string; op: RendererOp; args: unknown } {
  const a = objArgs(raw);
  const envId = instanceIdFrom(a.envId);
  const { op, args } = daemonCommandFrom(a.op, a.args ?? {});
  return { envId, op, args };
}

/* ---------- Providers ---------- */

/** GitHub `owner/name`. */
const REPO_NAME_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export function repoNameFrom(value: unknown): string {
  if (typeof value !== 'string' || !REPO_NAME_RE.test(value)) throw new Error('Invalid repository name.');
  return value;
}

/* ---------- Definitions ---------- */

/** A pin to resolve: a tag or branch with a valid ref name, or a commit SHA. */
export function pinFrom(raw: unknown): PinSpec {
  const a = objArgs(raw);
  const name = str(a.name);
  switch (a.kind) {
    case 'tag':
    case 'branch':
      if (!isValidRefName(name)) throw new Error(`Invalid ${a.kind} name.`);
      return { kind: a.kind, name };
    case 'commit':
      if (!COMMIT_RE.test(name)) throw new Error('Invalid commit SHA.');
      return { kind: 'commit', name };
    default:
      throw new Error('Invalid pin: kind must be tag, branch or commit.');
  }
}
