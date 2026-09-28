/**
 * The single-daemon lock: /puck/state/puckd.lock holds the pid of the
 * daemon that owns this state. The file lives on the data volume and so
 * outlives the container's processes; after a restart the recorded pid may
 * belong to an unrelated process (even an `attach`). The lock counts as
 * held only while that pid is a running puckd serve — including the default
 * when no subcommand is given. `attach` and `version` do not hold it.
 */

import * as fs from 'node:fs';

/** True when this argv is puckd serving (explicit `serve`, or no subcommand). */
export function isServingArgv(argv: readonly string[]): boolean {
  const args = argv.filter((arg) => arg.length > 0);
  const at = args.findIndex((arg) => arg.endsWith('puckd.js'));
  if (at < 0) return false;
  const sub = args[at + 1];
  return sub === undefined || sub === 'serve';
}

export function isServingDaemon(pid: number): boolean {
  try {
    return isServingArgv(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'));
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
