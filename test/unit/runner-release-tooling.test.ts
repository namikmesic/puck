import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatSha256Sums, RUNNER_TARGETS, targetName } from '../../src/harness/runner-releases';
import { releaseKeyId, verifyRunnerRelease } from '../../src/runner-release/verify';
import { buildRunner } from '../../scripts/build-runner.mjs';
import { packageRunner, signingKeyIdFor, TARGETS } from '../../scripts/package-runner.mjs';
import { checkReleaseDir, generateReleaseKey, keygen, PRIVATE_KEY_ENV, signRelease, verifyReleaseDir, writeReleaseManifest } from '../../scripts/runner-release.mjs';

// The release tooling: scripts/package-runner.mjs (trust mode, the
// manifest from the final archives) and scripts/runner-release.mjs
// (keygen, sign, verify). packageRunner runs here with a stand-in bundle
// and Node runtime; the real bundle's probe is covered by CI's packaged
// macOS tarball and the Docker suite.

const root = join(__dirname, '..', '..');
const FIXTURE = join(root, 'test', 'fixtures', 'runner-release');
const VERSION = '9.8.7';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'puck-release-'));
  dirs.push(dir);
  return dir;
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface TestKey {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
}

const releaseKey = (): TestKey => generateReleaseKey();

/** A stand-in for scripts/build-runner.mjs: a bundle whose `version --json` reports `reports` (the built mode by default). */
function fakeBuild(reports?: { trustMode?: string; version?: string }) {
  const calls: string[] = [];
  const build = async ({ mode }: { mode: string }) => {
    calls.push(mode);
    const dir = tmp();
    const bundlePath = join(dir, 'puck-runner.cjs');
    const probe = JSON.stringify({ version: reports?.version ?? VERSION, trustMode: reports?.trustMode ?? mode, runnerProtocol: 7 });
    writeFileSync(bundlePath, `// stand-in runner bundle\nprocess.stdout.write(${JSON.stringify(probe + '\n')});\n`);
    return { bundlePath, version: VERSION };
  };
  return { build, calls };
}

const runtime = async (target: { node: string }) => ({ node: Buffer.from(`#!/bin/sh\n# node for ${target.node}\n`), license: Buffer.from('Node.js license\n') });
const noCommit = (): string => {
  throw new Error('development packaging must not ask for the source commit');
};

