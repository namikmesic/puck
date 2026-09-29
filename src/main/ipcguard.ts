/**
 * Validation at the IPC boundary. The renderer is inside our app, but treat
 * its payloads as untrusted: ids reach the Puck server, runners and
 * daemons, and name files.
 */

import type { Pin, PinSpec, StartSpec } from '../harness/bridge';
import { daemonCommandFrom, type RendererOp } from '../harness/daemon-protocol';
import { COMMIT_RE, isValidRefName } from '../harness/definitions/validate';
import { NAME_RE } from '../harness/env-definition';
import { validSecretValues } from '../harness/inbox';
import { isPlainObject } from '../harness/options';
import { ENV_ID_RE } from '../harness/runner-protocol';
import { RUNNER_ID_RE } from '../harness/server-api';

/** Provider ids (`claude-code`, `codex`, `runner`, `github`). */
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

/** The pin a definition update applies: the tag or branch, at the commit the check diffed. */
export function appliedPinFrom(raw: unknown): Pin {
  const spec = pinFrom(raw);
  const sha = str(objArgs(raw).sha).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid commit SHA.');
  return { kind: spec.kind, name: spec.name, sha };
}
