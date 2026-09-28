/**
 * The runner's one door to the docker CLI: argv only (never a shell),
 * timeout-guarded, abortable, line-streaming for long operations, with
 * optional stdin (a tar stream for `docker cp -`, a Dockerfile for
 * `docker build -`). The runner addresses only the engine on its own host,
 * so there is no `-H`.
 *
 * The binary comes from `discovery.ts`, because a service manager starts
 * the runner with a minimal PATH; the resolved location is cached for the
 * process lifetime, and a failed discovery is retried on the next call.
 *
 * `DockerRunner` and `DockerSpawner` are the seams: the docker operations
 * are tested against a recording runner, and the attach relay against a
 * scripted process.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import { discoverDocker, realDiscoveryDeps, type DockerLocation } from './discovery';

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Killed by the timeout guard. */
  timedOut?: boolean;
  /** Killed because the caller's signal aborted. */
  aborted?: boolean;
}

export interface DockerOptions {
  /** Default 20 s: a wedged engine must produce an error, not a hang. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Every complete output line (stdout and stderr) as it arrives. */
  onOutput?: (line: string) => void;
  /** Written to the command's stdin, which is then closed. */
  input?: string | Buffer | Readable;
}

export type DockerRunner = (args: string[], opts?: DockerOptions) => Promise<DockerResult>;

/** Starts a long-lived docker process with piped stdio (the attach relay). */
export type DockerSpawner = (args: string[]) => ChildProcessWithoutNullStreams;

export const DEFAULT_TIMEOUT_MS = 20_000;
const OUTPUT_TAIL = 256_000;
const STDERR_TAIL = 8_000;

let discovery: Promise<DockerLocation> | null = null;
let cachedBinary: string | null = null;

export function dockerLocation(): Promise<DockerLocation> {
  if (!discovery) {
    discovery = discoverDocker(realDiscoveryDeps).then((loc) => {
      cachedBinary = loc.path;
      return loc;
    });
    discovery.catch(() => {
      discovery = null;
    });
  }
  return discovery;
}

/** The CLI's own directory on PATH, so credential helpers and plugins resolve. */
function childEnv(binary: string): NodeJS.ProcessEnv {
  const dir = path.dirname(binary);
  const current = process.env.PATH ?? '';
  if (current.split(path.delimiter).includes(dir)) return process.env;
  return { ...process.env, PATH: current ? `${dir}${path.delimiter}${current}` : dir };
}

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

export const realDocker: DockerRunner = async (args, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let binary: string;
  try {
    binary = (await dockerLocation()).path;
  } catch (err) {
    return { code: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
  if (opts.signal?.aborted) return { code: null, stdout: '', stderr: 'cancelled', aborted: true };
  return new Promise((resolve) => {
    const child = spawn(binary, args, { env: childEnv(binary), stdio: ['pipe', 'pipe', 'pipe'] });
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
    // A command that exits before reading all of its input closes the pipe; that is its answer, not ours.
    child.stdin.on('error', () => undefined);
    const input = opts.input;
    if (input === undefined) child.stdin.end();
    else if (typeof input === 'string' || Buffer.isBuffer(input)) child.stdin.end(input);
    else input.pipe(child.stdin);
    child.on('error', (err) => settle({ code: -1, stdout, stderr: String(err.message) }));
    child.on('close', (code) => {
      if (aborted) settle({ code, stdout, stderr: 'cancelled', aborted: true });
      else if (timedOut) settle({ code, stdout, stderr: `docker ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`, timedOut: true });
      else settle({ code, stdout, stderr });
    });
  });
};

/** Needs a resolved binary: the runner discovers Docker before it relays anything. */
export const realSpawner: DockerSpawner = (args) => {
  const binary = cachedBinary ?? 'docker';
  return spawn(binary, args, { env: childEnv(binary), stdio: ['pipe', 'pipe', 'pipe'] });
};

export class DockerError extends Error {
  constructor(
    message: string,
    readonly result: DockerResult,
  ) {
    super(message);
    this.name = 'DockerError';
  }
}

/** The last meaningful stderr, bounded for a message. */
export function stderrTail(r: DockerResult, max = 400): string {
  const clean = r.stderr.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}
