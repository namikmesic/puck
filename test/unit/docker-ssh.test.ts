import { afterEach, describe, expect, it } from 'vitest';
import type { TargetProblem } from '../../src/harness/bridge';
import { docker, useDockerRunner, withHost, type DockerResult } from '../../src/main/docker-client';
import { classifyHealth, HEALTH_TIMEOUT_MS } from '../../src/main/providers/docker-health';
import { dockerLocalProvider } from '../../src/main/providers/docker-local';
import { dockerSshProvider } from '../../src/main/providers/docker-ssh';
import { addSshHost, normalizeProviders, removeSshHost, sshHosts } from '../../src/main/providers/providers-store';

const fail = (stderr: string, extra: Partial<DockerResult> = {}): DockerResult => ({ code: 1, stdout: '', stderr, ...extra });

/** How the docker CLI wraps an ssh connection-helper failure. */
const viaSsh = (inner: string, status = 255): string =>
  `error during connect: Get "http://docker.example.com/v1.47/version": command [ssh -o ConnectTimeout=30 -T -- box docker system dial-stdio] has exited with exit status ${status}, make sure the URL is valid, and Docker 18.09 or later is installed on the remote host: stderr=${inner}`;

describe('SSH host health classification', () => {
  const cases: Array<[TargetProblem, string, Partial<DockerResult>?]> = [
    ['ssh-auth', viaSsh('me@box: Permission denied (publickey).')],
    ['ssh-auth', viaSsh('sign_and_send_pubkey: signing failed for ED25519 "~/.ssh/id_ed25519" from agent: agent refused operation')],
    ['host-key', viaSsh('Host key verification failed.')],
    ['host-key', viaSsh('@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@')],
    ['docker-missing-remote', viaSsh('bash: line 1: docker: command not found', 127)],
    ['docker-missing-remote', viaSsh('sh: 1: docker: not found', 127)],
    ['socket-permission', viaSsh('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/_ping": dial unix /var/run/docker.sock: connect: permission denied')],
    ['daemon-down', viaSsh('dial unix /var/run/docker.sock: connect: no such file or directory', 1)],
    ['daemon-down', viaSsh('dial unix /var/run/docker.sock: connect: connection refused', 1)],
    ['ssh-unreachable', viaSsh('ssh: Could not resolve hostname box: nodename nor servname provided, or not known')],
    ['ssh-unreachable', viaSsh('ssh: connect to host 10.0.0.9 port 22: Connection refused')],
    ['timeout', `docker version timed out after ${HEALTH_TIMEOUT_MS / 1000}s`, { timedOut: true, code: null }],
    ['unknown', 'something new and strange'],
  ];

  for (const [problem, stderr, extra] of cases) {
    it(`${problem}: ${stderr.slice(-60)}`, () => {
      const h = classifyHealth(fail(stderr, extra), 'ssh://me@box');
      expect(h).toMatchObject({ ok: false, problem });
      expect(h.serverVersion).toBeUndefined();
      expect(h.detail.length).toBeGreaterThan(20);
      expect(h.detail).toContain('ssh://me@box');
    });
  }

  it('each problem has its own message', () => {
    const messages = new Set(cases.map(([, stderr, extra]) => classifyHealth(fail(stderr, extra), 'box').detail.split(':')[0]));
    expect(messages.size).toBeGreaterThanOrEqual(8);
  });

  it('a healthy host reports the server version', () => {
    expect(classifyHealth({ code: 0, stdout: '27.3.1\n', stderr: '' }, 'box')).toEqual({
      ok: true,
      detail: 'Docker 27.3.1',
      serverVersion: '27.3.1',
      problem: null,
    });
  });

  it('ssh-only rules never fire for the local engine', () => {
    expect(classifyHealth(fail('Permission denied (publickey).'), null).problem).toBe('unknown');
    expect(classifyHealth(fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'), null)).toMatchObject({
      problem: 'daemon-down',
      detail: 'Docker is not responding — is Docker running?',
    });
    expect(
      classifyHealth({ code: -1, stdout: '', stderr: 'Docker CLI not found. Searched: /usr/local/bin/docker.' }, null).problem,
    ).toBe('docker-cli-missing');
  });
});

