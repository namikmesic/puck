import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, LockError } from '../../src/puck-runner/lock';

// The directory lock is held by this process and dropped by the kernel when
// that process dies. A pid recorded in the file does not decide liveness.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-lock-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('runner directory lock', () => {
  it('allows one holder and another after it is released', () => {
    const file = path.join(dir, '.runner.lock');
    const release = acquireLock(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(() => acquireLock(file)).toThrow(LockError);
    release();
    const again = acquireLock(file);
    again();
  });

  it('takes the lock when the file names a live process that does not hold it', () => {
    const file = path.join(dir, '.runner.lock');
    fs.writeFileSync(file, `${process.pid}\n`);
    const release = acquireLock(file);
    expect(() => acquireLock(file)).toThrow(LockError);
    release();
  });

  it('acquires once the process holding the lock has been killed', async () => {
    const file = path.join(dir, '.runner.lock');
    const holder = path.join(dir, 'holder.cjs');
    fs.writeFileSync(
      holder,
      `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.argv[2]);
        db.exec('PRAGMA busy_timeout = 0');
        db.exec('BEGIN EXCLUSIVE');
        process.stdout.write('held\\n');
        setInterval(() => undefined, 1000);
      `,
    );
    const child = spawn(process.execPath, [holder, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('exit', (code) => reject(new Error(`holder exited ${code}: ${stderr}`)));
    });
    expect(() => acquireLock(file)).toThrow(LockError);
    process.kill(child.pid as number, 'SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    const release = acquireLock(file);
    release();
  });
});
