// A directory LocalListener creates for its socket is mode 0700. An existing
// directory is left alone, and one other users can access is refused. A path
// that is not already normalized is refused before any directory is created.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Control } from '../../src/puck-runner/control';
import type { DockerSpawner } from '../../src/puck-runner/docker/client';
import { checkSocketPath, LocalListener, type LocalDeps } from '../../src/puck-runner/local';
import { nullLogger } from '../../src/puck-runner/log';

let root: string;
let listener: LocalListener | null = null;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-sock-'));
});

afterEach(async () => {
  await listener?.stop();
  listener = null;
  if (root) {
    try {
      fs.chmodSync(root, 0o700);
    } catch {
      // already removed
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function bits(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

function listen(socket: string): LocalListener {
  const deps: LocalDeps = {
    path: socket,
    runnerId: 'rnr_01J8Z3X0000000000000000002',
    version: '0.0.0',
    control: null as unknown as Control,
    spawner: null as unknown as DockerSpawner,
    instanceState: async () => null,
    log: nullLogger,
  };
  return new LocalListener(deps);
}

describe('local socket directory', () => {
  it('makes a directory it creates private and leaves an existing ancestor alone', async () => {
    fs.chmodSync(root, 0o755);
    const parent = path.join(root, 'fresh');
    const socket = path.join(parent, 's');
    listener = listen(socket);
    const previous = process.umask(0o477);
    try {
      await listener.start();
    } finally {
      process.umask(previous);
    }
    expect(bits(parent)).toBe(0o700);
    expect(bits(root)).toBe(0o755);
    expect(bits(socket)).toBe(0o600);
  });

  it('listens in an existing private directory without changing its mode', async () => {
    fs.chmodSync(root, 0o300);
    const socket = path.join(root, 's');
    fs.writeFileSync(socket, 'stale');
    listener = listen(socket);
    await listener.start();
    expect(bits(root)).toBe(0o300);
    expect(bits(socket)).toBe(0o600);

    const again = listen(socket);
    await expect(again.start()).rejects.toThrow(/Another process is listening/);
    expect(bits(root)).toBe(0o300);
    expect(bits(socket)).toBe(0o600);
  });

  it.each(['755', '770', '707'])('refuses an existing parent at mode %s without changing it', async (octal) => {
    const mode = Number.parseInt(octal, 8);
    fs.chmodSync(root, mode);
    const socket = path.join(root, 's');
    fs.writeFileSync(socket, 'keep');
    listener = listen(socket);
    await expect(listener.start()).rejects.toThrow(/group- or world-accessible[\s\S]*will not change its permissions/);
    expect(bits(root)).toBe(mode);
    expect(fs.readFileSync(socket, 'utf8')).toBe('keep');
  });

  it('refuses a .. path before creating a directory or changing the parent mode', async () => {
    fs.chmodSync(root, 0o755);
    const socket = `${root}/unused/../puck.sock`;
    expect(checkSocketPath(socket)).toMatch(/normalized/);
    expect(checkSocketPath(`${root}/./puck.sock`)).toMatch(/normalized/);
    expect(checkSocketPath(`${root}//puck.sock`)).toMatch(/normalized/);
    expect(checkSocketPath(path.join(root, 'puck.sock'))).toBeNull();
    listener = listen(socket);
    await expect(listener.start()).rejects.toThrow(/normalized/);
    expect(bits(root)).toBe(0o755);
    expect(fs.existsSync(`${root}/unused`)).toBe(false);
    expect(fs.existsSync(`${root}/puck.sock`)).toBe(false);
  });
});
