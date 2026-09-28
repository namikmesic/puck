import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Credentials } from '../../src/daemon/credentials';
import { readDefinition, type DaemonDefinition } from '../../src/harness/env-definition';
import { nullLogger } from '../../src/daemon/log';
import type { DaemonPaths } from '../../src/daemon/paths';
import { askpassScript, provision, ProvisionError, RUNTIME_MESSAGE, type ProvisionDeps } from '../../src/daemon/provision';
import { exampleDefinition, fakeRunner, tempRoot, type RecordedCommand } from './daemon-fakes';

let root: ReturnType<typeof tempRoot>;
let paths: DaemonPaths;
let definition: DaemonDefinition;

beforeEach(() => {
  root = tempRoot();
  paths = root.paths;
  const r = readDefinition(exampleDefinition());
  if (!r.ok) throw new Error(r.error);
  definition = r.value;
});
afterEach(() => root.cleanup());

function deps(run: ReturnType<typeof fakeRunner>['run'], over: Partial<ProvisionDeps> = {}): ProvisionDeps & { stages: string[] } {
  const stages: string[] = [];
  return {
    paths,
    log: nullLogger,
    run,
    credentials: new Credentials({ paths, log: nullLogger, run, asPuck: {} }),
    definition,
    sha: 'abc1234',
    skipPackages: false,
    gitBase: 'https://github.com/',
    prior: {},
    privileged: true,
    onStage: (stage, detail) => stages.push(detail ? `${stage}: ${detail}` : stage),
    nodeVersion: '22.23.0',
    stages,
    ...over,
  };
}

/** Everything succeeds; `id -u puck` says the user is missing; package checks fail (not installed). */
const freshImage = (argv: string[]) => {
  if (argv[0] === 'id') return { code: 1 };
  if (argv[0] === 'getent') return { code: 2 };
  if (argv[0] === 'sh' && argv[1] === '-lc' && !argv[2].startsWith('npm install') && argv[2].includes('[ "$(v')) return { code: 1 };
  if (argv[0] === 'sh' && argv[1] === '-lc' && argv[2].includes('echo "')) {
    return {
      stdout: [
        '@anthropic-ai/claude-code 2.1.280',
        '@openai/codex 0.156.1',
        '@anthropic-ai/claude-agent-sdk 0.3.280',
        'zod 4.6.5',
        '@modelcontextprotocol/sdk 1.30.1',
        '@openai/codex-sdk 0.156.1',
      ].join('\n'),
    };
  }
  return undefined;
};

const asUser = (c: RecordedCommand) => (c.opts.uid === 10001 && c.opts.gid === 10001 ? 'puck' : 'root');

