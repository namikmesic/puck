/**
 * The one place Puck talks to the docker CLI. Argv-based (never a shell),
 * timeout-guarded, abortable, line-streaming for long operations, and
 * injectable for tests — the environments module's orchestration is
 * characterized against a recording runner.
 *
 * The binary is located by `docker-discovery.ts` (never the inherited GUI
 * PATH alone); the resolved location is cached for the process lifetime.
 *
 * Only the legacy chat's environments use it: environments started from
 * definitions run on runners, and the app never runs docker for them.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { discoverDocker, realDiscoveryDeps, type DockerLocation } from './docker-discovery';

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The command was killed by the timeout guard. */
  timedOut?: boolean;
  /** The command was killed because the caller's signal aborted. */
  aborted?: boolean;
}

export interface DockerOptions {
  /** Default 20s: a wedged daemon must produce an error, not a forever-pending UI. */
  timeoutMs?: number;
  /** Cancels the command (the child is killed) — used to abandon a start in progress. */
  signal?: AbortSignal;
  /** Receives every complete output line (stdout and stderr) as it arrives. */
  onOutput?: (line: string) => void;
}

export type DockerRunner = (args: string[], opts?: DockerOptions) => Promise<DockerResult>;

export const DEFAULT_TIMEOUT_MS = 20_000;

/** Output kept per stream — enough for diagnostics, bounded for long builds. */
const OUTPUT_TAIL = 64_000;
const STDERR_TAIL = 4_000;

/* ---------- Binary discovery (memoized) ---------- */

let discovery: Promise<DockerLocation> | null = null;
let cachedBinary: string | null = null;
let lastDiscoveryError: string | null = null;

export function dockerLocation(): Promise<DockerLocation> {
  if (!discovery) {
    discovery = discoverDocker(realDiscoveryDeps).then((loc) => {
      cachedBinary = loc.path;
      lastDiscoveryError = null;
      return loc;
    });
    // A failed discovery must not be cached forever: the user may install
    // Docker while the app is open.
    discovery.catch((err: unknown) => {
      discovery = null;
      lastDiscoveryError = err instanceof Error ? err.message : String(err);
    });
  }
  return discovery;
}

/**
 * What discovery has found so far, without starting one (a failed discovery
 * re-probes the login shell, too slow for status reads): the binary, the
 * last failure, or neither while no discovery has finished yet.
 */
export function dockerLocationKnown(): { path: string | null; error: string | null } {
  return { path: cachedBinary, error: cachedBinary ? null : lastDiscoveryError };
}

/** Synchronous accessor for code paths that cannot await (the runner exec spawner). */
export function dockerBinaryCached(): string {
  return cachedBinary ?? 'docker';
}

/** Child env: the CLI's own directory on PATH so credential helpers and plugins resolve. */
function childEnv(binary: string): NodeJS.ProcessEnv {
  const dir = path.dirname(binary);
  const current = process.env.PATH ?? '';
  if (current.split(path.delimiter).includes(dir)) return process.env;
  return { ...process.env, PATH: current ? `${dir}${path.delimiter}${current}` : dir };
}

/** Spawn a docker process directly (stdio bridge use); the binary must have been resolved before. */
export function dockerProcess(args: string[]): ChildProcessWithoutNullStreams {
  const binary = dockerBinaryCached();
  return spawn(binary, args, { env: childEnv(binary) });
}

/* ---------- Running commands ---------- */

/** Splits streamed chunks into complete lines; `\r` progress redraws count as line breaks. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let idx: number;
      while ((idx = buf.search(/[\r\n]/)) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
    },
    flush() {
      if (buf.trim()) onLine(buf);
      buf = '';
    },
  };
}

async function spawnDocker(args: string[], opts: DockerOptions = {}): Promise<DockerResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let binary: string;
  try {
    binary = (await dockerLocation()).path;
  } catch (err) {
    return { code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
  if (opts.signal?.aborted) {
    return { code: null, stdout: '', stderr: 'cancelled', aborted: true };
  }
  return new Promise((resolve) => {
    const child = spawn(binary, args, { env: childEnv(binary) });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const lines = opts.onOutput ? lineSplitter(opts.onOutput) : null;
    const onAbort = (): void => {
      aborted = true;
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const settle = (result: DockerResult): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      lines?.flush();
      resolve(result);
    };
    child.stdout.on('data', (d) => {
      const text = String(d);
      stdout = (stdout + text).slice(-OUTPUT_TAIL);
      lines?.push(text);
    });
    child.stderr.on('data', (d) => {
      const text = String(d);
      stderr = (stderr + text).slice(-STDERR_TAIL);
      lines?.push(text);
    });
    child.on('error', (err) => settle({ code: -1, stdout, stderr: String(err.message) }));
    child.on('close', (code) => {
      if (aborted) {
        settle({ code, stdout, stderr: 'cancelled', aborted: true });
      } else if (timedOut) {
        const seconds = Math.round(timeoutMs / 1000);
        settle({ code, stdout, stderr: `docker ${args[0]} timed out after ${seconds}s`, timedOut: true });
      } else {
        settle({ code, stdout, stderr });
      }
    });
  });
}

let runner: DockerRunner = spawnDocker;

/** Test seam: replace the real docker CLI with a scripted/recording runner. */
export function useDockerRunner(fn: DockerRunner): void {
  runner = fn;
}

export function docker(args: string[], opts?: DockerOptions): Promise<DockerResult> {
  return runner(args, opts);
}

/**
 * Run docker and throw with context on failure. Setup steps must not fail
 * silently — a skipped secrets file or credential copy surfaces much later
 * as an opaque provider error inside the container.
 */
export async function dockerOrThrow(
  args: string[],
  what: string,
  opts?: DockerOptions,
): Promise<string> {
  const r = await docker(args, opts);
  if (r.code !== 0) {
    throw new Error(`${what}: ${r.stderr.trim().slice(-400) || `docker ${args[0]} failed`}`);
  }
  return r.stdout;
}

/**
 * Daemon health check — the ONLY basis for an "is Docker running?" message.
 * A slow pull or a hung `docker run` is not evidence that the daemon is down.
 */
export async function dockerHealth(): Promise<{ ok: boolean; message: string }> {
  const r = await docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 10_000 });
  if (r.code === 0 && r.stdout.trim()) return { ok: true, message: `Docker ${r.stdout.trim()}` };
  const why = r.stderr.trim().slice(-300) || 'docker info returned no server version';
  return { ok: false, message: `Docker is not responding (${why}) — is Docker running?` };
}
