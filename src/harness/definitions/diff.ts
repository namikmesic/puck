/**
 * Update classes: what changed between two resolutions of the same
 * environment definition, each change tagged hot, reprovision or rebuild
 * per the field tables' "On update" column. Repos are matched by their
 * GitHub name and assignments and agents by agent name, so reordering a
 * list is not a change. The source (repo, pin, path) is not compared.
 */

import type { DefinitionChange, ResolvedAgent, ResolvedEnvironment, UpdateClass } from './types';

const RANK: Readonly<Record<UpdateClass, number>> = { hot: 0, reprovision: 1, rebuild: 2 };

/** Scalar environment fields and their class. */
export const ENVIRONMENT_FIELD_CLASSES: Readonly<Record<string, UpdateClass>> = {
  description: 'hot',
  image: 'rebuild',
  dockerfile: 'rebuild',
  'resources.cpus': 'rebuild',
  'resources.memory': 'rebuild',
  'orchestrator.agent': 'hot',
  'orchestrator.autoWake': 'hot',
  'orchestrator.maxAutoTurnsPerHour': 'hot',
  'limits.maxWorkers': 'hot',
  'limits.maxAttempts': 'hot',
  'policies.asks': 'hot',
  'policies.publish': 'hot',
  'policies.draftPullRequests': 'hot',
  'policies.github.intake': 'hot',
  'policies.github.intakeLabel': 'hot',
  'policies.github.agentLabels': 'hot',
  'policies.github.statusComment': 'hot',
  'policies.github.ci': 'hot',
  'policies.github.maxCiFixAttempts': 'hot',
  'policies.github.reviews': 'hot',
  'policies.github.allowWorkflowEdits': 'hot',
  'policies.github.allowCiRerun': 'hot',
  'git.userName': 'reprovision',
  'git.userEmail': 'reprovision',
};

/** Fields of each repo entry, plus adding and removing one. */
export const REPO_FIELD_CLASSES: Readonly<Record<'added' | 'removed' | 'dir' | 'branch', UpdateClass>> = {
  added: 'reprovision',
  removed: 'reprovision',
  dir: 'rebuild',
  branch: 'hot',
};

/** Fields of each assignment, plus adding and removing one. */
export const ASSIGNMENT_FIELD_CLASSES: Readonly<
  Record<'added' | 'removed' | 'maxParallel' | 'instructions', UpdateClass>
> = {
  added: 'hot',
  removed: 'hot',
  maxParallel: 'hot',
  instructions: 'hot',
};

/** Fields of each embedded agent. A rename is a different agent (an assignment change). */
export const AGENT_FIELD_CLASSES: Readonly<Record<Exclude<keyof ResolvedAgent, 'name'>, UpdateClass>> = {
  description: 'hot',
  harness: 'reprovision',
  model: 'hot',
  effort: 'hot',
  instructions: 'hot',
  instructionsFile: 'hot',
  options: 'hot',
  advanced: 'hot',
};

/** Per key of the `env` map, and per secret name. */
export const ENV_VAR_CLASS: UpdateClass = 'hot';
export const SECRET_CLASS: UpdateClass = 'hot';