describe('provisioning', () => {
  it('runs every stage in order with exact argv and the right user', async () => {
    const { run, calls } = fakeRunner(freshImage);
    const d = deps(run, { privileged: false });
    // Unprivileged (tests cannot chown); the puck uid is still asserted below via a privileged run.
    await provision(d);
    expect(d.stages.filter((s) => !s.includes(':'))).toEqual([
      'checking-runtime',
      'creating-user',
      'installing-clis',
      'installing-sdks',
      'verifying-packages',
      'configuring-git',
      'syncing-repos',
      'writing-credentials',
    ]);
    const argv = calls.map((c) => c.argv.join(' '));
    expect(argv).toContain('groupadd -g 10001 puck');
    expect(argv).toContain('useradd -u 10001 -g 10001 -d /puck/home -M -s /bin/bash puck');
    expect(argv.find((a) => a.startsWith('sh -lc npm install -g'))).toBe('sh -lc npm install -g @anthropic-ai/claude-code@2.1.280 @openai/codex@0.156.1');
    expect(argv.find((a) => a.startsWith('sh -lc npm install --prefix'))).toBe(
      'sh -lc npm install --prefix /opt/puck @anthropic-ai/claude-agent-sdk@0.3.280 zod@4.6.5 @modelcontextprotocol/sdk@1.30.1 @openai/codex-sdk@0.156.1',
    );
    expect(argv).toContain('git config --system --replace-all safe.directory *');
    const mirror = path.join(paths.mirrors, 'app.git');
    expect(argv).toContain(`git -c core.hooksPath=/dev/null clone --mirror -- https://github.com/octo/app.git ${mirror}`);
    expect(argv).toContain(`git clone --branch main -- file://${mirror} ${path.join(paths.workspace, 'app')}`);
    const clone = calls.find((c) => c.argv[1] === '-c' && c.argv.includes('--mirror'));
    expect(clone?.opts.env).toMatchObject({ GIT_ASKPASS: path.join(paths.bin, 'git-askpass'), GIT_TERMINAL_PROMPT: '0', PUCK_GIT_OWNER: 'octo' });
    expect(fs.readFileSync(path.join(paths.bin, 'codex-as-puck'), 'utf8')).toContain(
      'exec setpriv --reuid=10001 --regid=10001 --init-groups -- "$(command -v codex)" "$@"',
    );
    expect(fs.statSync(paths.state).mode & 0o777).toBe(0o700);
    expect(fs.statSync(paths.home).mode & 0o777).toBe(0o700);
  });

  it('runs git in the workspace and HOME as puck, and root git only against the mirrors', async () => {
    const { run, calls } = fakeRunner(freshImage);
    // privileged: true drops to uid 10001; chown needs root, so record it instead.
    const chowned: Array<[string, number]> = [];
    await provision(deps(run, { chown: (file, uid) => chowned.push([path.relative(root.root, file), uid]) }));
    expect(chowned).toEqual([
      ['puck', 0],
      ['puck/state', 0],
      ['puck/inbox', 0],
      ['puck/mirrors', 0],
      ['puck/home', 10001],
      ['workspace', 10001],
      ['workspace/.puck', 10001],
      ['opt/puck/bin', 0],
    ]);
    const git = calls.filter((c) => c.argv[0] === 'git');
    for (const c of git) {
      const user = asUser(c);
      if (c.argv.includes('--system')) expect(user).toBe('root');
      else if (c.argv.includes('core.hooksPath=/dev/null')) {
        expect(user).toBe('root');
        expect(c.argv.join(' ')).toContain(paths.mirrors);
      } else expect(user, c.argv.join(' ')).toBe('puck');
    }
    expect(git.filter((c) => asUser(c) === 'puck').map((c) => c.opts.env?.HOME)).toEqual([paths.home, paths.home, paths.home]);
  });

  it('fails clearly when the image lacks the runtime', async () => {
    const { run } = fakeRunner((argv) => (argv[0] === 'sh' && argv[1] === '-c' ? { stdout: 'setpriv\n' } : undefined));
    const err = await provision(deps(run, { nodeVersion: '18.20.0' })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).stage).toBe('checking-runtime');
    expect((err as Error).message).toBe(`${RUNTIME_MESSAGE} Missing: node 18, setpriv.`);
  });

  it('fails the verifying stage on pin drift', async () => {
    const { run } = fakeRunner((argv) => {
      if (argv[0] === 'sh' && argv[1] === '-lc' && argv[2].includes('echo "')) return { stdout: 'zod 3.0.0' };
      return freshImage(argv);
    });
    const err = await provision(deps(run, { privileged: false })).catch((e: unknown) => e);
    expect((err as ProvisionError).stage).toBe('verifying-packages');
    expect((err as Error).message).toMatch(/zod is 3.0.0 under \/opt\/puck, expected 4.6.5/);
  });

  it('skips stages whose inputs are unchanged on the same container, and reruns them on a new one', async () => {
    const first = fakeRunner(freshImage);
    const prior = await provision(deps(first.run, { privileged: false }));
    const again = fakeRunner(freshImage);
    const d = deps(again.run, { privileged: false, prior });
    await provision(d);
    expect(d.stages).toContain('installing-sdks: unchanged');
    expect(d.stages).toContain('creating-user: unchanged');
    expect(again.calls.some((c) => c.argv.join(' ').includes('npm install'))).toBe(false);
    // A rebuilt container has a new layer id: everything runs again.
    fs.rmSync(paths.layerId);
    const rebuilt = fakeRunner(freshImage);
    const r = deps(rebuilt.run, { privileged: false, prior });
    await provision(r);
    expect(r.stages).not.toContain('installing-sdks: unchanged');
  });

  it('skips package work entirely when asked to', async () => {
    const { run, calls } = fakeRunner(freshImage);
    const d = deps(run, { privileged: false, skipPackages: true });
    await provision(d);
    expect(d.stages).toContain('installing-sdks: skipped');
    expect(calls.some((c) => c.argv.join(' ').includes('npm'))).toBe(false);
  });

  it('keeps a stale mirror usable when fetching fails', async () => {
    fs.mkdirSync(path.join(paths.mirrors, 'app.git'), { recursive: true });
    fs.mkdirSync(path.join(paths.workspace, 'app'), { recursive: true });
    const { run, calls } = fakeRunner((argv) => (argv.includes('fetch') ? { code: 128, stderr: 'fatal: unable to access' } : freshImage(argv)));
    await provision(deps(run, { privileged: false }));
    expect(calls.map((c) => c.argv.join(' '))).toContain(`git -c core.hooksPath=/dev/null -C ${path.join(paths.mirrors, 'app.git')} fetch --prune origin`);
    expect(calls.some((c) => c.argv[1] === 'clone')).toBe(false);
  });

  it('answers git with the installation token of the repository owner', () => {
    fs.mkdirSync(paths.secrets, { recursive: true });
    const grant = (owner: string, token: string) => ({ owner, installationId: 1, repos: [`${owner}/app`], token, expiresAt: 4102444800000 });
    fs.writeFileSync(path.join(paths.secrets, 'github.json'), JSON.stringify({ grants: [grant('octo', 'ghs_octotoken'), grant('Acme', 'ghs_acmetoken')] }));
    const script = path.join(root.root, 'askpass');
    fs.writeFileSync(script, askpassScript(paths), { mode: 0o755 });
    const ask = (prompt: string, owner: string) =>
      execFileSync('sh', [script, prompt], { env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, PUCK_GIT_OWNER: owner } }).toString();
    expect(ask("Username for 'https://github.com': ", 'octo')).toBe('x-access-token\n');
    expect(ask("Password for 'https://x-access-token@github.com': ", 'octo')).toBe('ghs_octotoken');
    expect(ask("Password for 'https://x-access-token@github.com': ", 'acme')).toBe('ghs_acmetoken');
    expect(ask("Password for 'https://x-access-token@github.com': ", 'nobody')).toBe('');
  });
});
