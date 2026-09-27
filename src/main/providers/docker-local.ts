/**
 * Local Docker: the engine on this Mac, reached through the discovered
 * docker CLI (docker-discovery.ts). One target, `local`.
 */

import { docker, dockerLocation, dockerProcess } from '../docker-client';
import { classifyHealth, HEALTH_ARGS, HEALTH_TIMEOUT_MS } from './docker-health';
import type { EnvironmentProvider } from './types';

export const LOCAL_TARGET = 'local';

function requireLocal(targetId: string): void {
  if (targetId !== LOCAL_TARGET) throw new Error(`Unknown Local Docker target: ${targetId}`);
}

export const dockerLocalProvider: EnvironmentProvider = {
  kind: 'environment',
  id: 'docker-local',
  label: 'Local Docker',
  targets: () => [{ id: LOCAL_TARGET, label: 'This Mac', host: null }],
  async detail() {
    try {
      const loc = await dockerLocation();
      return `docker CLI at ${loc.path}`;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },
  async health(targetId) {
    requireLocal(targetId);
    return classifyHealth(await docker(HEALTH_ARGS, { timeoutMs: HEALTH_TIMEOUT_MS }), null);
  },
  runner(targetId) {
    requireLocal(targetId);
    return docker;
  },
  spawn(targetId, args) {
    requireLocal(targetId);
    return dockerProcess(args);
  },
};
