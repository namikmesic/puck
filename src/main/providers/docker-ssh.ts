/**
 * Docker over SSH: remote engines reached with `docker -H ssh://…`. The
 * docker CLI runs the system ssh and `docker system dial-stdio` on the
 * host, so ~/.ssh/config applies (aliases, IdentityFile, ProxyJump,
 * ControlMaster) and there is no terminal: keys come from the ssh agent and
 * host keys must already be known. Puck never edits ~/.ssh/config. Hosts
 * are provider configuration in puck-providers.json; each is one target.
 */

import { docker, dockerProcess } from '../docker-client';
import { classifyHealth, HEALTH_ARGS, HEALTH_TIMEOUT_MS } from './docker-health';
import { sshHostById, sshHosts, type SshHost } from './providers-store';
import type { EnvironmentProvider } from './types';

function requireHost(targetId: string): SshHost {
  const host = sshHostById(targetId);
  if (!host) throw new Error('Unknown SSH host.');
  return host;
}

export const dockerSshProvider: EnvironmentProvider = {
  kind: 'environment',
  id: 'docker-ssh',
  label: 'Docker over SSH',
  targets: () => sshHosts().map((h) => ({ id: h.id, label: h.label, host: h.host })),
  async detail() {
    const n = sshHosts().length;
    return n === 0 ? 'No hosts yet' : `${n} ${n === 1 ? 'host' : 'hosts'}`;
  },
  async health(targetId) {
    const { host } = requireHost(targetId);
    const r = await docker(HEALTH_ARGS, { host, timeoutMs: HEALTH_TIMEOUT_MS });
    return classifyHealth(r, host);
  },
  runner(targetId) {
    const { host } = requireHost(targetId);
    return (args, opts) => docker(args, { ...opts, host });
  },
  spawn(targetId, args) {
    const { host } = requireHost(targetId);
    return dockerProcess(args, host);
  },
};

