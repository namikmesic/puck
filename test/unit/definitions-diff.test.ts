import { describe, expect, it } from 'vitest';
import {
  AGENT_FIELD_CLASSES,
  ASSIGNMENT_FIELD_CLASSES,
  diffEnvironments,
  ENVIRONMENT_FIELD_CLASSES,
  groupByClass,
  REPO_FIELD_CLASSES,
  updateClass,
} from '../../src/harness/definitions/diff';
import { resolveEnvironment } from '../../src/harness/definitions/resolve';
import type { ResolvedEnvironment, UpdateClass } from '../../src/harness/definitions/types';
import { validateSnapshot } from '../../src/harness/definitions/validate';
import { exampleFiles, snapshotOf } from './definitions-fixtures';

function base(): ResolvedEnvironment {
  const snap = snapshotOf(exampleFiles());
  return resolveEnvironment(validateSnapshot(snap), snap, 'example', {
    repo: 'acme/config',
    pin: { kind: 'tag', name: 'v1.0.0', sha: 'a'.repeat(40) },
  });
}

function diff(edit: (env: ResolvedEnvironment) => void) {
  const prev = base();
  const next = structuredClone(prev);
  edit(next);
  return diffEnvironments(prev, next);
}

/** A different value of the same shape. */
function other(value: unknown): unknown {
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'string') return `${value}-changed`;
  if (value === null) return 'set';
  if (Array.isArray(value)) return [...value, 'x'];
  return { ...(value as object), changed: true };
}

function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const keys = dotted.split('.');
  let node = obj;
  for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>;
  node[keys[keys.length - 1]] = value;
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], obj);
}

describe('diffEnvironments: every field has its update class', () => {
  it('the tables cover every field of a resolved environment and agent', () => {
    const env = base();
    const scalarPaths: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      if (['resolverVersion', 'source', 'name', 'repos', 'agents', 'agentDefinitions', 'env', 'secrets'].includes(k)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'dockerfile') {
        for (const [sub, w] of Object.entries(v)) {
          // policies.github is one more level of scalars.
          if (w && typeof w === 'object' && !Array.isArray(w)) for (const leaf of Object.keys(w)) scalarPaths.push(`${k}.${sub}.${leaf}`);
          else scalarPaths.push(`${k}.${sub}`);
        }
      } else scalarPaths.push(k);
    }
    expect(scalarPaths.sort()).toEqual(Object.keys(ENVIRONMENT_FIELD_CLASSES).sort());
    expect(Object.keys(env.agentDefinitions.lead).filter((k) => k !== 'name').sort()).toEqual(
      Object.keys(AGENT_FIELD_CLASSES).sort(),
    );
  });

  for (const [field, cls] of Object.entries(ENVIRONMENT_FIELD_CLASSES)) {
    it(`${field} → ${cls}`, () => {
      const changes = diff((env) => setPath(env as unknown as Record<string, unknown>, field, other(getPath(env, field))));
      expect(changes).toEqual([expect.objectContaining({ field, class: cls })]);
    });
  }

  for (const [field, cls] of Object.entries(AGENT_FIELD_CLASSES)) {
    it(`agent ${field} → ${cls}`, () => {
      const changes = diff((env) => {
        const agent = env.agentDefinitions.reviewer as unknown as Record<string, unknown>;
        agent[field] = other(agent[field]);
      });
      expect(changes).toEqual([expect.objectContaining({ field: `agentDefinitions.reviewer.${field}`, class: cls })]);
    });
  }

  const cases: Array<[string, UpdateClass, (env: ResolvedEnvironment) => void]> = [
    ['add a repo', REPO_FIELD_CLASSES.added, (env) => env.repos.push({ github: 'acme/api', dir: 'api', branch: null })],
    ['remove a repo', REPO_FIELD_CLASSES.removed, (env) => env.repos.pop()],
    ['repo dir', REPO_FIELD_CLASSES.dir, (env) => (env.repos[0].dir = 'app-2')],
    ['repo branch', REPO_FIELD_CLASSES.branch, (env) => (env.repos[0].branch = 'develop')],
    ['assign an agent', ASSIGNMENT_FIELD_CLASSES.added, (env) => env.agents.push({ agent: 'lead', maxParallel: 1, instructions: '' })],
    ['unassign an agent', ASSIGNMENT_FIELD_CLASSES.removed, (env) => env.agents.pop()],
    ['maxParallel', ASSIGNMENT_FIELD_CLASSES.maxParallel, (env) => (env.agents[0].maxParallel = 1)],
    ['assignment instructions', ASSIGNMENT_FIELD_CLASSES.instructions, (env) => (env.agents[1].instructions = 'Be strict.')],
    ['add an env var', 'hot', (env) => (env.env.CI = '1')],
    ['change an env var', 'hot', (env) => (env.env.NODE_ENV = 'test')],
    ['remove an env var', 'hot', (env) => delete env.env.NODE_ENV],
    ['add a secret', 'hot', (env) => env.secrets.push('NPM_TOKEN')],
  ];
  for (const [name, cls, edit] of cases) {
    it(`${name} → ${cls}`, () => {
      const changes = diff(edit);
      expect(changes).toHaveLength(1);
      expect(changes[0].class).toBe(cls);
    });
  }

  it('removing a secret is hot', () => {
    const prev = base();
    prev.secrets = ['NPM_TOKEN'];
    const next = structuredClone(prev);
    next.secrets = [];
    expect(diffEnvironments(prev, next)).toEqual([expect.objectContaining({ field: 'secrets.NPM_TOKEN', class: 'hot' })]);
  });
});

