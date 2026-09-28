/**
 * The single-daemon lock: /puck/state/puckd.lock holds the pid of the
 * daemon that owns this state. The file lives on the data volume and so
 * outlives the container's processes; after a restart the recorded pid may
 * belong to an unrelated process (even an `attach`). The lock counts as
 * held only while that pid is a running `puckd … serve`; otherwise it is
 * taken over.
 */

import * as fs from 'node:fs';

export function isServingDaemon(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return cmdline.some((a) => a.endsWith('puckd.js')) && cmdline.includes('serve');
  } catch {
    return false;
  }
}

export function acquireLock(
  file: string,
  opts: { pid?: number; isDaemon?: (pid: number) => boolean } = {},
): boolean {
  const pid = opts.pid ?? process.pid;
  const isDaemon = opts.isDaemon ?? isServingDaemon;
  try {
    fs.writeFileSync(file, String(pid), { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const holder = Number(fs.readFileSync(file, 'utf8').trim());
  if (Number.isInteger(holder) && holder > 0 && holder !== pid && isDaemon(holder)) return false;
  fs.writeFileSync(file, String(pid), { mode: 0o600 });
  return true;
}

export function releaseLock(file: string, pid = process.pid): void {
  try {
    if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.rmSync(file, { force: true });
  } catch {
    // already gone
  }
}
