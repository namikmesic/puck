/**
 * Local Docker: the engine on this Mac, reached through the discovered
 * docker CLI (docker-discovery.ts). One target, `local`.
 */

import { docker, dockerLocationKnown, dockerProcess } from '../docker-client';
import { classifyHealth, HEALTH_ARGS, HEALTH_TIMEOUT_MS } from './docker-health';
import type { EnvironmentProvider } from './types';

export const LOCAL_TARGET = 'local';

function requireLocal(target: string): void {
  if (target !== LOCAL_TARGET) throw new Error(`Unknown Local Docker target: ${target}`);
}

export const dockerLocalProvider: EnvironmentProvider = {
  kind: 'environment',
  id: 'docker-local',
  label: 'Local Docker',
  targets: () => [{ id: LOCAL_TARGET, label: 'This Mac', host: null }],
  status() {
    const known = dockerLocationKnown();
    if (known.path) return { state: 'connected', detail: `docker CLI at ${known.path}` };
    if (known.error) return { state: 'error', detail: known.error };
    return { state: 'pending', detail: 'Locating the docker CLI… (Check runs the search)' };
  },
  async health(target) {
    requireLocal(target);
    return classifyHealth(await docker(HEALTH_ARGS, { timeoutMs: HEALTH_TIMEOUT_MS }), null);
  },
  runner(target) {
    requireLocal(target);
    return docker;
  },
  spawn(target, args) {
    requireLocal(target);
    return dockerProcess(args);
  },
};
