/**
 * Resolution: one environment definition at one commit becomes the
 * ResolvedEnvironment an instance runs - defaults applied, every referenced
 * agent embedded with its instructionsFile inlined, and the source recorded.
 * Only a startable environment resolves (the environment and all its agents
 * valid); anything else is a DefinitionsInvalidError listing the errors.
 */

import { blobAt, fileAt, isStartable, referencedAgents, type ValidatedRepo } from './validate';
import {
  DEFAULT_GITHUB_POLICIES,
  RESOLVER_VERSION,
  type AgentDefinition,
  type DefinitionError,
  type Pin,
  type RepoSnapshot,
  type ResolvedAgent,
  type ResolvedEnvironment,
} from './types';

export class DefinitionsInvalidError extends Error {
  constructor(
    readonly envName: string,
    readonly errors: DefinitionError[],
  ) {
    const first = errors[0];
    super(
      first
        ? `Environment "${envName}" is not startable: ${first.file}:${first.line}: ${first.message}` +
            (errors.length > 1 ? ` (and ${errors.length - 1} more)` : '')
        : `Environment "${envName}" does not exist at this commit.`,
    );
    this.name = 'DefinitionsInvalidError';
  }
}

/** The fields actually set (a YAML key present with no value adds nothing). */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}

export function resolveAgent(def: AgentDefinition, snap: RepoSnapshot): ResolvedAgent {
  const file = def.instructionsFile ?? null;
  return {
    name: def.name,
    description: def.description ?? '',
    harness: def.harness,
    model: def.model ?? 'auto',
    effort: def.effort ?? 'auto',
    instructions: file !== null ? fileAt(snap, file) ?? '' : def.instructions ?? '',
    instructionsFile: file,
    options: { ...(def.options ?? {}) },
    advanced: { ...(def.advanced ?? {}) },
  };
}

export function resolveEnvironment(
  repo: ValidatedRepo,
  snap: RepoSnapshot,
  envName: string,
  source: { repo: string; pin: Pin },
): ResolvedEnvironment {
  const file = repo.environments.get(envName);
  const env = file?.definition;
  if (!file || !env || !isStartable(repo, envName)) {
    const agentErrors = env
      ? referencedAgents(env).flatMap((name) => repo.agents.get(name)?.errors ?? [])
      : [];
    throw new DefinitionsInvalidError(envName, [...(file?.errors ?? []), ...agentErrors]);
  }

  const agentDefinitions: Record<string, ResolvedAgent> = {};
  for (const name of referencedAgents(env)) {
    const def = repo.agents.get(name)?.definition;
    if (def) agentDefinitions[name] = resolveAgent(def, snap);
  }
  const agents = env.agents.map((a) => ({
    agent: a.agent,
    maxParallel: a.maxParallel ?? 1,
    instructions: a.instructions ?? '',
  }));

  return {
    resolverVersion: RESOLVER_VERSION,
    source: { repo: source.repo, pin: { ...source.pin }, path: file.path },
    name: env.name,
    description: env.description ?? '',
    image: env.image ?? null,
    dockerfile: env.dockerfile ? { path: env.dockerfile, blob: blobAt(snap, env.dockerfile)?.sha ?? '' } : null,
    resources: { cpus: env.resources?.cpus ?? null, memory: env.resources?.memory ?? null },
    repos: env.repos.map((r) => ({
      github: r.github,
      dir: r.dir ?? r.github.split('/')[1],
      branch: r.branch ?? null,
    })),
    orchestrator: {
      agent: env.orchestrator.agent,
      autoWake: env.orchestrator.autoWake ?? true,
      maxAutoTurnsPerHour: env.orchestrator.maxAutoTurnsPerHour ?? 30,
    },
    agents,
    limits: {
      maxWorkers: env.limits?.maxWorkers ?? agents.reduce((sum, a) => sum + a.maxParallel, 0),
      maxAttempts: env.limits?.maxAttempts ?? 2,
    },
    policies: {
      asks: env.policies?.asks ?? 'orchestrator-first',
      publish: env.policies?.publish ?? 'orchestrator',
      draftPullRequests: env.policies?.draftPullRequests ?? true,
      github: { ...DEFAULT_GITHUB_POLICIES, ...definedOnly(env.policies?.github ?? {}) },
    },
    git: { userName: env.git?.userName ?? null, userEmail: env.git?.userEmail ?? null },
    env: { ...(env.env ?? {}) },
    secrets: [...(env.secrets ?? [])],
    agentDefinitions,
  };
}
