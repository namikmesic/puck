/**
 * Running commands inside the container: argv only (never a shell string
 * built from definition data), an explicit environment, an optional uid/gid
 * to drop to the puck user, a timeout that kills the child process group,
 * and captured output. Provisioning and git go through the `CommandRunner`
 * seam so tests record the exact argv and user of every command instead of
 * running them.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

export interface RunOptions {
  /** Drop to this uid/gid (the puck user); absent = root. */
  uid?: number;
  gid?: number;
  cwd?: string;
  /** The complete environment of the child (nothing is inherited). */
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  /**
   * Write stdout (bytes, uncapped) to this file instead of capturing it.
   * The daemon opens it (mode 0600) as itself, so a child running as the
   * puck user never chooses or opens a root-owned path.
   */
  stdoutTo?: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CommandRunner = (argv: string[], opts?: RunOptions) => Promise<RunResult>;

/** Output kept per stream; provisioning output can be long (npm). */
const MAX_CAPTURE = 256 * 1024;

export const runCommand: CommandRunner = (argv, opts = {}) =>
  new Promise((resolve) => {
    const [cmd, ...args] = argv;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    let sink: fs.WriteStream | null = null;
    try {
      if (opts.stdoutTo) sink = fs.createWriteStream(opts.stdoutTo, { mode: 0o600, flags: 'w' });
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
        uid: opts.uid,
        gid: opts.gid,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      sink?.destroy();
      resolve({ code: null, stdout: '', stderr: (err as Error).message, timedOut: false });
      return;
    }
    const sinkDone = sink
      ? new Promise<string | null>((done) => {
          const s = sink as fs.WriteStream;
          s.on('error', (err) => done(err.message));
          s.on('close', () => done(null));
        })
      : Promise.resolve(null);
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          const pid = child.pid;
          if (pid && pid > 0) {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }
        }, opts.timeoutMs)
      : null;
    if (sink) child.stdout.pipe(sink);
    else {
      child.stdout.on('data', (d: Buffer) => {
        if (stdout.length < MAX_CAPTURE) stdout += d.toString('utf8');
      });
    }
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      stderr += err.message;
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      void sinkDone.then((sinkError) => {
        if (sinkError) resolve({ code: code === 0 ? 1 : code, stdout, stderr: stderr + sinkError, timedOut });
        else resolve({ code, stdout, stderr, timedOut });
      });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? '');
  });

/** The last non-empty lines of a command's output, for error messages. */
export function tailOf(text: string, lines = 5): string {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join('\n');
}
