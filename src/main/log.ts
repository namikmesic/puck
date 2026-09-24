/**
 * Persistent diagnostic log (main process).
 *
 * Lifecycle events and errors go to a rotating file under userData/logs,
 * so a failure from an earlier session can still be read today and shipped
 * in a support bundle. Bounded: at most `keep` files of `maxBytes` each.
 * Redacted: every line passes through `redact`, which scrubs token shapes
 * and secret-looking key/value pairs. Callers still never hand the logger a
 * credential, a prompt, or a transcript; redaction is the second line of
 * defense, not the first.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export const LOG_FILE = 'puck.log';
/** One megabyte per file, three files: the log can never exceed 3 MiB. */
export const LOG_MAX_BYTES = 1024 * 1024;
export const LOG_KEEP = 3;

export interface LoggerOptions {
  dir: string;
  maxBytes?: number;
  /** Total files kept, the current one included (at least 1). */
  keep?: number;
  /** Mirror warn/error lines to the console (dev terminal, CI output). */
  mirror?: boolean;
  now?: () => Date;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, err?: unknown, fields?: Record<string, unknown>): void;
  /** The current log file. */
  file(): string;
  /** Every existing log file, current first, oldest last. */
  files(): string[];
}

/* ---------- Redaction ---------- */

// `key: value` / `"key": "value"` / `key=value` where the key smells like a
// credential. The value is replaced, the key stays so the line remains useful.
const SECRET_KV =
  /("?)([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|credential|cookie)[A-Za-z0-9_.-]*)("?\s*[:=]\s*)((?:Bearer\s+)?(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}\]]+))/gi;

const SECRET_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  // Anthropic / OpenAI style API keys (`sk-ant-...`, `sk-proj-...`, `sk-...`).
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]'],
  // Any long opaque blob: OAuth access and refresh tokens have no fixed prefix.
  // Docker ids (64 hex) fall under this too, which is an acceptable loss.
  [/[A-Za-z0-9_+=-]{48,}/g, '[redacted-long]'],
];

/** Scrubs credential-looking material from a line of text. */
export function redact(text: string): string {
  let out = text.replace(SECRET_KV, '$1$2$3[redacted]');
  for (const [shape, replacement] of SECRET_SHAPES) out = out.replace(shape, replacement);
  return out;
}

/* ---------- Formatting ---------- */

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const head = `${err.name}: ${err.message}`;
    const stack = (err.stack ?? '').split('\n').slice(1).map((l) => l.trim());
    return [head, ...stack].join('\n');
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function formatLine(
  now: Date,
  level: LogLevel,
  message: string,
  err: unknown,
  fields: Record<string, unknown> | undefined,
): string {
  let line = `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (fields && Object.keys(fields).length) line += ` ${JSON.stringify(fields)}`;
  if (err !== undefined) line += ` :: ${describeError(err)}`;
  // Continuation lines (stack frames) stay indented so a reader can tell
  // one record from the next; the record itself is redacted as a whole.
  return redact(line.replace(/\r?\n/g, '\n  ')) + '\n';
}

/* ---------- Rotating file writer ---------- */

export function createLogger(opts: LoggerOptions): Logger {
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  const keep = Math.max(1, Math.floor(opts.keep ?? LOG_KEEP));
  const now = opts.now ?? ((): Date => new Date());
  const file = path.join(opts.dir, LOG_FILE);
  const rotated = (n: number): string => `${file}.${n}`;
  /** Bytes in the current file; null until the first write measures it. */
  let size: number | null = null;

  const rename = (from: string, to: string): void => {
    try {
      fs.renameSync(from, to);
    } catch {
      // nothing at `from` - fine
    }
  };

  function rotate(): void {
    if (keep === 1) {
      fs.rmSync(file, { force: true });
    } else {
      fs.rmSync(rotated(keep - 1), { force: true });
      for (let n = keep - 2; n >= 1; n--) rename(rotated(n), rotated(n + 1));
      rename(file, rotated(1));
    }
    size = 0;
  }

  function write(level: LogLevel, message: string, err?: unknown, fields?: Record<string, unknown>): void {
    const line = formatLine(now(), level, message, err, fields);
    if (opts.mirror && level !== 'info') {
      (level === 'error' ? console.error : console.warn)(line.trimEnd());
    }
    // Logging must never throw into the app: a full disk or a read-only
    // userData loses the line, not the session.
    try {
      fs.mkdirSync(opts.dir, { recursive: true });
      if (size === null) {
        try {
          size = fs.statSync(file).size;
        } catch {
          size = 0;
        }
      }
      const bytes = Buffer.byteLength(line, 'utf8');
      if (size > 0 && size + bytes > maxBytes) rotate();
      fs.appendFileSync(file, line, 'utf8');
      size = (size ?? 0) + bytes;
    } catch {
      // swallowed on purpose (see above)
    }
  }

  return {
    info: (message, fields) => write('info', message, undefined, fields),
    warn: (message, fields) => write('warn', message, undefined, fields),
    error: (message, err, fields) => write('error', message, err, fields),
    file: () => file,
    files: () => {
      const all = [file];
      for (let n = 1; n < keep; n++) all.push(rotated(n));
      return all.filter((f) => fs.existsSync(f));
    },
  };
}

/* ---------- The app logger ---------- */

/** userData/logs - the directory the support bundle collects. */
export function logDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

let appLogger: Logger | null = null;
function current(): Logger {
  // Lazy: importing this module never touches Electron paths, so any main
  // module (and its tests) can import `log` freely.
  appLogger ??= createLogger({ dir: logDir(), mirror: true });
  return appLogger;
}

/** The process-wide logger. Redacts every line; still, log ids and messages, never payloads. */
export const log: Logger = {
  info: (message, fields) => current().info(message, fields),
  warn: (message, fields) => current().warn(message, fields),
  error: (message, err, fields) => current().error(message, err, fields),
  file: () => current().file(),
  files: () => current().files(),
};
