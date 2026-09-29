import { describe, expect, it } from 'vitest';
import { resolveEnvironment } from '../../src/harness/definitions/resolve';
import type { Pin } from '../../src/harness/definitions/types';
import { summarize, validateSnapshot } from '../../src/harness/definitions/validate';
import { nameFrom, STARTER_FILES, starterEnvironment, starterFiles } from '../../src/main/home-starter';
import { exampleFiles, snapshotOf } from './definitions-fixtures';

const pin: Pin = { kind: 'tag', name: 'v1.0.0', sha: 'a'.repeat(40) };

describe('the starter Puck home', () => {
  it('is exactly the example home in docs/examples/config-repo, hidden folders included', () => {
    // The single source: a file added to or changed in the example must reach the starter.
    expect(STARTER_FILES).toEqual(exampleFiles());
  });

  it('points its one environment at the picked repository and still validates and resolves', () => {
    const files = starterFiles({ fullName: 'Acme/Web.App', defaultBranch: 'develop' });
    expect(Object.keys(files).filter((p) => p.startsWith('environments/'))).toEqual(['environments/web-app.yaml']);
    const snap = snapshotOf(files);
    const validated = validateSnapshot(snap);
    expect(validated.errors).toEqual([]);
    const { environments, agents } = summarize(validated);
    expect(environments.map((e) => [e.name, e.startable])).toEqual([['web-app', true]]);
    expect(agents.map((a) => a.name).sort()).toEqual(['implementer', 'lead', 'reviewer']);
    const env = resolveEnvironment(validated, snap, 'web-app', { repo: 'me/puck-home', pin });
    expect(env.repos).toEqual([{ github: 'Acme/Web.App', dir: 'web-app', branch: 'develop' }]);
    expect(files['environments/web-app.yaml']).not.toMatch(/your-org|Replace with/);
    expect(files['environments/web-app.yaml']).toContain('# cloned to /workspace/web-app');
  });

  it('keeps a branch name with YAML or replacement characters literal', () => {
    const files = starterFiles({ fullName: 'me/app', defaultBranch: 'feat/$1-#x' });
    expect(files['environments/app.yaml']).toBe(starterEnvironment({ fullName: 'me/app', defaultBranch: 'feat/$1-#x' }).text);
    const snap = snapshotOf(files);
    const validated = validateSnapshot(snap);
    const env = resolveEnvironment(validated, snap, 'app', { repo: 'me/puck-home', pin });
    expect(env.repos[0].branch).toBe('feat/$1-#x');
  });

  it('names the environment after the repository, with a fallback', () => {
    expect(nameFrom('Web.App', 'example')).toBe('web-app');
    expect(nameFrom('--My__Service--', 'example')).toBe('my-service');
    expect(nameFrom('...', 'example')).toBe('example');
    expect(nameFrom('x'.repeat(80), 'example')).toHaveLength(64);
  });
});
