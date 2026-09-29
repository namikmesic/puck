/**
 * Definition updates for a running environment.
 *
 * Check: the environment's pin has a newer commit (its branch moved) or a
 * newer semver tag exists; the definition is resolved at both commits and
 * diffed, so the apply dialog can say what each change does.
 *
 * Apply: resolve the definition at the chosen pin. Hot and reprovision
 * changes go to the attached daemon as `definition.apply` (the daemon
 * applies them in place and interrupts nothing that runs); a change that
 * needs a new container rebuilds it at the new pin, keeping the volumes.
 * The pin the app remembers moves only once the daemon or the rebuild took
 * the new definition.
 */

import type { InstanceUpdate } from '../../harness/bridge';
import type { Pin } from '../../harness/daemon-protocol';
import { diffEnvironments, groupByClass, updateClass } from '../../harness/definitions/diff';
import type { PinSpec, ResolvedEnvironment, UpdateInfo } from '../../harness/definitions/types';

export interface UpdateDeps {
  /** The pin the environment runs, as this app last recorded it. */
  pin(envId: string): Pin | null;
  /** The environment definition's name. */
  definition(envId: string): string;
  check(pin: Pin): Promise<UpdateInfo | null>;
  resolve(spec: PinSpec, name: string): Promise<ResolvedEnvironment>;
  /** `definition.apply` on the attached daemon; throws when it is not attached. */
  apply(envId: string, def: ResolvedEnvironment): Promise<void>;
  /** Rebuild the container from `def`. */
  rebuild(envId: string, def: ResolvedEnvironment): Promise<void>;
  /** The environment now runs `def`. */
  applied(envId: string, def: ResolvedEnvironment): void;
}

/** The exact commit a pin runs (a branch name would resolve to its newest head). */
const atCommit = (pin: Pin): PinSpec => ({ kind: 'commit', name: pin.sha });

export async function checkUpdate(envId: string, deps: UpdateDeps): Promise<InstanceUpdate | null> {
  const pin = deps.pin(envId);
  if (!pin) return null;
  const found = await deps.check(pin);
  if (!found) return null;
  const name = deps.definition(envId);
  const [prev, next] = await Promise.all([deps.resolve(atCommit(pin), name), deps.resolve(atCommit(found.pin), name)]);
  return { pin: found.pin, changes: groupByClass(diffEnvironments(prev, next)) };
}

export interface DaemonUpgradeDeps {
  runnerOf(envId: string): string;
  /** The app's daemon bundle into the runner's cache; its sha. */
  upload(runnerId: string): Promise<string>;
  stage(runnerId: string, envId: string, bundleSha: string): Promise<void>;
  /** `daemon.upgrade` on the attached daemon; throws when it is not attached. */
  upgrade(envId: string, mode: 'drain' | 'now'): Promise<void>;
}

/** The runner stages the app's daemon bundle beside the running one, then the daemon swaps it in. */
export async function upgradeDaemon(envId: string, mode: 'drain' | 'now', deps: DaemonUpgradeDeps): Promise<void> {
  const runnerId = deps.runnerOf(envId);
  const sha = await deps.upload(runnerId);
  await deps.stage(runnerId, envId, sha);
  await deps.upgrade(envId, mode);
}

export async function applyUpdate(envId: string, spec: PinSpec, deps: UpdateDeps): Promise<'hot' | 'reprovision' | 'rebuild' | 'none'> {
  const name = deps.definition(envId);
  const next = await deps.resolve(spec, name);
  const pin = deps.pin(envId);
  const prev = pin ? await deps.resolve(atCommit(pin), name) : null;
  const cls = prev ? updateClass(diffEnvironments(prev, next)) : 'rebuild';
  if (cls === 'rebuild') {
    await deps.rebuild(envId, next);
  } else {
    await deps.apply(envId, next);
  }
  deps.applied(envId, next);
  return cls ?? 'none';
}