/** The entries of a gzipped ustar archive. */
function untar(gz: Buffer): Map<string, { mode: number; mtime: number; body: Buffer }> {
  const tar = gunzipSync(gz);
  const field = (h: Buffer, at: number, len: number) => h.subarray(at, at + len).toString('utf8').replace(/\0.*$/s, '');
  const out = new Map<string, { mode: number; mtime: number; body: Buffer }>();
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(field(header, 124, 12), 8);
    out.set(field(header, 0, 100), { mode: parseInt(field(header, 100, 8), 8), mtime: parseInt(field(header, 136, 12), 8), body: tar.subarray(at + 512, at + 512 + size) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function production(key: TestKey, outDir = tmp()) {
  return packageRunner({ mode: 'production', outDir, build: fakeBuild().build, runtime, commit: () => COMMIT, keys: [key.publicKeyPem] });
}

describe('package-runner trust mode', () => {
  it('fails on a missing or unknown mode before building anything', async () => {
    const { build, calls } = fakeBuild();
    await expect(packageRunner({ outDir: tmp(), build, runtime })).rejects.toThrow("Pick the runner's trust mode: --mode development or --mode production.");
    await expect(packageRunner({ mode: 'staging', outDir: tmp(), build, runtime })).rejects.toThrow('Unknown runner trust mode "staging"');
    await expect(packageRunner({ mode: 'Production', outDir: tmp(), build, runtime })).rejects.toThrow(/Unknown runner trust mode/);
    expect(calls).toEqual([]);
    await expect(buildRunner()).rejects.toThrow(/Pick the runner's trust mode/);
    await expect(buildRunner({ mode: 'test' })).rejects.toThrow(/Unknown runner trust mode "test"/);
  });

  it('fails when the built bundle reports another mode or version', async () => {
    await expect(packageRunner({ mode: 'development', outDir: tmp(), build: fakeBuild({ trustMode: 'production' }).build, runtime })).rejects.toThrow(
      `The built runner reports ${VERSION} (production), not ${VERSION} (development).`,
    );
    await expect(packageRunner({ mode: 'development', outDir: tmp(), build: fakeBuild({ version: '1.0.0' }).build, runtime })).rejects.toThrow(/reports 1.0.0/);
  });

  it('names the same targets as the release format', () => {
    expect(Object.keys(TARGETS)).toEqual(RUNNER_TARGETS.map(targetName));
    for (const target of RUNNER_TARGETS) expect(TARGETS[targetName(target)]).toMatchObject(target);
  });
});

describe('package-runner, development', () => {
  it('needs no key, writes no manifest, and removes one left by an earlier run', async () => {
    const outDir = tmp();
    const dest = join(outDir, VERSION);
    cpSync(FIXTURE, dest, { recursive: true });
    const { build, calls } = fakeBuild();
    const result = await packageRunner({ mode: 'development', targets: ['macos-arm64'], outDir, build, runtime, commit: noCommit, keys: [] });
    expect(calls).toEqual(['development']);
    expect(result.trustMode).toBe('development');
    expect(result.manifest).toBeNull();
    for (const stale of ['runner-release.json', 'runner-release.json.sig', 'SHA256SUMS.sig']) expect(existsSync(join(dest, stale))).toBe(false);
    const file = `puck-runner-macos-arm64-${VERSION}.tar.gz`;
    const sum = sha256(readFileSync(join(dest, file)));
    expect(readFileSync(join(dest, 'SHA256SUMS'), 'utf8')).toBe(`${sum}  ${file}\n`);
    expect(readFileSync(join(dest, `${file}.sha256`), 'utf8')).toBe(`${sum}  ${file}\n`);
  });

  it('lists a subset of targets in the canonical order and refuses unknown ones', async () => {
    const outDir = tmp();
    await packageRunner({ mode: 'development', targets: ['macos-arm64', 'linux-x64'], outDir, build: fakeBuild().build, runtime, keys: [] });
    const files = readFileSync(join(outDir, VERSION, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.split('  ')[1]);
    expect(files).toEqual([`puck-runner-linux-x64-${VERSION}.tar.gz`, `puck-runner-macos-arm64-${VERSION}.tar.gz`]);
    await expect(packageRunner({ mode: 'development', targets: ['windows-x64'], outDir, build: fakeBuild().build, runtime })).rejects.toThrow(/Unknown target windows-x64/);
  });
});

describe('package-runner, production', () => {
  it('writes runner-release.json from the final archives', async () => {
    const key = releaseKey();
    const { dir, manifest, files } = await production(key);
    expect(files).toHaveLength(3);
    const text = readFileSync(join(dir, 'runner-release.json'), 'utf8');
    expect(JSON.parse(text)).toEqual(manifest);
    expect(manifest).toMatchObject({ version: VERSION, sourceCommit: COMMIT, runnerProtocol: 7, signingKeyId: key.keyId });
    expect(manifest.sha256sumsSha256).toBe(sha256(readFileSync(join(dir, 'SHA256SUMS'))));
    for (const asset of manifest.assets) {
      const bytes = readFileSync(join(dir, asset.file));
      expect(asset.size).toBe(bytes.length);
      expect(asset.size).toBe(statSync(join(dir, asset.file)).size);
      expect(asset.sha256).toBe(sha256(bytes));
    }
    expect(readdirSync(dir).sort()).toEqual([
      'SHA256SUMS',
      ...manifest.assets.flatMap((a: { file: string }) => [a.file, `${a.file}.sha256`]),
      'runner-release.json',
    ].sort());
  });

  it('puts the one runner bundle, byte for byte, in every target package', async () => {
    const { dir, manifest } = await production(releaseKey());
    const bundles = manifest.assets.map((a: { file: string }) => untar(readFileSync(join(dir, a.file))));
    const first = bundles[0].get('bin/puck-runner.cjs')?.body ?? Buffer.alloc(0);
    expect(first.toString()).toContain('stand-in runner bundle');
    for (const entries of bundles) {
      expect([...entries.keys()]).toEqual(['config.sh', 'run.sh', 'svc.sh', 'VERSION', 'README.md', 'LICENSE', 'bin/', 'bin/node', 'bin/node.LICENSE', 'bin/puck-runner.cjs']);
      expect(entries.get('bin/puck-runner.cjs')?.body.equals(first)).toBe(true);
      expect(entries.get('VERSION')?.body.toString()).toBe(`${VERSION}\n`);
    }
    expect(bundles.map((e: Map<string, { body: Buffer }>) => e.get('bin/node')?.body.toString())).toEqual([
      '#!/bin/sh\n# node for linux-x64\n',
      '#!/bin/sh\n# node for linux-arm64\n',
      '#!/bin/sh\n# node for darwin-arm64\n',
    ]);
  });

  it('gives the same bytes on every run under SOURCE_DATE_EPOCH', async () => {
    vi.stubEnv('SOURCE_DATE_EPOCH', '1700000000');
    const key = releaseKey();
    const a = await production(key);
    const b = await production(key);
    const names = readdirSync(a.dir).sort();
    expect(readdirSync(b.dir).sort()).toEqual(names);
    for (const name of names) expect(readFileSync(join(b.dir, name)).equals(readFileSync(join(a.dir, name))), name).toBe(true);
    for (const entry of untar(readFileSync(a.files[0])).values()) expect(entry.mtime).toBe(1700000000);
    vi.stubEnv('SOURCE_DATE_EPOCH', 'soon');
    await expect(production(key)).rejects.toThrow(/SOURCE_DATE_EPOCH must be whole seconds/);
  });

  it('carries all three targets or refuses', async () => {
    const key = releaseKey();
    const { build, calls } = fakeBuild();
    await expect(
      packageRunner({ mode: 'production', targets: ['macos-arm64'], outDir: tmp(), build, runtime, commit: () => COMMIT, keys: [key.publicKeyPem] }),
    ).rejects.toThrow('A production release carries all three targets (linux-x64, linux-arm64, macos-arm64); drop --targets.');
    expect(calls).toEqual([]);
  });

  it('names a committed signing key, or fails while none is committed and none is named', async () => {
    const key = releaseKey();
    const other = releaseKey();
    expect(signingKeyIdFor(undefined, [key.publicKeyPem])).toBe(key.keyId);
    expect(signingKeyIdFor(key.keyId, [key.publicKeyPem, other.publicKeyPem])).toBe(key.keyId);
    expect(signingKeyIdFor(key.keyId, [])).toBe(key.keyId);
    expect(() => signingKeyIdFor(undefined, [])).toThrow(/No release key is committed in RELEASE_KEYS/);
    expect(() => signingKeyIdFor(undefined, [key.publicKeyPem, other.publicKeyPem])).toThrow(/commits 2 keys; name the signing key/);
    expect(() => signingKeyIdFor(other.keyId, [key.publicKeyPem])).toThrow(/is not committed/);
    expect(() => signingKeyIdFor('KEY', [])).toThrow(/64 lowercase hex digits/);
    const { build, calls } = fakeBuild();
    await expect(packageRunner({ mode: 'production', outDir: tmp(), build, runtime, commit: () => COMMIT, keys: [] })).rejects.toThrow(/No release key is committed/);
    expect(calls).toEqual([]);
  });
});

describe('release manifest from a directory', () => {
  async function packaged() {
    const key = releaseKey();
    const { dir, manifest } = await production(key);
    return { key, dir, manifest };
  }

  it('fails when a target is missing', async () => {
    const { dir, manifest } = await packaged();
    rmSync(join(dir, `puck-runner-macos-arm64-${VERSION}.tar.gz`));
    expect(() => writeReleaseManifest(dir, manifest)).toThrow(`${dir} has no macos-arm64 package (puck-runner-macos-arm64-${VERSION}.tar.gz); a release carries all three.`);
  });

  it('fails when a package is stale against its .sha256 file or SHA256SUMS', async () => {
    const { dir, manifest } = await packaged();
    const file = join(dir, `puck-runner-linux-arm64-${VERSION}.tar.gz`);
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('x')]));
    expect(() => writeReleaseManifest(dir, manifest)).toThrow(/\.sha256 does not match|disagree/);
    expect(() => checkReleaseDir(dir, manifest)).toThrow(/stale or altered/);
  });

  it('fails when SHA256SUMS lists something else', async () => {
    const { dir, manifest } = await packaged();
    writeFileSync(join(dir, 'SHA256SUMS'), readFileSync(join(dir, 'SHA256SUMS'), 'utf8') + `${'0'.repeat(64)}  extra.tar.gz\n`);
    expect(() => writeReleaseManifest(dir, manifest)).toThrow(/lists 4 files/);
  });
});

describe('runner-release sign and verify', () => {
  it('signs a packaged release so the shared verifier accepts it, with detached 64-byte signatures', async () => {
    const key = releaseKey();
    const { dir } = await production(key);
    const { manifest, keyId } = signRelease(dir, { privateKeyPem: key.privateKeyPem, keys: [key.publicKeyPem] });
    expect(keyId).toBe(key.keyId);
    expect(manifest.version).toBe(VERSION);
    expect(readFileSync(join(dir, 'runner-release.json.sig'))).toHaveLength(64);
    expect(readFileSync(join(dir, 'SHA256SUMS.sig'))).toHaveLength(64);
    expect(verifyRunnerRelease(readFileSync(join(dir, 'runner-release.json')), readFileSync(join(dir, 'runner-release.json.sig')), [key.publicKeyPem]).keyId).toBe(key.keyId);
    expect(verifyReleaseDir(dir, { keys: [key.publicKeyPem] }).keyId).toBe(key.keyId);
  });

  it('verifies the committed fixture only with its key', () => {
    const pem = readFileSync(join(FIXTURE, 'release-public.pem'), 'utf8');
    expect(verifyReleaseDir(FIXTURE, { keys: [pem] }).manifest.version).toBe('0.1.0');
    expect(() => verifyReleaseDir(FIXTURE)).toThrow('This build trusts no runner-release key');
    expect(() => verifyReleaseDir(FIXTURE, { keys: [releaseKey().publicKeyPem] })).toThrow('No trusted runner-release key signed these bytes.');
  });

  it('refuses to sign without a key', async () => {
    const { dir } = await production(releaseKey());
    for (const privateKeyPem of [undefined, '', '  \n']) {
      expect(() => signRelease(dir, { privateKeyPem, keys: [] })).toThrow(`Signing needs the release private key: set ${PRIVATE_KEY_ENV} to its PKCS#8 PEM.`);
    }
    expect(existsSync(join(dir, 'runner-release.json.sig'))).toBe(false);
  });

  it('refuses a key that is not committed, not Ed25519, or not a private key', async () => {
    const key = releaseKey();
    const { dir } = await production(key);
    expect(() => signRelease(dir, { privateKeyPem: key.privateKeyPem, keys: [] })).toThrow(/No release key is committed in RELEASE_KEYS/);
    expect(() => signRelease(dir, { privateKeyPem: key.privateKeyPem, keys: [releaseKey().publicKeyPem] })).toThrow(`Release key ${key.keyId} is not committed`);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey as KeyObject;
    expect(() => signRelease(dir, { privateKeyPem: rsa.export({ type: 'pkcs8', format: 'pem' }) as string, keys: [key.publicKeyPem] })).toThrow(/must be Ed25519, not rsa/);
    expect(() => signRelease(dir, { privateKeyPem: key.publicKeyPem, keys: [key.publicKeyPem] })).toThrow(/not an unencrypted PKCS#8 private key/);
    expect(existsSync(join(dir, 'runner-release.json.sig'))).toBe(false);
  });

  it('refuses a manifest that names another key, or disagrees with the files', async () => {
    const key = releaseKey();
    const other = releaseKey();
    const { dir } = await production(key);
    expect(() => signRelease(dir, { privateKeyPem: other.privateKeyPem, keys: [key.publicKeyPem, other.publicKeyPem] })).toThrow(
      `runner-release.json names signing key ${key.keyId}, not ${other.keyId}.`,
    );
    const file = join(dir, `puck-runner-linux-x64-${VERSION}.tar.gz`);
    writeFileSync(file, 'altered');
    expect(() => signRelease(dir, { privateKeyPem: key.privateKeyPem, keys: [key.publicKeyPem] })).toThrow(/stale or altered/);
    expect(existsSync(join(dir, 'runner-release.json.sig'))).toBe(false);
  });

  it('refuses a signed release whose files changed afterwards', async () => {
    const key = releaseKey();
    const { dir } = await production(key);
    signRelease(dir, { privateKeyPem: key.privateKeyPem, keys: [key.publicKeyPem] });
    const sidecar = join(dir, `puck-runner-macos-arm64-${VERSION}.tar.gz.sha256`);
    writeFileSync(sidecar, `${'0'.repeat(64)}  puck-runner-macos-arm64-${VERSION}.tar.gz\n`);
    expect(() => verifyReleaseDir(dir, { keys: [key.publicKeyPem] })).toThrow(/\.sha256 does not match/);
    const sums = join(dir, 'SHA256SUMS');
    writeFileSync(sums, formatSha256Sums([]));
    expect(() => verifyReleaseDir(dir, { keys: [key.publicKeyPem] })).toThrow('No trusted runner-release key signed these bytes.');
  });
});

describe('runner-release command line', () => {
  const cli = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(root, 'scripts', 'runner-release.mjs'), ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it('keygen prints a PEM pair and the key id', () => {
    const r = cli(['keygen']);
    expect(r.status, r.stderr).toBe(0);
    const pub = /-----BEGIN PUBLIC KEY-----\n[^-]+-----END PUBLIC KEY-----\n/.exec(r.stdout)?.[0] ?? '';
    expect(r.stdout).toMatch(/-----BEGIN PRIVATE KEY-----\n[^-]+-----END PRIVATE KEY-----/);
    const id = /# Runner release key ([0-9a-f]{64})/.exec(r.stdout)?.[1];
    expect(id).toBe(releaseKeyId(createPublicKey(pub)));
  });

  it('keygen --out writes the private key 0600 and never overwrites', () => {
    const out = join(tmp(), 'keys');
    const r = cli(['keygen', '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('PRIVATE KEY-----');
    expect(statSync(join(out, 'runner-release-private.pem')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(out, 'runner-release-public.pem'), 'utf8')).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    const again = cli(['keygen', '--out', out]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/exists; keygen never overwrites a key/);
  });

  it('keygen output is a usable key pair', () => {
    const text = keygen();
    const priv = /-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/.exec(text)?.[0];
    const pub = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/.exec(text)?.[0];
    expect(priv && pub).toBeTruthy();
    expect(text).toContain(`add it to RELEASE_KEYS in src/runner-release/trust.ts`);
  });

  it('sign fails clearly without the private key, and while no public key is committed', () => {
    const dir = tmp();
    cpSync(FIXTURE, dir, { recursive: true });
    const without = cli(['sign', dir]);
    expect(without.status).toBe(1);
    expect(without.stderr).toContain(`set ${PRIVATE_KEY_ENV}`);
    const key = releaseKey();
    const uncommitted = cli(['sign', dir], { [PRIVATE_KEY_ENV]: key.privateKeyPem });
    expect(uncommitted.status).toBe(1);
    expect(uncommitted.stderr).toContain('No release key is committed in RELEASE_KEYS');
    expect(readFileSync(join(dir, 'runner-release.json.sig')).equals(readFileSync(join(FIXTURE, 'runner-release.json.sig')))).toBe(true);
  });

  it('verify fails closed against the empty committed roots', () => {
    const r = cli(['verify', FIXTURE]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('This build trusts no runner-release key');
  });

  it('prints usage for an unknown command', () => {
    const r = cli(['publish']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('npm run runner-release -- sign <dir>');
  });
});

describe('package-runner command line', () => {
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(root, 'scripts', 'package-runner.mjs'), ...args], { encoding: 'utf8' });

  it('fails without a mode or with an unknown one', () => {
    const missing = cli(['--targets', 'macos-arm64']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Pick the runner's trust mode: --mode development or --mode production.");
    const unknown = cli(['--mode', 'release']);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Unknown runner trust mode "release"');
  });

  it('fails production packaging while no release key is committed or named', () => {
    const r = cli(['--mode', 'production']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No release key is committed in RELEASE_KEYS');
  });
});
