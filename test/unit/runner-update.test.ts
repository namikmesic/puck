import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RUNNER_PACKAGE_ENTRIES } from '../../src/harness/runner-releases';
import { ServerApi } from '../../src/puck-runner/api';
import { runnerPaths } from '../../src/puck-runner/files';
import { nullLogger } from '../../src/puck-runner/log';
import { tarGz } from '../../src/puck-runner/tar';
import { applyUpdate, compareVersions, findUpdate, SHIPPED, swapIn } from '../../src/puck-runner/update';
import { startServer, type Harness } from './server-fakes';

// Self-update against the real server's download routes: the newer tarball
// for this platform is fetched, checked against the published sha256,
// smoke-tested, and swapped in with the previous version kept.

let dir: string;
let h: Harness | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-update-'));
});
afterEach(async () => {
  await h?.close();
  h = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

function release(version: string, echo = version): Buffer {
  return tarGz([
    { name: 'run.sh', type: 'file', mode: 0o755, body: `#!/bin/sh\n# ${version}\n` },
    { name: 'VERSION', type: 'file', mode: 0o644, body: `${version}\n` },
    { name: 'bin/', type: 'dir', mode: 0o755 },
    // The smoke test runs `bin/node bin/puck-runner.cjs version`; a shell script stands in for Node.
    { name: 'bin/node', type: 'file', mode: 0o755, body: `#!/bin/sh\necho ${echo}\n` },
    { name: 'bin/puck-runner.cjs', type: 'file', mode: 0o644, body: `// runner ${version}\n` },
  ]);
}

async function setup(files: Record<string, Buffer>) {
  const downloads = path.join(dir, 'downloads');
  for (const [name, body] of Object.entries(files)) {
    const version = /-(\d+\.\d+\.\d+)\.tar\.gz$/.exec(name)?.[1] as string;
    fs.mkdirSync(path.join(downloads, version), { recursive: true });
    fs.writeFileSync(path.join(downloads, version, name), body);
  }
  const server = await startServer({ PUCK_DEVELOPMENT: 'true', PUCK_RUNNER_DOWNLOADS: downloads });
  h = server;
  // Asset URLs name the server's public URL; route them to the test server.
  const fetchImpl = ((url: string | URL, init?: RequestInit) => fetch(String(url).replace('http://puck.test', server.base), init)) as typeof fetch;
  const paths = runnerPaths(path.join(dir, 'runner'));
  fs.mkdirSync(path.join(paths.root, 'bin'), { recursive: true });
  fs.writeFileSync(paths.version, '0.1.0\n');
  fs.writeFileSync(path.join(paths.root, 'run.sh'), '#!/bin/sh\n# 0.1.0\n');
  fs.writeFileSync(paths.bundle, '// runner 0.1.0\n');
  fs.writeFileSync(paths.config, '{"keep":"me"}');
  return { api: new ServerApi('http://puck.test', fetchImpl), paths };
}

describe('runner self-update', () => {
  it('compares release versions', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });

  it('finds the newer release for this platform only', async () => {
    const { api, paths } = await setup({
      'puck-runner-linux-x64-0.2.0.tar.gz': release('0.2.0'),
      'puck-runner-macos-arm64-0.2.0.tar.gz': release('0.2.0'),
    });
    const base = { api, paths, log: nullLogger, version: '0.1.0' };
    expect(await findUpdate({ ...base, os: 'linux', arch: 'x64' })).toMatchObject({ version: '0.2.0', os: 'linux', arch: 'x64' });
    expect(await findUpdate({ ...base, os: 'linux', arch: 'arm64' })).toBeNull();
    expect(await findUpdate({ ...base, version: '0.2.0', os: 'linux', arch: 'x64' })).toBeNull();
  });

  it('swaps the release in and keeps the previous one, leaving registration files alone', async () => {
    const { api, paths } = await setup({ 'puck-runner-linux-x64-0.2.0.tar.gz': release('0.2.0') });
    const deps = { api, paths, log: nullLogger, version: '0.1.0', os: 'linux' as const, arch: 'x64' as const };
    const asset = await findUpdate(deps);
    await applyUpdate(deps, asset as NonNullable<typeof asset>);
    expect(fs.readFileSync(paths.version, 'utf8')).toBe('0.2.0\n');
    expect(fs.readFileSync(paths.bundle, 'utf8')).toBe('// runner 0.2.0\n');
    expect(fs.readFileSync(path.join(paths.root, 'run.sh'), 'utf8')).toContain('0.2.0');
    expect(fs.readFileSync(path.join(paths.update, 'previous', 'VERSION'), 'utf8')).toBe('0.1.0\n');
    expect(fs.readFileSync(paths.config, 'utf8')).toBe('{"keep":"me"}');
    expect(fs.readdirSync(paths.update)).toEqual(['previous']);
  });

  it('runs beforeSwap after the smoke test and leaves the runner in place when that throws', async () => {
    const { api, paths } = await setup({ 'puck-runner-linux-x64-0.2.0.tar.gz': release('0.2.0') });
    const deps = { api, paths, log: nullLogger, version: '0.1.0', os: 'linux' as const, arch: 'x64' as const };
    const asset = (await findUpdate(deps)) as NonNullable<Awaited<ReturnType<typeof findUpdate>>>;
    let during = '';
    await expect(
      applyUpdate(deps, asset, async () => {
        during = fs.readFileSync(paths.version, 'utf8');
        throw new Error('stopped');
      }),
    ).rejects.toThrow('stopped');
    expect(during).toBe('0.1.0\n');
    expect(fs.readFileSync(paths.version, 'utf8')).toBe('0.1.0\n');
    expect(fs.readFileSync(paths.bundle, 'utf8')).toBe('// runner 0.1.0\n');
  });

  it('changes nothing when the download does not match its sha256 or the new runner does not start', async () => {
    const { api, paths } = await setup({ 'puck-runner-linux-x64-0.2.0.tar.gz': release('0.2.0', 'broken') });
    const deps = { api, paths, log: nullLogger, version: '0.1.0', os: 'linux' as const, arch: 'x64' as const };
    const asset = (await findUpdate(deps)) as NonNullable<Awaited<ReturnType<typeof findUpdate>>>;
    await expect(applyUpdate(deps, { ...asset, sha256: 'f'.repeat(64) })).rejects.toThrow(/published sha256/);
    await expect(applyUpdate(deps, asset)).rejects.toThrow(/does not start/);
    expect(fs.readFileSync(paths.version, 'utf8')).toBe('0.1.0\n');
    expect(fs.readFileSync(paths.bundle, 'utf8')).toBe('// runner 0.1.0\n');
  });

  it('ships the package layout\'s top level, and swaps every entry of a full package in', () => {
    expect(SHIPPED).toEqual(['config.sh', 'run.sh', 'svc.sh', 'VERSION', 'README.md', 'LICENSE', 'bin']);
    for (const e of RUNNER_PACKAGE_ENTRIES) expect(SHIPPED, e.name).toContain(e.name.split('/')[0]);
    for (const item of SHIPPED) expect(RUNNER_PACKAGE_ENTRIES.map((e) => e.name), item).toContain(item === 'bin' ? 'bin/' : item);
    const paths = runnerPaths(path.join(dir, 'runner'));
    const staging = path.join(dir, 'staging');
    for (const [root, body] of [[paths.root, 'old'], [staging, 'new']]) {
      fs.mkdirSync(root, { recursive: true });
      for (const e of RUNNER_PACKAGE_ENTRIES) {
        if (e.type === 'dir') fs.mkdirSync(path.join(root, e.name));
        else fs.writeFileSync(path.join(root, e.name), `${body} ${e.name}`);
      }
    }
    fs.writeFileSync(paths.config, '{"keep":"me"}');
    swapIn(paths, staging);
    for (const e of RUNNER_PACKAGE_ENTRIES.filter((x) => x.type === 'file')) {
      expect(fs.readFileSync(path.join(paths.root, e.name), 'utf8')).toBe(`new ${e.name}`);
      expect(fs.readFileSync(path.join(paths.update, 'previous', e.name), 'utf8')).toBe(`old ${e.name}`);
    }
    expect(fs.readFileSync(paths.config, 'utf8')).toBe('{"keep":"me"}');
  });

  it('downloads only from the Puck server itself', async () => {
    const { api } = await setup({});
    await expect(api.download('https://evil.test/puck-runner.tar.gz')).rejects.toThrow(/only from the Puck server/);
  });
});