describe('diffEnvironments: identity', () => {
  it('no change, a reordered list, or a new pin is not a change', () => {
    expect(diff(() => undefined)).toEqual([]);
    expect(diff((env) => env.agents.reverse())).toEqual([]);
    expect(diff((env) => (env.source.pin = { kind: 'tag', name: 'v2.0.0', sha: 'b'.repeat(40) }))).toEqual([]);
  });

  it('a newly referenced agent named like an Object prototype member is only an assignment', () => {
    const changes = diff((env) => {
      env.agents.push({ agent: 'constructor', maxParallel: 1, instructions: '' });
      env.agentDefinitions.constructor = { ...structuredClone(env.agentDefinitions.reviewer), name: 'constructor' };
    });
    expect(changes).toEqual([expect.objectContaining({ field: 'agents[constructor]', class: 'hot' })]);
    expect(updateClass(changes)).toBe('hot');
  });

  it('an env var named like an Object prototype member reads as absent before it is added', () => {
    const [change] = diff((env) => (env.env.constructor = '1'));
    expect(change).toEqual(expect.objectContaining({ field: 'env.constructor', class: 'hot', summary: 'env.constructor: (default) → "1"' }));
  });

  it('a repo is matched by its GitHub name, ignoring case', () => {
    expect(diff((env) => (env.repos[0].github = 'Your-Org/Your-App'))).toEqual([]);
  });

  it('option maps compare by content, not key order', () => {
    expect(
      diff((env) => {
        const o = env.agentDefinitions.implementer.options;
        env.agentDefinitions.implementer.options = Object.fromEntries(Object.entries(o).reverse());
      }),
    ).toEqual([]);
  });
});

describe('updateClass and groupByClass', () => {
  it('the strongest class wins; nothing changed is null', () => {
    const changes = diff((env) => {
      env.description = 'new';
      env.git.userName = 'bot';
      env.image = 'node:24';
    });
    expect(updateClass(changes)).toBe('rebuild');
    expect(updateClass(changes.filter((c) => c.class !== 'rebuild'))).toBe('reprovision');
    expect(updateClass([])).toBeNull();
    const grouped = groupByClass(changes);
    expect(grouped.hot.map((c) => c.field)).toEqual(['description']);
    expect(grouped.reprovision.map((c) => c.field)).toEqual(['git.userName']);
    expect(grouped.rebuild.map((c) => c.field)).toEqual(['image']);
  });

  it('summaries read as before → after', () => {
    const [change] = diff((env) => (env.agents[0].maxParallel = 3));
    expect(change.summary).toBe('agents[implementer].maxParallel: 2 → 3');
  });
});
