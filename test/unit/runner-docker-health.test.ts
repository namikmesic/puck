import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DockerResult } from '../../src/puck-runner/docker/client';
import { discoverDocker, DOCKER_BIN_ENV, DockerNotFoundError, wellKnownDockerPaths, type DiscoveryDeps } from '../../src/puck-runner/docker/discovery';
import type { DockerFailure } from '../../src/puck-runner/docker/failure';
import { classifyInfo, dockerHealth, INFO_ARGS } from '../../src/puck-runner/docker/health';
import { TIMEOUTS } from '../../src/puck-runner/docker/timeouts';

// A runner started by systemd or launchd gets a minimal PATH, so the CLI is
// found by a checked sequence; Docker's health is `docker info`, read through
// the client's failure classification into a problem the user can act on (no
// SSH classes: the runner is local). The health check is fed classified
// results; the classifier test owns the stderr patterns.

function deps(platform: NodeJS.Platform, executables: string[], env: NodeJS.ProcessEnv = { PATH: '/usr/sbin:/sbin' }): DiscoveryDeps {
  const set = new Set(executables);
  return { env, platform, homedir: '/home/puck', isExecutable: (p) => set.has(p), loginShellProbe: vi.fn(async () => null) };
}

afterEach(() => vi.unstubAllEnvs());

describe('runner docker discovery', () => {
  it('knows Linux install locations and prefers them over the inherited PATH', async () => {
    expect(wellKnownDockerPaths('linux', '/home/puck')).toEqual(['/usr/bin/docker', '/usr/local/bin/docker', '/snap/bin/docker', '/home/puck/bin/docker']);
    await expect(discoverDocker(deps('linux', ['/snap/bin/docker', '/opt/x/docker'], { PATH: '/opt/x' }))).resolves.toEqual({
      path: '/snap/bin/docker',
      source: 'well-known',
    });
  });

  it('keeps the macOS locations for a runner on a Mac', async () => {
    expect(wellKnownDockerPaths('darwin', '/Users/u')).toContain('/opt/homebrew/bin/docker');
    await expect(discoverDocker(deps('darwin', ['/opt/homebrew/bin/docker']))).resolves.toMatchObject({ source: 'well-known' });
  });

  it('honours an explicit binary and says what it searched when nothing is found', async () => {
    await expect(discoverDocker(deps('linux', ['/custom/docker'], { [DOCKER_BIN_ENV]: '/custom/docker' }))).resolves.toEqual({
      path: '/custom/docker',
      source: 'configured',
    });
    const err = await discoverDocker(deps('linux', [])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerNotFoundError);
    const { searched, message } = err as DockerNotFoundError;
    expect(searched).toEqual([
      `${DOCKER_BIN_ENV} (unset)`,
      ...wellKnownDockerPaths('linux', '/home/puck'),
      'PATH (/usr/sbin:/sbin)',
      "login shell (/bin/sh -lc 'command -v docker')",
    ]);
    expect(message).toContain(searched.join(', '));
  });
});

const failedWith = (failure: DockerFailure, stderr = 'opaque engine output'): DockerResult => ({ code: 1, stdout: '', stderr, failure });

describe('runner docker health', () => {
  it('reads version, CPUs and memory from docker info', () => {
    const info = { ServerVersion: '27.3.1', NCPU: 16, MemTotal: 67_000_000_000, Name: 'build-box' };
    expect(classifyInfo({ code: 0, stdout: JSON.stringify(info), stderr: '', failure: null })).toEqual({
      ok: true,
      version: '27.3.1',
      problem: null,
      detail: null,
      ncpu: 16,
      memTotal: 67_000_000_000,
    });
  });

  it('reports each classified failure as the problem a runner host can act on, without reading stderr', () => {
    const cases: Array<[DockerFailure, string]> = [
      ['cli-missing', 'docker-cli-missing'],
      ['permission', 'socket-permission'],
      ['daemon-down', 'daemon-down'],
      ['timeout', 'timeout'],
      ['not-found', 'unknown'],
      ['cancelled', 'unknown'],
      ['other', 'unknown'],
    ];
    for (const [failure, problem] of cases) {
      const r = classifyInfo(failedWith(failure));
      expect(r, failure).toEqual({ ok: false, version: null, problem, detail: expect.any(String), ncpu: null, memTotal: null });
      expect(r.detail, failure).not.toBe('');
    }
    expect(classifyInfo(failedWith('permission')).detail).toContain('usermod -aG docker');
    expect(classifyInfo(failedWith('timeout')).detail).toContain(`${TIMEOUTS.info / 1000} s`);
    // What discovery searched reaches the user as the detail; the class came from the value.
    expect(classifyInfo(failedWith('cli-missing', 'searched /usr/bin/docker and PATH')).detail).toBe('searched /usr/bin/docker and PATH');
    expect(classifyInfo(failedWith('other', 'something else entirely')).detail).toBe('docker info failed: something else entirely');
  });

  it('reports a discovery failure from the real client as docker-cli-missing', async () => {
    vi.stubEnv(DOCKER_BIN_ENV, '/nonexistent/puck-test/docker');
    vi.resetModules();
    const { realDocker } = await import('../../src/puck-runner/docker/client');
    const r = await realDocker(INFO_ARGS);
    expect(r).toMatchObject({ code: -1, stdout: '', failure: 'cli-missing' });
    expect(classifyInfo(r)).toMatchObject({ ok: false, problem: 'docker-cli-missing', detail: expect.stringContaining('/nonexistent/puck-test/docker') });
  });

  it('asks docker info with the health timeout from the one table', async () => {
    const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
    const health = await dockerHealth(async (args, opts) => {
      calls.push({ args, timeoutMs: opts?.timeoutMs });
      return failedWith('daemon-down');
    });
    expect(calls).toEqual([{ args: INFO_ARGS, timeoutMs: TIMEOUTS.info }]);
    expect(health).toMatchObject({ ok: false, problem: 'daemon-down' });
  });

  it('takes a client-only answer (engine unreachable) through the same classifier', () => {
    const stdout = JSON.stringify({ ServerVersion: '', ServerErrors: ['Cannot connect to the Docker daemon'] });
    expect(classifyInfo({ code: 0, stdout, stderr: '', failure: null })).toMatchObject({ ok: false, problem: 'daemon-down' });
    expect(classifyInfo({ code: 0, stdout: 'not json', stderr: '', failure: null })).toMatchObject({ ok: false, problem: 'unknown' });
  });
});
