/**
 * Docker health on the runner host: `docker info` classified into a problem
 * the user can act on, plus what the heartbeat reports (server version,
 * CPUs, memory). This is the only basis for saying Docker is down; a slow
 * pull or a hung create is not evidence of that. Pure: tests feed canned
 * results.
 */

import type { RunnerDocker } from '../../harness/runner-protocol';
import type { DockerResult, DockerRunner } from './client';

export const HEALTH_TIMEOUT_MS = 20_000;

/** One call answers both health and capacity. */
export const INFO_ARGS = ['info', '--format', '{{json .}}'];

export type DockerProblem = 'docker-cli-missing' | 'socket-permission' | 'daemon-down' | 'timeout' | 'unknown';

/** Ordered: the first matching rule wins. */
const RULES: ReadonlyArray<{ problem: DockerProblem; re: RegExp }> = [
  { problem: 'docker-cli-missing', re: /docker cli not found|is set to ".*" but that is not an executable/i },
  {
    problem: 'socket-permission',
    re: /permission denied while trying to connect to the docker|docker\.sock: connect: permission denied/i,
  },
  { problem: 'daemon-down', re: /docker\.sock\S*:? (connect: )?(no such file or directory|connection refused)/i },
  { problem: 'daemon-down', re: /cannot connect to the docker daemon|is the docker daemon running/i },
];

function tail(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 240 ? `…${clean.slice(-240)}` : clean;
}

export function problemMessage(problem: DockerProblem, stderr: string): string {
  switch (problem) {
    case 'docker-cli-missing':
      return tail(stderr);
    case 'socket-permission':
      return 'This user cannot use the Docker socket. Add this user to the docker group (sudo usermod -aG docker $USER, then log in again).';
    case 'daemon-down':
      return 'Docker is not running on this machine. Start the Docker service (or Docker Desktop, or colima) and try again.';
    case 'timeout':
      return `Docker did not answer within ${HEALTH_TIMEOUT_MS / 1000} s. Check that the Docker service is healthy.`;
    case 'unknown':
      return `docker info failed: ${tail(stderr) || 'no output'}`;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Classifies one `docker info --format '{{json .}}'` result. */
export function classifyInfo(r: DockerResult): RunnerDocker {
  if (r.code === 0) {
    try {
      const info = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
      const version = typeof info.ServerVersion === 'string' && info.ServerVersion ? info.ServerVersion.slice(0, 64) : null;
      if (version) return { ok: true, version, problem: null, detail: null, ncpu: num(info.NCPU), memTotal: num(info.MemTotal) };
      // A reachable CLI whose engine did not answer still prints the client half.
      const errors = Array.isArray(info.ServerErrors) ? info.ServerErrors.join(' ') : '';
      return failed({ ...r, stderr: errors || r.stderr });
    } catch {
      return failed(r);
    }
  }
  return failed(r);
}

function failed(r: DockerResult): RunnerDocker {
  let problem: DockerProblem = 'unknown';
  if (r.timedOut) problem = 'timeout';
  else problem = RULES.find((x) => x.re.test(r.stderr))?.problem ?? 'unknown';
  return { ok: false, version: null, problem, detail: problemMessage(problem, r.stderr), ncpu: null, memTotal: null };
}

export async function dockerHealth(docker: DockerRunner): Promise<RunnerDocker> {
  return classifyInfo(await docker(INFO_ARGS, { timeoutMs: HEALTH_TIMEOUT_MS }));
}
