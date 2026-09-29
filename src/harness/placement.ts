/**
 * Whether an environment may be placed on a runner: the start flow's
 * runner picker and its preflight both ask here, so they agree. A runner
 * must be online with Docker healthy, below its maximum number of
 * environments, and large enough for the definition's `resources`.
 */

import type { RunnerDockerInfo, RunnerStatusWord } from './server-api';

export interface PlacementRunner {
  name: string;
  status: RunnerStatusWord;
  docker: RunnerDockerInfo | null;
  maxEnvironments: number | null;
  keyChanged?: boolean;
}

export interface PlacementResult {
  ok: boolean;
  /** Why not, in words; null when it fits. */
  reason: string | null;
}

/** Docker memory notation (`512m`, `8g`, `1.5g`, bytes) in bytes, or null. */
export function memoryBytes(text: string | null | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec((text ?? '').trim());
  if (!m) return null;
  const unit = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as '' | 'b' | 'k' | 'm' | 'g'];
  return Math.round(Number(m[1]) * unit);
}

export function placement(
  runner: PlacementRunner,
  hosted: number,
  resources: { cpus: number | null; memory: string | null },
): PlacementResult {
  const no = (reason: string): PlacementResult => ({ ok: false, reason });
  if (runner.keyChanged) return no(`${runner.name}'s key changed; Puck will not use it until it is registered again.`);
  if (runner.status === 'offline') return no(`${runner.name} is offline.`);
  if (runner.docker && !runner.docker.ok) return no(`Docker is not working on ${runner.name}.`);
  if (runner.maxEnvironments !== null && hosted >= runner.maxEnvironments) {
    return no(`${runner.name} already hosts its maximum of ${runner.maxEnvironments} environments.`);
  }
  const cpus = runner.docker?.ncpu ?? null;
  if (resources.cpus !== null && cpus !== null && resources.cpus > cpus) {
    return no(`The environment asks for ${resources.cpus} CPUs; ${runner.name} has ${cpus}.`);
  }
  const want = memoryBytes(resources.memory);
  const have = runner.docker?.memTotal ?? null;
  if (want !== null && have !== null && want > have) {
    return no(`The environment asks for ${resources.memory} of memory; ${runner.name} has ${(have / 1024 ** 3).toFixed(1)} GB.`);
  }
  return { ok: true, reason: null };
}
