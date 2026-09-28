import { describe, expect, it } from 'vitest';
import { DefinitionsInvalidError, resolveEnvironment } from '../../src/harness/definitions/resolve';
import type { Pin } from '../../src/harness/definitions/types';
import { validateSnapshot } from '../../src/harness/definitions/validate';
import { agentPatch, envPatch, exampleFiles, snapshotOf, type Files } from './definitions-fixtures';

const pin: Pin = { kind: 'tag', name: 'v1.0.0', sha: 'a'.repeat(40) };

function resolve(edit?: (f: Files) => void) {
  const files = exampleFiles();
  edit?.(files);
  const snap = snapshotOf(files);
  return resolveEnvironment(validateSnapshot(snap), snap, 'example', { repo: 'acme/config', pin });
}

describe('resolveEnvironment', () => {
  it('resolves the example: source, defaults, and every referenced agent embedded', () => {
    const files = exampleFiles();
    const env = resolve();
    expect(env.resolverVersion).toBe(1);
    expect(env.source).toEqual({ repo: 'acme/config', pin, path: 'environments/example.yaml' });
    expect(env.image).toBe('node:22-bookworm');
    expect(env.dockerfile).toBeNull();
    expect(env.repos).toEqual([{ github: 'your-org/your-app', dir: 'app', branch: 'main' }]);
    expect(env.orchestrator).toEqual({ agent: 'lead', autoWake: true, maxAutoTurnsPerHour: 30 });
    expect(env.agents).toEqual([
      { agent: 'implementer', maxParallel: 2, instructions: '' },
      { agent: 'reviewer', maxParallel: 1, instructions: 'Review only; never push.' },
    ]);
    expect(Object.keys(env.agentDefinitions)).toEqual(['lead', 'implementer', 'reviewer']);
    // instructionsFile is inlined, and where it came from is kept.
    expect(env.agentDefinitions.lead).toMatchObject({
      harness: 'claude-code',
      instructions: files['prompts/lead.md'],
      instructionsFile: 'prompts/lead.md',
    });
    expect(env.agentDefinitions.implementer.instructionsFile).toBeNull();
    expect(env.agentDefinitions.implementer.options).toEqual({ 'tool.WebSearch': false, maxTurns: 150 });
    expect(env.agentDefinitions.reviewer.model).toBe('auto');
  });

  it('applies every default when the optional fields are absent', () => {
    const env = resolve((f) => {
      envPatch({
        description: undefined,
        resources: undefined,
        repos: [{ github: 'acme/web' }],
        orchestrator: { agent: 'lead' },
        agents: [{ agent: 'implementer', maxParallel: 3 }, { agent: 'reviewer' }],
        limits: undefined,
        policies: undefined,
        git: undefined,
        env: undefined,
        secrets: undefined,
      })(f);
      agentPatch({ description: undefined, model: undefined, effort: undefined, instructions: undefined, options: undefined })(f);
    });
    expect(env).toMatchObject({
      description: '',
      resources: { cpus: null, memory: null },
      repos: [{ github: 'acme/web', dir: 'web', branch: null }],
      orchestrator: { agent: 'lead', autoWake: true, maxAutoTurnsPerHour: 30 },
      agents: [
        { agent: 'implementer', maxParallel: 3, instructions: '' },
        { agent: 'reviewer', maxParallel: 1, instructions: '' },
      ],
      limits: { maxWorkers: 4, maxAttempts: 2 },
      policies: { asks: 'orchestrator-first', publish: 'orchestrator', draftPullRequests: true },
      git: { userName: null, userEmail: null },
      env: {},
      secrets: [],
    });
    expect(env.agentDefinitions.implementer).toEqual({
      name: 'implementer',
      description: '',
      harness: 'claude-code',
      model: 'auto',
      effort: 'auto',
      instructions: '',
      instructionsFile: null,
      options: {},
      advanced: {},
    });
  });

  it('records a Dockerfile by path and blob, so a content change is visible', () => {
    const env = resolve((f) => {
      f['docker/dev.Dockerfile'] = 'FROM node:22\n';
      envPatch({ image: undefined, dockerfile: 'docker/dev.Dockerfile' })(f);
    });
    expect(env.image).toBeNull();
    expect(env.dockerfile).toEqual({ path: 'docker/dev.Dockerfile', blob: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });

  it('refuses an environment whose agent is invalid, listing the agent errors', () => {
    let err: unknown;
    try {
      resolve(agentPatch({ effort: 'ludicrous' }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DefinitionsInvalidError);
    expect((err as DefinitionsInvalidError).errors).toEqual([
      expect.objectContaining({ file: 'agents/implementer.yaml', rule: 'effort' }),
    ]);
    expect((err as Error).message).toMatch(/^Environment "example" is not startable: agents\/implementer\.yaml:\d+:/);
  });

  it('refuses a missing environment', () => {
    const files = exampleFiles();
    const snap = snapshotOf(files);
    expect(() => resolveEnvironment(validateSnapshot(snap), snap, 'nope', { repo: 'acme/config', pin })).toThrow(
      /does not exist/,
    );
  });
});
