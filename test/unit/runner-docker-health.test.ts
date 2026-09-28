import { describe, expect, it, vi } from 'vitest';
import { discoverDocker, DOCKER_BIN_ENV, DockerNotFoundError, wellKnownDockerPaths, type DiscoveryDeps } from '../../src/puck-runner/docker/discovery';
import { classifyInfo } from '../../src/puck-runner/docker/health';

// A runner started by systemd or launchd gets a minimal PATH, so the CLI is
// found by a checked sequence; Docker's health is `docker info`, classified
// into a problem the user can act on (no SSH classes: the runner is local).

function deps(platform: NodeJS.Platform, executables: string[], env: NodeJS.ProcessEnv = { PATH: '/usr/sbin:/sbin' }): DiscoveryDeps {
  const set = new Set(executables);
  return { env, platform, homedir: '/home/puck', isExecutable: (p) => set.has(p), loginShellProbe: vi.fn(async () => null) };
}

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
    expect((err as Error).message).toContain('/usr/bin/docker');
    expect((err as Error).message).toContain('login shell');
  });
});

describe('runner docker health', () => {
  it('reads version, CPUs and memory from docker info', () => {
    const info = { ServerVersion: '27.3.1', NCPU: 16, MemTotal: 67_000_000_000, Name: 'build-box' };
    expect(classifyInfo({ code: 0, stdout: JSON.stringify(info), stderr: '' })).toEqual({
      ok: true,
      version: '27.3.1',
      problem: null,
      detail: null,
      ncpu: 16,
      memTotal: 67_000_000_000,
    });
  });

  it('classifies the problems a runner host can have', () => {
    const cases: Array<[string, string, boolean | undefined]> = [
      ['docker-cli-missing', 'Docker CLI not found. Searched: /usr/bin/docker', undefined],
      ['socket-permission', 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock', undefined],
      ['daemon-down', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', undefined],
      ['daemon-down', 'dial unix /var/run/docker.sock: connect: no such file or directory', undefined],
      ['timeout', '', true],
      ['unknown', 'something else entirely', undefined],
    ];
    for (const [problem, stderr, timedOut] of cases) {
      const r = classifyInfo({ code: 1, stdout: '', stderr, timedOut });
      expect(r).toMatchObject({ ok: false, problem, version: null });
      expect(r.detail).toBeTruthy();
    }
    expect(classifyInfo({ code: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon' }).detail).toContain(
      'usermod -aG docker',
    );
  });

  it('treats a client-only answer (engine unreachable) as down', () => {
    const r = classifyInfo({ code: 0, stdout: JSON.stringify({ ServerVersion: '', ServerErrors: ['Cannot connect to the Docker daemon'] }), stderr: '' });
    expect(r).toMatchObject({ ok: false, problem: 'daemon-down' });
  });
});
