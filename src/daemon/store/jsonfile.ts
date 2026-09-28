/**
 * Crash-safe JSON files for the daemon's stores. A write goes to a temp
 * file, is fsynced, renamed over the target, and the directory is fsynced,
 * so a crash or a container kill leaves either the old or the new file,
 * never a torn one. Writes to one file are serialized through a chain, so
 * concurrent saves cannot interleave; a failed write does not poison the
 * chain.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const chains = new Map<string, Promise<void>>();

let onWriteError: (file: string, err: unknown) => void = () => undefined;
/** Where failed fire-and-forget writes are reported (the daemon log). */
export function reportWriteErrors(fn: (file: string, err: unknown) => void): void {
  onWriteError = fn;
}

export function readJsonFile<T>(file: string): T | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return JSON.parse(text) as T;
}

/** Synchronous atomic write (boot-time stores, before anything else runs). */
export function writeFileAtomicSync(file: string, text: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some filesystems refuse directory fsync; the rename is still atomic.
  }
}

/** Queue an atomic write; resolves once the file is durable. */
export function writeJsonAtomic(file: string, value: unknown, mode = 0o600): Promise<void> {
  const text = JSON.stringify(value);
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => writeFileAtomicSync(file, text, mode));
  chains.set(file, next);
  // Most callers fire and forget; a rejection nobody handles would kill the
  // daemon. Awaiting callers still see it.
  next.catch((err) => onWriteError(file, err));
  const settled = (): void => {
    if (chains.get(file) === next) chains.delete(file);
  };
  next.then(settled, settled);
  return next;
}

/** Resolves once every queued write (and any queued meanwhile) has settled. */
export async function flushJsonWrites(): Promise<void> {
  while (chains.size) await Promise.allSettled([...chains.values()]);
}
