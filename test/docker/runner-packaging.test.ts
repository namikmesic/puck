import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { docker, must } from './helpers';

// The release tarballs, each with its own Node runtime, run `config.sh
// --help` on their platform: the Linux ones in a bare Debian container
// (no Node installed; the other architecture through emulation), the
// macOS one directly on an Apple silicon Mac. Files go into containers with
// docker cp, never a bind mount.

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'out', 'puck-runner-suite');
const VERSION = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const BASE = 'debian:bookworm-slim';

const tarball = (target: string) => path.join(OUT, VERSION, `puck-runner-${target}-${VERSION}.tar.gz`);

beforeAll(() => {
  execFileSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(ROOT, 'scripts', 'package-runner.mjs'), '--out', OUT], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}, 600_000);

async function runInLinux(platform: string, target: string): Promise<{ code: number | null; out: string }> {
  const script = [
    'set -e',
    'mkdir /r && cd /r',
    `tar xzf /tmp/${path.basename(tarball(target))}`,
    'test ! -e /usr/bin/node && test ! -e /usr/local/bin/node',
    './config.sh --help',
    'echo "arch=$(./bin/node -p process.arch) version=$(./bin/node bin/puck-runner.cjs version) node=$(./bin/node --version)"',
  ].join('\n');
  const id = (await must(['create', '--platform', platform, BASE, 'sh', '-c', script], { timeoutMs: 300_000 })).trim();
  try {
    await must(['cp', tarball(target), `${id}:/tmp/`]);
    const r = await docker(['start', '-a', id], { timeoutMs: 300_000 });
    return { code: r.code, out: r.stdout + r.stderr };
  } finally {
    await docker(['rm', '-f', id]);
  }
}

describe('Docker scenario: runner tarballs', () => {
  it('ships the three platforms with sha256 sums', () => {
    const sums = fs.readFileSync(path.join(OUT, VERSION, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(sums.map((l) => l.split(/\s+/)[1]).sort()).toEqual([
      `puck-runner-linux-arm64-${VERSION}.tar.gz`,
      `puck-runner-linux-x64-${VERSION}.tar.gz`,
      `puck-runner-macos-arm64-${VERSION}.tar.gz`,
    ]);
    for (const line of sums) {
      const [sum, file] = line.split(/\s+/);
      expect(fs.readFileSync(path.join(OUT, VERSION, `${file}.sha256`), 'utf8')).toBe(`${sum}  ${file}\n`);
    }
  });

  for (const [platform, target, arch] of [
    ['linux/amd64', 'linux-x64', 'x64'],
    ['linux/arm64', 'linux-arm64', 'arm64'],
  ] as const) {
    it(`${target}: config.sh --help runs on the bundled Node`, async () => {
      await must(['pull', '--platform', platform, BASE], { timeoutMs: 300_000 });
      const r = await runInLinux(platform, target);
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('Usage: ./config.sh --url <server> --token <registration token>');
      expect(r.out).toContain(`arch=${arch} version=${VERSION} node=v22.`);
    });
  }

  it.runIf(process.platform === 'darwin' && process.arch === 'arm64')('macos-arm64: config.sh --help runs on the bundled Node', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-runner-tgz-'));
    try {
      execFileSync('tar', ['-xzf', tarball('macos-arm64'), '-C', dir]);
      const out = execFileSync('sh', [path.join(dir, 'config.sh'), '--help'], { env: { PATH: '/usr/bin:/bin' } }).toString();
      expect(out).toContain('Usage: ./config.sh --url <server> --token <registration token>');
      expect(execFileSync(path.join(dir, 'bin', 'node'), ['--version']).toString()).toMatch(/^v22\./);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
