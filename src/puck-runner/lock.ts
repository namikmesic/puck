/**
 * One runner process per directory. The lock is an exclusive lock on
 * `.runner.lock` held for the life of this process; the kernel drops it
 * when the process dies, including SIGKILL and a reboot, so a reused pid
 * or a permission error never decides whether the runner may start.
 * A pid written by an older runner is not a lock and is moved aside.
 */

import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

const SQLITE_HEADER = 'SQLite format 3';

function detail(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown };
  return `${typeof e.code === 'string' ? e.code : ''} ${typeof e.message === 'string' ? e.message : ''}`;
}

function isLocked(err: unknown): boolean {
  return /ERR_SQLITE_ERROR/.test(detail(err)) && /locked|busy/i.test(detail(err));
}

function isNotDatabase(err: unknown): boolean {
  return /not a database/i.test(detail(err));
}

function retirePidFile(file: string): void {
  let head: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      head = Buffer.alloc(16);
      const n = fs.readSync(fd, head, 0, 16, 0);
      head = head.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const text = head.toString('utf8');
  if (text.startsWith(SQLITE_HEADER) || (text.length > 0 && !/^\d+$/.test(text.trim()))) return;
  const stale = `${file}.stale`;
  try {
    fs.renameSync(file, stale);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  fs.rmSync(stale, { force: true });
}

function openLock(file: string, retry: boolean): () => void {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // the lock still holds when the mode cannot be tightened
    }
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    try {
      db?.close();
    } catch {
      // not opened, or already closed
    }
    if (isLocked(err)) throw new LockError('Another runner process is running from this directory.');
    if (retry && isNotDatabase(err)) {
      retirePidFile(file);
      return openLock(file, false);
    }
    throw err;
  }
  const held = db;
  return () => {
    try {
      held.exec('ROLLBACK');
    } catch {
      // already closed
    }
    try {
      held.close();
    } catch {
      // already closed
    }
  };
}

/** Holds the directory lock until the returned function runs, or until this process dies. */
export function acquireLock(file: string): () => void {
  return openLock(file, true);
}
