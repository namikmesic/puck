/**
 * The server's log: one JSON object per line on stdout, for the container
 * runtime to collect. Callers log ids, names, states, counts and timings
 * only. Never a token, a GitHub payload, or channel bytes (the relay never
 * sees plaintext, and it does not log the ciphertext either). Every line
 * still passes through `redact`, which scrubs bearer-token shapes: Puck's
 * own prefixes, GitHub's `gh?_` tokens, JWTs and long opaque blobs.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface ServerLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\bP[RS][A-Z]_[A-Za-z0-9]{8,}/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9_]{8,}/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]'],
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[redacted-key]'],
  [/[A-Za-z0-9_+=-]{48,}/g, '[redacted-long]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [shape, replacement] of SHAPES) out = out.replace(shape, replacement);
  return out;
}

export function createServerLog(
  write: (line: string) => void = (line) => process.stdout.write(line),
  now: () => number = Date.now,
): ServerLog {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    const record = { t: new Date(now()).toISOString(), level, msg, ...fields };
    write(redact(JSON.stringify(record)) + '\n');
  };
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

/** Swallows everything: the default in tests. */
export const silentLog: ServerLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
