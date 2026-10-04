/**
 * Docker health on the runner host: `docker info`, through the client's
 * failure classification (`failure.ts`), as a problem the user can act on,
 * plus what the heartbeat reports (server version, CPUs, memory). This is
 * the only basis for saying Docker is down; a slow pull or a hung create is
 * not evidence of that. Pure: tests feed classified results.
 */

import type { RunnerDocker } from '../../harness/runner-protocol';
import type { DockerResult, DockerRunner } from './client';
import { classifyStderr, type DockerFailure } from './failure';
import { TIMEOUTS } from './timeouts';

/** One call answers both health and capacity. */
export const INFO_ARGS = ['info', '--format', '{{json .}}'];

export type DockerProblem = 'docker-cli-missing' | 'socket-permission' | 'daemon-down' | 'timeout' | 'unknown';

/** The problem each failure reports; `RunnerDocker.problem` keeps these wire names. */
const PROBLEMS: Record<DockerFailure, DockerProblem> = {
  'cli-missing': 'docker-cli-missing',
  permission: 'socket-permission',
  'daemon-down': 'daemon-down',
  timeout: 'timeout',
  'not-found': 'unknown',
  other: 'unknown',
};

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
      return `Docker did not answer within ${TIMEOUTS.info / 1000} s. Check that the Docker service is healthy.`;
    case 'unknown':
      return `docker info failed: ${tail(stderr) || 'no output'}`;
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Classifies one `docker info --format '{{json .}}'` result. */
export function classifyInfo(r: DockerResult): RunnerDocker {
  if (r.failure) return failed(r.failure, r.stderr);
  try {
    const info = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
    const version = typeof info.ServerVersion === 'string' && info.ServerVersion ? info.ServerVersion.slice(0, 64) : null;
    if (version) return { ok: true, version, problem: null, detail: null, ncpu: num(info.NCPU), memTotal: num(info.MemTotal) };
    // A reachable CLI whose engine did not answer still prints the client half; its errors take the same classifier.
    const errors = Array.isArray(info.ServerErrors) ? info.ServerErrors.join(' ') : '';
    return failed(classifyStderr(errors || r.stderr), errors || r.stderr);
  } catch {
    return failed(classifyStderr(r.stderr), r.stderr);
  }
}

function failed(failure: DockerFailure, stderr: string): RunnerDocker {
  const problem = PROBLEMS[failure];
  return { ok: false, version: null, problem, detail: problemMessage(problem, stderr), ncpu: null, memTotal: null };
}

export async function dockerHealth(docker: DockerRunner): Promise<RunnerDocker> {
  return classifyInfo(await docker(INFO_ARGS, { timeoutMs: TIMEOUTS.info }));
}
