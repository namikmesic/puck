/**
 * Target health: `docker version` against one engine, with a failure
 * classified into a problem the user can act on. Over SSH the docker CLI
 * runs the system ssh (no terminal, so no passphrase or host-key prompt)
 * and wraps its stderr into its own error line; the classifier matches the
 * ssh and remote-shell text inside it. Pure: tests feed canned results.
 */

import type { TargetHealth, TargetProblem } from '../../harness/bridge';
import type { DockerResult } from '../docker-client';

/** One health probe per check; a stuck ssh handshake must still answer. */
export const HEALTH_TIMEOUT_MS = 20_000;

export const HEALTH_ARGS = ['version', '--format', '{{.Server.Version}}'];

/** Ordered: the first matching rule wins (socket permission before ssh auth). */
const RULES: ReadonlyArray<{ problem: TargetProblem; remote: boolean | null; re: RegExp }> = [
  { problem: 'docker-cli-missing', remote: null, re: /docker cli not found/i },
  {
    problem: 'socket-permission',
    remote: null,
    re: /permission denied while trying to connect to the docker|docker\.sock: connect: permission denied/i,
  },
  {
    problem: 'host-key',
    remote: true,
    re: /host key verification failed|remote host identification has changed|no \S+ host key is known|host key for \S+ has changed/i,
  },
  {
    problem: 'ssh-auth',
    remote: true,
    re: /permission denied \(|too many authentication failures|no more authentication methods|agent refused operation|could not open a connection to your authentication agent|sign_and_send_pubkey|incorrect passphrase|enter passphrase/i,
  },
  {
    problem: 'docker-missing-remote',
    remote: true,
    re: /docker: (command )?not found|command not found: docker|exit status 127/i,
  },
  // Over SSH a stopped remote engine surfaces as dial-stdio failing on the
  // socket - before the generic connection rules, which would blame ssh.
  {
    problem: 'daemon-down',
    remote: null,
    re: /docker\.sock\S*:? (connect: )?(no such file or directory|connection refused)/i,
  },
  {
    problem: 'ssh-unreachable',
    remote: true,
    re: /could not resolve hostname|connection refused|connection timed out|operation timed out|no route to host|network is unreachable|connection closed by|connection reset by|kex_exchange_identification/i,
  },
  { problem: 'daemon-down', remote: null, re: /cannot connect to the docker daemon|is the docker daemon running/i },
];

/** Last meaningful stderr text, bounded for display. */
function tail(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 240 ? `…${clean.slice(-240)}` : clean;
}

function problemMessage(problem: TargetProblem, where: string | null, stderr: string): string {
  const host = where ?? 'this Mac';
  switch (problem) {
    case 'docker-cli-missing':
      return tail(stderr);
    case 'socket-permission':
      return where
        ? `The SSH user on ${host} cannot use the Docker socket. Add that user to the docker group (sudo usermod -aG docker <user>), then sign in again.`
        : 'This user cannot use the Docker socket. Check the Docker installation’s socket permissions.';
    case 'host-key':
      return `${host}'s SSH host key is not trusted yet, or it changed. Puck cannot answer the prompt: connect once with ssh from Terminal, or set StrictHostKeyChecking accept-new for this host in ~/.ssh/config.`;
    case 'ssh-auth':
      return `SSH sign-in to ${host} failed. Puck connects without a terminal, so the key must be loaded in your ssh agent (ssh-add) and accepted by the host.`;
    case 'docker-missing-remote':
      return `Docker is not on the non-interactive PATH of ${host}. Install Docker there, and check that "ssh ${host} docker version" works.`;
    case 'ssh-unreachable':
      return `Cannot reach ${host} over SSH: ${tail(stderr)}`;
    case 'daemon-down':
      return where
        ? `Docker on ${host} is not responding. Start the Docker service there.`
        : 'Docker is not responding — is Docker running?';
    case 'timeout':
      return where
        ? `No answer from ${host} within ${HEALTH_TIMEOUT_MS / 1000} s. Check that the host is reachable; a stale ssh ControlMaster socket can also hang.`
        : `Docker did not answer within ${HEALTH_TIMEOUT_MS / 1000} s — is Docker running?`;
    case 'unknown':
      return `docker version failed${where ? ` on ${host}` : ''}: ${tail(stderr) || 'no output'}`;
  }
}

/**
 * Classify one `docker version` result. `host` is the remote host for SSH
 * targets, null for the local engine (ssh-only problems never match there).
 */
export function classifyHealth(r: DockerResult, host: string | null): TargetHealth {
  const serverVersion = r.stdout.trim();
  if (r.code === 0 && serverVersion) {
    return { ok: true, detail: `Docker ${serverVersion}`, serverVersion, problem: null };
  }
  let problem: TargetProblem = 'unknown';
  if (r.timedOut) {
    problem = 'timeout';
  } else {
    const remote = host !== null;
    const rule = RULES.find((x) => (x.remote === null || x.remote === remote) && x.re.test(r.stderr));
    if (rule) problem = rule.problem;
  }
  return { ok: false, detail: problemMessage(problem, host, r.stderr), problem };
}
