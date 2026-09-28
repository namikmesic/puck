/**
 * The runner's diagnostic log: `_diag/runner.log` in the runner directory,
 * rotated at 1 MiB, three files kept, every line redacted with the rules
 * the app and the daemon use (src/harness/redact.ts). Log ids, names,
 * states, byte counts and timings. Never log channel content, tokens,
 * credential files or secret values; redaction is the second line of
 * defense, not the first. The daemon's logger is the same shape; the runner
 * keeps its own copy because it may not import daemon code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { redact } from '../harness/redact';

export type LogLevel = 'info' | 'warn' | 'error';

export const LOG_FILE = 'runner.log';
export const LOG_MAX_BYTES = 1024 * 1024;
export const LOG_KEEP = 3;

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, err?: unknown, fields?: Record<string, unknown>): void;
  /** Every existing log file, current first, oldest last. */
  files(): string[];
}

export interface LoggerOptions {
  dir: string;
  maxBytes?: number;
  keep?: number;
  /** Mirror lines to stderr (an interactive ./run.sh). */
  mirror?: boolean;
  now?: () => Date;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const stack = (err.stack ?? '').split('\n').slice(1).map((l) => l.trim());
    return [`${err.name}: ${err.message}`, ...stack].join('\n');
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function createLogger(opts: LoggerOptions): Logger {
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const keep = Math.max(1, Math.floor(opts.keep ?? LOG_KEEP));
  const now = opts.now ?? ((): Date => new Date());
  const file = path.join(opts.dir, LOG_FILE);
  const rotated = (n: number): string => `${file}.${n}`;
  let size: number | null = null;

  function rotate(): void {
    fs.rmSync(rotated(keep - 1), { force: true });
    for (let n = keep - 2; n >= 1; n--) {
      try {
        fs.renameSync(rotated(n), rotated(n + 1));
      } catch {
        // nothing to shift
      }
    }
    if (keep === 1) fs.rmSync(file, { force: true });
    else fs.renameSync(file, rotated(1));
    size = 0;
  }

  function write(level: LogLevel, message: string, err?: unknown, fields?: Record<string, unknown>): void {
    let line = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
    if (fields && Object.keys(fields).length) line += ` ${JSON.stringify(fields)}`;
    if (err !== undefined) line += ` :: ${describeError(err)}`;
    line = redact(line.replace(/\r?\n/g, '\n  ')) + '\n';
    if (opts.mirror) process.stderr.write(line);
    // The log never throws into the runner: a full disk loses the line, not the work.
    try {
      fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
      if (size === null) {
        try {
          size = fs.statSync(file).size;
        } catch {
          size = 0;
        }
      }
      const bytes = Buffer.byteLength(line, 'utf8');
      if (size > 0 && size + bytes > maxBytes) rotate();
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      size = (size ?? 0) + bytes;
    } catch {
      // swallowed on purpose (see above)
    }
  }

  return {
    info: (message, fields) => write('info', message, undefined, fields),
    warn: (message, fields) => write('warn', message, undefined, fields),
    error: (message, err, fields) => write('error', message, err, fields),
    files: () => {
      const all = [file];
      for (let n = 1; n < keep; n++) all.push(rotated(n));
      return all.filter((f) => fs.existsSync(f));
    },
  };
}

/** The last `lines` lines across the rotated files, redacted again on the way out. */
export function tailLog(logger: Logger, lines: number): string {
  const out: string[] = [];
  for (const file of logger.files()) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const fileLines = text.split('\n');
    if (fileLines[fileLines.length - 1] === '') fileLines.pop();
    out.unshift(...fileLines);
    if (out.length >= lines) break;
  }
  return redact(out.slice(-lines).join('\n'));
}

/** A logger that drops everything (tests). */
export const nullLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  files: () => [],
};