describe('docker -H for remote targets', () => {
  const calls: Array<{ args: string[]; opts: unknown }> = [];
  afterEach(() => {
    calls.length = 0;
    for (const h of sshHosts()) removeSshHost(h.id);
  });
  useDockerRunner(async (args, opts) => {
    calls.push({ args, opts });
    return { code: 0, stdout: '27.3.1\n', stderr: '' };
  });

  it('prepends -H ssh://… before the subcommand; aliases become ssh URLs', async () => {
    expect(withHost(['ps'], undefined)).toEqual(['ps']);
    expect(withHost(['ps'], 'ssh://me@box:2222')).toEqual(['-H', 'ssh://me@box:2222', 'ps']);
    expect(withHost(['ps'], 'buildbox')).toEqual(['-H', 'ssh://buildbox', 'ps']);
    await docker(['ps', '-a'], { host: 'buildbox', timeoutMs: 5 });
    expect(calls[0].args).toEqual(['-H', 'ssh://buildbox', 'ps', '-a']);
    expect(calls[0].opts).toEqual({ timeoutMs: 5 }); // host is consumed, not passed on
    await docker(['ps']);
    expect(calls[1].args).toEqual(['ps']);
  });

  it('the SSH provider binds its runner and health check to the host', async () => {
    expect(dockerSshProvider.status()).toEqual({ state: 'disconnected', detail: 'No hosts yet' });
    const host = addSshHost({ label: 'Build box', host: 'ssh://me@box' });
    expect(dockerSshProvider.status()).toEqual({ state: 'connected', detail: '1 host' });
    expect(dockerSshProvider.targets()).toEqual([{ id: host.id, label: 'Build box', host: 'ssh://me@box' }]);
    const health = await dockerSshProvider.health(host.id);
    expect(health).toMatchObject({ ok: true, serverVersion: '27.3.1' });
    expect(calls[0].args).toEqual(['-H', 'ssh://me@box', 'version', '--format', '{{.Server.Version}}']);
    expect(calls[0].opts).toEqual({ timeoutMs: HEALTH_TIMEOUT_MS });
    await dockerSshProvider.runner(host.id)(['inspect', 'x']);
    expect(calls[1].args).toEqual(['-H', 'ssh://me@box', 'inspect', 'x']);
    await expect(dockerSshProvider.health('nope')).rejects.toThrow(/Unknown SSH host/);
  });

  it('Local Docker has one target and never adds -H', async () => {
    expect(dockerLocalProvider.targets()).toEqual([{ id: 'local', label: 'This Mac', host: null }]);
    await dockerLocalProvider.health('local');
    expect(calls[0].args).toEqual(['version', '--format', '{{.Server.Version}}']);
    await expect(dockerLocalProvider.health('box')).rejects.toThrow(/Unknown Local Docker target/);
  });
});

describe('puck-providers.json', () => {
  afterEach(() => {
    for (const h of sshHosts()) removeSshHost(h.id);
  });

  it('adds and removes hosts with minted ids, refusing duplicates', () => {
    const a = addSshHost({ label: '', host: 'buildbox' });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.label).toBe('buildbox'); // an empty label falls back to the host
    expect(() => addSshHost({ label: 'again', host: 'buildbox' })).toThrow(/already/);
    removeSshHost(a.id);
    expect(sshHosts()).toEqual([]);
  });

  it('loads leniently: defaults for missing fields, malformed and dash hosts dropped', () => {
    expect(normalizeProviders(null)).toEqual({ v: 1, sshHosts: [], github: { configRepo: null, mode: 'app' } });
    expect(
      normalizeProviders({
        sshHosts: [
          { id: 'a', label: 'A', host: 'ssh://me@a' },
          { id: 'b', host: 'b-alias' },
          { id: 'c', label: 'C', host: '-oProxyCommand=evil' },
          { label: 'no id', host: 'x' },
          'junk',
        ],
        github: { configRepo: 'me/cfg', mode: 'pat', extra: 1 },
      }),
    ).toEqual({
      v: 1,
      sshHosts: [
        { id: 'a', label: 'A', host: 'ssh://me@a' },
        { id: 'b', label: 'b-alias', host: 'b-alias' },
      ],
      github: { configRepo: 'me/cfg', mode: 'pat' },
    });
    expect(normalizeProviders({ github: { mode: 'weird' } }).github.mode).toBe('app');
  });
});
