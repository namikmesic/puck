/**
 * Crash-safe JSON persistence: atomic writes (tmp + rename) serialized per
 * file, so a quit mid-write can never truncate a store and concurrent saves
 * can't interleave.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from './log';

const chains = new Map<string, Promise<void>>();

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Queue an atomic write of `value` to `file`; resolves when durable. */
export function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  return writeTextAtomic(file, JSON.stringify(value));
}

/** Same, for callers that already hold the serialized text. */
export function writeTextAtomic(file: string, text: string): Promise<void> {
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined) // one failed write must not poison the chain
    .then(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, text, 'utf8');
      await fs.promises.rename(tmp, file);
    });
  chains.set(file, next);
  // Callers mostly fire-and-forget; without this handled branch a failed
  // write (disk full, permissions) becomes an unhandled rejection, which
  // kills the process by default. Awaiting callers still see the rejection.
  next.catch((err) => {
    log.error(`jsonstore: write to ${file} failed`, err);
  });
  // Forget a settled tail so flushWrites() only ever waits on real work.
  const settled = (): void => {
    if (chains.get(file) === next) chains.delete(file);
  };
  next.then(settled, settled);
  return next;
}

/**
 * Resolves once every write queued so far - and any queued while waiting -
 * has settled (failures included; they are logged above). The quit drain
 * awaits this so a save issued moments before quit still reaches disk.
 */
export async function flushWrites(): Promise<void> {
  while (chains.size) await Promise.allSettled([...chains.values()]);
}