/** Deterministic JSON (sorted keys) for comparing nested values. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function show(value: unknown): string {
  if (value === null || value === undefined) return '(default)';
  if (typeof value === 'string') return value.length > 60 ? `"${value.slice(0, 57)}…"` : JSON.stringify(value);
  const text = canonical(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function get(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined), obj);
}

export function diffEnvironments(prev: ResolvedEnvironment, next: ResolvedEnvironment): DefinitionChange[] {
  const out: DefinitionChange[] = [];
  const changed = (field: string, cls: UpdateClass, a: unknown, b: unknown): void => {
    if (canonical(a) !== canonical(b)) out.push({ field, class: cls, summary: `${field}: ${show(a)} → ${show(b)}` });
  };

  for (const [field, cls] of Object.entries(ENVIRONMENT_FIELD_CLASSES)) changed(field, cls, get(prev, field), get(next, field));

  const repoKey = (github: string): string => github.toLowerCase();
  const prevRepos = new Map(prev.repos.map((r) => [repoKey(r.github), r]));
  const nextRepos = new Map(next.repos.map((r) => [repoKey(r.github), r]));
  for (const [key, r] of nextRepos) {
    const old = prevRepos.get(key);
    if (!old) {
      out.push({ field: `repos[${r.github}]`, class: REPO_FIELD_CLASSES.added, summary: `Add repo ${r.github} (cloned into /workspace/${r.dir})` });
      continue;
    }
    changed(`repos[${r.github}].dir`, REPO_FIELD_CLASSES.dir, old.dir, r.dir);
    changed(`repos[${r.github}].branch`, REPO_FIELD_CLASSES.branch, old.branch, r.branch);
  }
  for (const [key, r] of prevRepos) {
    if (!nextRepos.has(key)) {
      out.push({ field: `repos[${r.github}]`, class: REPO_FIELD_CLASSES.removed, summary: `Remove repo ${r.github} (/workspace/${r.dir} is kept)` });
    }
  }

  const prevAssigned = new Map(prev.agents.map((a) => [a.agent, a]));
  const nextAssigned = new Map(next.agents.map((a) => [a.agent, a]));
  for (const [name, a] of nextAssigned) {
    const old = prevAssigned.get(name);
    if (!old) {
      out.push({ field: `agents[${name}]`, class: ASSIGNMENT_FIELD_CLASSES.added, summary: `Assign agent ${name}` });
      continue;
    }
    changed(`agents[${name}].maxParallel`, ASSIGNMENT_FIELD_CLASSES.maxParallel, old.maxParallel, a.maxParallel);
    changed(`agents[${name}].instructions`, ASSIGNMENT_FIELD_CLASSES.instructions, old.instructions, a.instructions);
  }
  for (const name of prevAssigned.keys()) {
    if (!nextAssigned.has(name)) {
      out.push({ field: `agents[${name}]`, class: ASSIGNMENT_FIELD_CLASSES.removed, summary: `Unassign agent ${name}` });
    }
  }

  // Agents referenced before and after; one that comes or goes is covered above.
  for (const [name, agent] of Object.entries(next.agentDefinitions)) {
    if (!hasOwn(prev.agentDefinitions, name)) continue;
    const old = prev.agentDefinitions[name];
    for (const [field, cls] of Object.entries(AGENT_FIELD_CLASSES)) {
      changed(`agentDefinitions.${name}.${field}`, cls, old[field as keyof ResolvedAgent], agent[field as keyof ResolvedAgent]);
    }
  }

  const keys = new Set([...Object.keys(prev.env), ...Object.keys(next.env)]);
  const envAt = (env: Record<string, string>, key: string) => (hasOwn(env, key) ? env[key] : undefined);
  for (const key of [...keys].sort()) changed(`env.${key}`, ENV_VAR_CLASS, envAt(prev.env, key), envAt(next.env, key));

  const prevSecrets = new Set(prev.secrets);
  const nextSecrets = new Set(next.secrets);
  for (const name of next.secrets) {
    if (!prevSecrets.has(name)) out.push({ field: `secrets.${name}`, class: SECRET_CLASS, summary: `Add secret ${name}` });
  }
  for (const name of prev.secrets) {
    if (!nextSecrets.has(name)) out.push({ field: `secrets.${name}`, class: SECRET_CLASS, summary: `Remove secret ${name}` });
  }
  return out;
}

/** The strongest class among the changes; null when nothing changed. */
export function updateClass(changes: readonly DefinitionChange[]): UpdateClass | null {
  let best: UpdateClass | null = null;
  for (const c of changes) if (best === null || RANK[c.class] > RANK[best]) best = c.class;
  return best;
}

/** Changes grouped for the apply dialog. */
export function groupByClass(changes: readonly DefinitionChange[]): Record<UpdateClass, DefinitionChange[]> {
  const out: Record<UpdateClass, DefinitionChange[]> = { hot: [], reprovision: [], rebuild: [] };
  for (const c of changes) out[c.class].push(c);
  return out;
}
