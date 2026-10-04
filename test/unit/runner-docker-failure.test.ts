import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DOCKER_BIN_ENV } from '../../src/puck-runner/docker/discovery';
import { classifyStderr, type DockerFailure } from '../../src/puck-runner/docker/failure';

// The one classifier of a failed docker command, and the only test that owns
// its stderr patterns. The client attaches the class to every result once:
// a scripted CLI stands in for docker to show each way a command can end.

describe('runner docker failure classifier', () => {
  it('reads docker stderr as the failure callers act on', () => {
    const cases: Array<[DockerFailure, string]> = [
      ['permission', 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: permission denied'],
      ['permission', 'dial unix /var/run/docker.sock: connect: permission denied'],
      ['daemon-down', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'],
      ['daemon-down', 'Cannot connect to the Docker daemon at unix:///Users/u/.colima/default/docker.sock. Is the docker daemon running?'],
      ['daemon-down', 'dial unix /var/run/docker.sock: connect: no such file or directory'],
      ['daemon-down', 'dial unix /Users/u/.docker/run/docker.sock: connect: connection refused'],
      ['not-found', 'Error: No such container: puck-env_1'],
      ['not-found', 'Error response from daemon: No such container: puck-env_1'],
      ['not-found', 'Error: No such object: puck-env_1'],
      ['not-found', 'Error response from daemon: get puck-env_1-data: no such volume'],
      ['not-found', 'Error response from daemon: No such image: puck-img-env_1:latest'],
      ['not-found', 'Error: puck-img-env_1: image not known'],
      ['other', 'Error response from daemon: remove puck-env_1-data: volume is in use - [abc123]'],
      ['other', 'write /var/lib/docker/tmp/x: no space left on device'],
      ['other', 'Docker CLI not found. Searched: /usr/bin/docker'],
      ['other', ''],
    ];
    for (const [failure, stderr] of cases) expect(classifyStderr(stderr), stderr).toBe(failure);
  });
});

describe('runner docker client classification', () => {
  let dir: string;
  let cli: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-docker-cli-'));
    cli = path.join(dir, 'docker');
    // `exec` so the guard's SIGKILL reaches the sleeping process and the pipes close.
    const script = [
      '#!/bin/sh',
      'case "$1" in',
      '  ok) echo "27.3.1" ;;',
      '  missing) echo "Error: No such container: puck-x" >&2; exit 1 ;;',
      '  down) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1 ;;',
      '  odd) echo "something else entirely" >&2; exit 3 ;;',
      '  hang) exec sleep 30 ;;',
      'esac',
      '',
    ].join('\n');
    fs.writeFileSync(cli, script, { mode: 0o755 });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());

  /** The client with a fresh discovery cache, pointed at `bin`. */
  async function client(bin: string) {
    vi.stubEnv(DOCKER_BIN_ENV, bin);
    vi.resetModules();
    return import('../../src/puck-runner/docker/client');
  }

  it('attaches no failure to an exit 0 and the classifier result to any other exit', async () => {
    const { realDocker } = await client(cli);
    expect(await realDocker(['ok'])).toEqual({ code: 0, stdout: '27.3.1\n', stderr: '', failure: null });
    expect(await realDocker(['missing'])).toMatchObject({ code: 1, failure: 'not-found' });
    expect(await realDocker(['down'])).toMatchObject({ code: 1, failure: 'daemon-down' });
    expect(await realDocker(['odd'])).toMatchObject({ code: 3, stderr: 'something else entirely\n', failure: 'other' });
  });

  it('classifies the guard and the signal by what happened, not by output', async () => {
    const { realDocker } = await client(cli);
    expect(await realDocker(['hang'], { timeoutMs: 100 })).toMatchObject({ failure: 'timeout', stderr: expect.stringContaining('timed out') });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(await realDocker(['hang'], { signal: controller.signal })).toMatchObject({ stderr: 'cancelled', failure: 'other' });
    expect(await realDocker(['ok'], { signal: AbortSignal.abort() })).toEqual({ code: null, stdout: '', stderr: 'cancelled', failure: 'other' });
  });

  it('reports a failed discovery as cli-missing, keeping what was tried for the message', async () => {
    const missing = path.join(dir, 'not-there');
    const { realDocker } = await client(missing);
    const r = await realDocker(['ok']);
    expect(r).toMatchObject({ code: -1, stdout: '', failure: 'cli-missing' });
    expect(r.stderr).toContain(missing);
  });
});
