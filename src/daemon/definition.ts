/**
 * The part of a resolved environment definition the daemon reads.
 *
 * A narrow, lenient reader: unknown fields are ignored, defaults are applied
 * again, and every value that later reaches a command line (repo names,
 * directories, branches) or a process environment is re-checked here.
 * Mirror fetches run as root; workspace checkouts run as the puck user.
 *
 * Referenced agent definitions are embedded either on their assignment
 * (`agents[].definition`, `orchestrator.definition`) or in an
 * `agentDefinitions` map keyed by agent name.
 */

import { harnessDescriptorById } from '../harness/providers';
import type { SettingsMap } from '../harness/options';

export interface DaemonAgent {
  name: string;
  description: string;
  harness: string;
  model: string;
  effort: string;
  instructions: string;
  options: SettingsMap;
  advanced: Record<string, unknown>;
}

export interface DaemonAssignment {
  agent: string;
  maxParallel: number;
  instructions: string;
}

export interface DaemonRepo {
  github: string;
  dir: string;
  branch: string | null;
}

export interface DaemonDefinition {
  name: string;
  description: string;
  repos: DaemonRepo[];
  orchestrator: { agent: string; autoWake: boolean; maxAutoTurnsPerHour: number };
  agents: DaemonAssignment[];
  agentDefs: Record<string, DaemonAgent>;
  limits: { maxWorkers: number; maxAttempts: number };
  policies: { asks: 'orchestrator-first' | 'user'; publish: 'manual' | 'orchestrator'; draftPullRequests: boolean };
  git: { userName: string | null; userEmail: string | null };
  env: Record<string, string>;
  secrets: string[];
}

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A branch name that is safe as a git argument (no option injection, no traversal). */
export function validBranch(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,200}$/.test(name) &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//')
  );
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const int = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;

class DefinitionError extends Error {}
function fail(message: string): never {
  throw new DefinitionError(message);
}

function readAgent(name: string, raw: unknown): DaemonAgent {
  if (!isObj(raw)) fail(`Agent "${name}" is not embedded in the definition.`);
  const harness = str(raw.harness);
  if (!harnessDescriptorById(harness)) fail(`Agent "${name}" uses an unknown harness "${harness}".`);
  return {
    name,
    description: str(raw.description),
    harness,
    model: str(raw.model, 'auto') || 'auto',
    effort: str(raw.effort, 'auto') || 'auto',
    instructions: str(raw.instructions),
    options: isObj(raw.options) ? (raw.options as SettingsMap) : {},
    advanced: isObj(raw.advanced) ? raw.advanced : {},
  };
}

export function readDefinition(raw: unknown): { ok: true; value: DaemonDefinition } | { ok: false; error: string } {
  try {
    return { ok: true, value: parse(raw) };
  } catch (err) {
    if (err instanceof DefinitionError) return { ok: false, error: err.message };
    throw err;
  }
}

function parse(raw: unknown): DaemonDefinition {
  if (!isObj(raw)) fail('The definition is not an object.');
  const name = str(raw.name);
  if (!NAME_RE.test(name)) fail(`Invalid environment name "${name.slice(0, 80)}".`);
  const embedded = isObj(raw.agentDefinitions) ? raw.agentDefinitions : {};
  const agentDefs: Record<string, DaemonAgent> = Object.create(null) as Record<string, DaemonAgent>;
  const embed = (agent: string, inline: unknown): void => {
    if (!NAME_RE.test(agent)) fail(`Invalid agent name "${agent.slice(0, 80)}".`);
    if (!agentDefs[agent]) agentDefs[agent] = readAgent(agent, inline ?? embedded[agent]);
  };

  if (!Array.isArray(raw.repos) || raw.repos.length === 0) fail('The definition lists no repos.');
  const dirs = new Set<string>();
  const repos = raw.repos.map((r): DaemonRepo => {
    if (!isObj(r)) fail('A repos entry is not an object.');
    const github = str(r.github);
    if (!REPO_RE.test(github)) fail(`Invalid repo "${github.slice(0, 120)}".`);
    const dir = str(r.dir) || github.split('/')[1].toLowerCase();
    if (!NAME_RE.test(dir)) fail(`Invalid repo directory "${dir.slice(0, 80)}".`);
    if (dirs.has(dir)) fail(`Two repos use the directory "${dir}".`);
    dirs.add(dir);
    const branch = r.branch === undefined || r.branch === null || r.branch === '' ? null : str(r.branch);
    if (branch !== null && !validBranch(branch)) fail(`Invalid branch "${branch.slice(0, 80)}" for ${github}.`);
    return { github, dir, branch };
  });

  const orch = isObj(raw.orchestrator) ? raw.orchestrator : fail('The definition has no orchestrator.');
  const orchestratorAgent = str(orch.agent);
  embed(orchestratorAgent, orch.definition);
  if (agentDefs[orchestratorAgent].harness !== 'claude-code') {
    fail(`The orchestrator agent "${orchestratorAgent}" must use Claude Code.`);
  }

  if (!Array.isArray(raw.agents) || raw.agents.length === 0) fail('The definition assigns no agents.');
  const agents = raw.agents.map((a): DaemonAssignment => {
    if (!isObj(a)) fail('An agents entry is not an object.');
    const agent = str(a.agent);
    embed(agent, a.definition);
    return { agent, maxParallel: int(a.maxParallel, 1, 1, 16), instructions: str(a.instructions) };
  });

  const env: Record<string, string> = {};
  if (isObj(raw.env)) {
    for (const [key, value] of Object.entries(raw.env)) {
      if (!ENV_KEY_RE.test(key) || key.startsWith('PUCK_')) fail(`Invalid environment variable name "${key.slice(0, 80)}".`);
      if (typeof value !== 'string') fail(`Environment variable ${key} is not a string.`);
      env[key] = value;
    }
  }
  const secrets = Array.isArray(raw.secrets) ? raw.secrets.filter((s): s is string => typeof s === 'string') : [];
  for (const key of secrets) {
    if (!ENV_KEY_RE.test(key) || key.startsWith('PUCK_')) fail(`Invalid secret name "${key.slice(0, 80)}".`);
  }

  const limits = isObj(raw.limits) ? raw.limits : {};
  const policies = isObj(raw.policies) ? raw.policies : {};
  const git = isObj(raw.git) ? raw.git : {};
  const sumParallel = agents.reduce((n, a) => n + a.maxParallel, 0);
  return {
    name,
    description: str(raw.description),
    repos,
    orchestrator: {
      agent: orchestratorAgent,
      autoWake: orch.autoWake !== false,
      maxAutoTurnsPerHour: int(orch.maxAutoTurnsPerHour, 30, 1, 200),
    },
    agents,
    agentDefs,
    limits: {
      maxWorkers: int(limits.maxWorkers, Math.min(64, sumParallel), 1, 64),
      maxAttempts: int(limits.maxAttempts, 2, 1, 10),
    },
    policies: {
      asks: policies.asks === 'user' ? 'user' : 'orchestrator-first',
      publish: policies.publish === 'manual' ? 'manual' : 'orchestrator',
      draftPullRequests: policies.draftPullRequests !== false,
    },
    git: {
      userName: str(git.userName) || null,
      userEmail: str(git.userEmail) || null,
    },
    env,
    secrets,
  };
}

/** Harness ids the definition's agents use (provisioning installs only these). */
export function referencedHarnesses(def: DaemonDefinition): string[] {
  return [...new Set(Object.values(def.agentDefs).map((a) => a.harness))];
}
