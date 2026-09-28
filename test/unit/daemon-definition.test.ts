import { describe, expect, it } from 'vitest';
import { readDefinition, referencedHarnesses, validBranch } from '../../src/daemon/definition';
import { exampleDefinition } from './daemon-fakes';

describe('daemon definition reader', () => {
  it('reads a resolved definition with defaults applied', () => {
    const r = readDefinition(exampleDefinition());
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toMatchObject({
      name: 'example',
      repos: [{ github: 'octo/app', dir: 'app', branch: 'main' }],
      orchestrator: { agent: 'lead', autoWake: true, maxAutoTurnsPerHour: 30 },
      agents: [
        { agent: 'implementer', maxParallel: 2, instructions: 'Stay in scope.' },
        { agent: 'reviewer', maxParallel: 1, instructions: '' },
      ],
      limits: { maxWorkers: 3, maxAttempts: 2 },
      policies: { asks: 'orchestrator-first', publish: 'orchestrator', draftPullRequests: true },
      env: { NODE_ENV: 'development' },
      secrets: ['NPM_TOKEN'],
    });
    expect(r.value.agentDefs.lead).toMatchObject({ harness: 'claude-code', effort: 'high', model: 'auto' });
    expect(referencedHarnesses(r.value).sort()).toEqual(['claude-code', 'codex']);
  });

  it('accepts agent definitions embedded on their assignment', () => {
    const r = readDefinition(
      exampleDefinition({
        agentDefinitions: undefined,
        orchestrator: { agent: 'lead', definition: { harness: 'claude-code' } },
        agents: [{ agent: 'lead', definition: { harness: 'claude-code' } }],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it.each([
    ['a repo name that could inject options', { repos: [{ github: '-oops/x' }] }, /Invalid repo/],
    ['a directory with a path separator', { repos: [{ github: 'o/r', dir: '../etc' }] }, /Invalid repo directory/],
    ['a duplicated directory', { repos: [{ github: 'o/a', dir: 'x' }, { github: 'p/b', dir: 'x' }] }, /Two repos/],
    ['a branch that looks like an option', { repos: [{ github: 'o/r', branch: '--upload-pack=x' }] }, /Invalid branch/],
    ['a reserved env name', { env: { PUCK_TOKEN: 'x' } }, /Invalid environment variable/],
    ['a non-Claude orchestrator', { orchestrator: { agent: 'reviewer' } }, /must use Claude Code/],
    ['a missing agent definition', { agents: [{ agent: 'ghost' }] }, /"ghost" is not embedded/],
    ['an unknown harness', { agentDefinitions: { lead: { harness: 'gemini' } } }, /unknown harness/],
    ['no repos', { repos: [] }, /no repos/],
  ])('rejects %s', (_label, over, message) => {
    const r = readDefinition(exampleDefinition(over as Record<string, unknown>));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it('checks branch names used as git arguments', () => {
    for (const ok of ['main', 'release/1.2', 'feat_x-1']) expect(validBranch(ok)).toBe(true);
    for (const bad of ['-x', 'a..b', '/abs', 'x.lock', 'a b', 'a//b']) expect(validBranch(bad)).toBe(false);
  });
});
