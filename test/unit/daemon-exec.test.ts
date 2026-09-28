import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/daemon/exec';

describe('runCommand timeout', () => {
  const leftovers: number[] = [];

  afterEach(() => {
    for (const pid of leftovers.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  it('kills grandchildren when the command times out', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puckd-exec-'));
    const pidfile = path.join(dir, 'grand.pid');
    try {
      const result = await runCommand(['sh', '-c', 'sleep 30 & echo $! > "$PIDFILE"; wait'], {
        timeoutMs: 500,
        env: { PATH: '/bin:/usr/bin', PIDFILE: pidfile },
      });
      expect(result.timedOut).toBe(true);
      const pid = Number(fs.readFileSync(pidfile, 'utf8'));
      leftovers.push(pid);
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      await new Promise((r) => setTimeout(r, 50));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
