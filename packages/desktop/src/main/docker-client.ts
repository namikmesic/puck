/**
 * The one place Puck talks to the docker CLI. Argv-based (never a shell),
 * timeout-guarded, and injectable for tests — the environments module's
 * orchestration is characterized against a recording runner.
 */

import { spawn } from 'node:child_process';

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type DockerRunner = (args: string[], timeoutMs?: number) => Promise<DockerResult>;

/** A wedged Docker daemon must produce an error, not a forever-pending UI. */
function spawnDocker(args: string[], timeoutMs = 20_000): Promise<DockerResult> {
  return new Promise((resolve) => {
    const child = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stderr = `docker ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s — is Docker running?`;
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr = (stderr + String(d)).slice(-4000)));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

let runner: DockerRunner = spawnDocker;

/** Test seam: replace the real docker CLI with a scripted/recording runner. */
export function useDockerRunner(fn: DockerRunner): void {
  runner = fn;
}

export function docker(args: string[], timeoutMs?: number): Promise<DockerResult> {
  return runner(args, timeoutMs);
}

/**
 * Run docker and throw with context on failure. Setup steps must not fail
 * silently — a skipped secrets file or credential copy surfaces much later
 * as an opaque provider error inside the container.
 */
export async function dockerOrThrow(
  args: string[],
  what: string,
  timeoutMs?: number,
): Promise<string> {
  const r = await docker(args, timeoutMs);
  if (r.code !== 0) {
    throw new Error(`${what}: ${r.stderr.trim().slice(-400) || `docker ${args[0]} failed`}`);
  }
  return r.stdout;
}
