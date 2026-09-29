/**
 * Definition updates for a running environment: the check diffs the
 * definition at both commits; applying a hot change goes to the attached
 * daemon and interrupts nothing, and a change that needs a new container
 * rebuilds it at the new pin.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Pin } from '../../src/harness/daemon-protocol';
import { resolveEnvironment } from '../../src/harness/definitions/resolve';
import type { PinSpec, ResolvedEnvironment } from '../../src/harness/definitions/types';
import { validateSnapshot } from '../../src/harness/definitions/validate';
import { applyUpdate, checkUpdate, upgradeDaemon, type UpdateDeps } from '../../src/main/instances/update';
import { exampleFiles, snapshotOf } from './definitions-fixtures';

const ENV = 'env_01J8Z3X0000000000000000000';
const OLD: Pin = { kind: 'tag', name: 'v1.0.0', sha: 'a'.repeat(40) };
const NEW: Pin = { kind: 'tag', name: 'v1.1.0', sha: 'b'.repeat(40) };

function resolved(pin: Pin, edit?: (env: ResolvedEnvironment) => void): ResolvedEnvironment {
  const snap = snapshotOf(exampleFiles(), pin.sha);
  const env = resolveEnvironment(validateSnapshot(snap), snap, 'example', { repo: 'acme/config', pin });
  edit?.(env);
  return env;
}

function deps(edit: (env: ResolvedEnvironment) => void) {
  const byCommit: Record<string, ResolvedEnvironment> = { [OLD.sha]: resolved(OLD), [NEW.sha]: resolved(NEW, edit) };
  const d = {
    pin: vi.fn(() => OLD),
    definition: vi.fn(() => 'example'),
    check: vi.fn(async () => ({ pin: NEW })),
    resolve: vi.fn(async (spec: PinSpec) => byCommit[spec.kind === 'commit' ? spec.name : NEW.sha] as ResolvedEnvironment),
    apply: vi.fn(async () => undefined),
    rebuild: vi.fn(async () => undefined),
    applied: vi.fn(),
  } satisfies UpdateDeps;
  return d;
}

const bumpParallel = (env: ResolvedEnvironment): void => {
  const first = env.agents[0];
  if (first) first.maxParallel += 1;
};

describe('definition updates', () => {
  it('reports the newer pin with its changes grouped by how they apply', async () => {
    const d = deps(bumpParallel);
    const update = await checkUpdate(ENV, d);
    expect(update?.pin).toEqual(NEW);
    expect(update?.changes.hot.map((c) => c.field)).toEqual([expect.stringMatching(/^agents\[.+\]\.maxParallel$/)]);
    expect(update?.changes.rebuild).toEqual([]);
    // Both sides resolve at their exact commit.
    expect(d.resolve.mock.calls.map((c) => c[0])).toEqual([
      { kind: 'commit', name: OLD.sha },
      { kind: 'commit', name: NEW.sha },
    ]);
    d.check.mockResolvedValueOnce(null as never);
    expect(await checkUpdate(ENV, d)).toBeNull();
    d.pin.mockReturnValueOnce(null as never);
    expect(await checkUpdate(ENV, d)).toBeNull();
  });

  it('applies a hot change through the daemon and records the new pin', async () => {
    const d = deps(bumpParallel);
    expect(await applyUpdate(ENV, { kind: 'tag', name: 'v1.1.0' }, d)).toBe('hot');
    expect(d.apply).toHaveBeenCalledWith(ENV, expect.objectContaining({ source: expect.objectContaining({ pin: NEW }) }));
    expect(d.rebuild).not.toHaveBeenCalled();
    expect(d.applied).toHaveBeenCalledTimes(1);
  });

  it('rebuilds for a change a running container cannot take', async () => {
    const d = deps((env) => {
      env.image = 'node:24-bookworm';
    });
    expect(await applyUpdate(ENV, { kind: 'tag', name: 'v1.1.0' }, d)).toBe('rebuild');
    expect(d.rebuild).toHaveBeenCalledTimes(1);
    expect(d.apply).not.toHaveBeenCalled();
  });

  it('keeps the old pin when the daemon refuses', async () => {
    const d = deps(bumpParallel);
    d.apply.mockRejectedValueOnce(new Error('Open this environment and wait until it is connected, then apply the update.'));
    await expect(applyUpdate(ENV, { kind: 'tag', name: 'v1.1.0' }, d)).rejects.toThrow(/wait until it is connected/);
    expect(d.applied).not.toHaveBeenCalled();
  });
});

describe('daemon upgrades', () => {
  it('stages the bundle on the runner before asking the daemon to swap it in', async () => {
    const calls: string[] = [];
    await upgradeDaemon(ENV, 'now', {
      runnerOf: () => 'rnr_1',
      upload: async (runnerId) => {
        calls.push(`upload ${runnerId}`);
        return 'sha1';
      },
      stage: async (runnerId, envId, sha) => void calls.push(`stage ${runnerId} ${envId} ${sha}`),
      upgrade: async (envId, mode) => void calls.push(`upgrade ${envId} ${mode}`),
    });
    expect(calls).toEqual(['upload rnr_1', `stage rnr_1 ${ENV} sha1`, `upgrade ${ENV} now`]);
  });
});
