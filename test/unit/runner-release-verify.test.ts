import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatRunnerRelease,
  formatSha256Sums,
  MAX_MANIFEST_BYTES,
  RUNNER_TARGETS,
  runnerPackageFile,
  RunnerReleaseError,
  type RunnerReleaseErrorCode,
  type RunnerReleaseManifest,
} from '../../src/harness/runner-releases';
import { MAX_RELEASE_KEYS, RELEASE_KEYS } from '../../src/runner-release/trust';
import { checkRunnerReleaseSums, loadReleaseKeys, releaseKeyId, verifyRunnerRelease, verifyRunnerReleaseSums } from '../../src/runner-release/verify';

// The shared runner-release verifier. test/fixtures/runner-release is a
// complete signed release (placeholder packages) signed once by a throwaway
// key whose private half was never written down; its public key sits beside
// it as release-public.pem. Other tests sign with keys made here.

const root = join(__dirname, '..', '..');
const FIXTURE = join(root, 'test', 'fixtures', 'runner-release');
const fixture = (name: string): Buffer => readFileSync(join(FIXTURE, name));
const FIXTURE_KEY = fixture('release-public.pem').toString('utf8');
const MANIFEST = fixture('runner-release.json');
const MANIFEST_SIG = fixture('runner-release.json.sig');
const SUMS = fixture('SHA256SUMS');
const SUMS_SIG = fixture('SHA256SUMS.sig');

interface TestKey {
  privateKey: KeyObject;
  pem: string;
  id: string;
}

function ed25519(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, pem: publicKey.export({ type: 'spki', format: 'pem' }) as string, id: releaseKeyId(publicKey) };
}

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

function release(signingKeyId: string, overrides: Record<string, unknown> = {}): { manifest: RunnerReleaseManifest; sums: Buffer } {
  const version = '2.0.0';
  const assets = RUNNER_TARGETS.map((t, i) => ({ os: t.os, arch: t.arch, file: runnerPackageFile(t, version), sha256: sha256(`package ${i}`), size: 100 + i }));
  const sums = Buffer.from(formatSha256Sums(assets));
  const manifest = {
    schemaVersion: 1,
    product: 'puck-runner',
    publisher: 'namikmesic/puck',
    version,
    sourceCommit: 'f'.repeat(40),
    runnerProtocol: 1,
    signingKeyId,
    sha256sumsSha256: sha256(sums),
    assets,
    ...overrides,
  } as RunnerReleaseManifest;
  return { manifest, sums };
}

const signed = (bytes: Buffer | string, key: TestKey): { bytes: Buffer; sig: Buffer } => {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return { bytes: buf, sig: sign(null, buf, key.privateKey) };
};

function failure(fn: () => unknown): { code: RunnerReleaseErrorCode; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof RunnerReleaseError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('expected a RunnerReleaseError');
}

describe('compiled trust roots', () => {
  it('start empty: no publisher is trusted, and no test key is compiled in', () => {
    expect(RELEASE_KEYS).toEqual([]);
    expect(Object.isFrozen(RELEASE_KEYS)).toBe(true);
    expect(RELEASE_KEYS).not.toContain(FIXTURE_KEY);
  });

  it('fail closed: a validly signed release is refused by the default roots', () => {
    expect(failure(() => verifyRunnerRelease(MANIFEST, MANIFEST_SIG))).toEqual({
      code: 'no-trusted-key',
      message: 'This build trusts no runner-release key, so it accepts no signed runner package.',
    });
    expect(failure(() => verifyRunnerRelease(MANIFEST, MANIFEST_SIG, [])).code).toBe('no-trusted-key');
    const { manifest } = verifyRunnerRelease(MANIFEST, MANIFEST_SIG, [FIXTURE_KEY]);
    expect(failure(() => verifyRunnerReleaseSums(manifest, SUMS, SUMS_SIG)).code).toBe('no-trusted-key');
  });
});

describe('verifyRunnerRelease', () => {
  it('verifies the committed fixture with its key', () => {
    const { manifest, keyId } = verifyRunnerRelease(MANIFEST, MANIFEST_SIG, [FIXTURE_KEY]);
    expect(keyId).toBe(manifest.signingKeyId);
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.assets.map((a) => `${a.os}-${a.arch}`)).toEqual(['linux-x64', 'linux-arm64', 'macos-arm64']);
    expect(() => verifyRunnerReleaseSums(manifest, SUMS, SUMS_SIG, [FIXTURE_KEY])).not.toThrow();
  });

  it('verifies the exact bytes: a re-serialised or re-encoded copy of the same document is refused', () => {
    const doc = MANIFEST.toString('utf8');
    for (const copy of [
      JSON.stringify(JSON.parse(doc)),
      JSON.stringify(JSON.parse(doc), null, 2) + '\n\n',
      doc.replace(/\n/g, '\r\n'),
      doc.trimEnd(),
      doc + ' ',
      `\ufeff${doc}`,
    ]) {
      expect(failure(() => verifyRunnerRelease(Buffer.from(copy), MANIFEST_SIG, [FIXTURE_KEY])).code).toBe('bad-signature');
    }
    const flipped = Buffer.from(MANIFEST);
    flipped[flipped.length - 3] ^= 1;
    expect(failure(() => verifyRunnerRelease(flipped, MANIFEST_SIG, [FIXTURE_KEY])).code).toBe('bad-signature');
  });

  it('verifies before it reads: unsigned garbage is a bad signature, not a parse error', () => {
    const key = ed25519();
    expect(failure(() => verifyRunnerRelease(Buffer.from('not json'), Buffer.alloc(64), [key.pem])).code).toBe('bad-signature');
  });

  it('refuses a signature by an untrusted key, and accepts any one trusted key', () => {
    const trusted = ed25519();
    const other = ed25519();
    const { manifest } = release(other.id);
    const { bytes, sig } = signed(formatRunnerRelease(manifest), other);
    expect(failure(() => verifyRunnerRelease(bytes, sig, [trusted.pem])).code).toBe('bad-signature');
    expect(verifyRunnerRelease(bytes, sig, [trusted.pem, other.pem]).keyId).toBe(other.id);
  });

  it('requires the signed key id to name the key that verified it', () => {
    const signer = ed25519();
    const named = ed25519();
    const { bytes, sig } = signed(formatRunnerRelease(release(named.id).manifest), signer);
    expect(failure(() => verifyRunnerRelease(bytes, sig, [signer.pem, named.pem]))).toEqual({
      code: 'key-id-mismatch',
      message: `runner-release.json names signing key ${named.id}, but key ${signer.id} signed it.`,
    });
  });

  it('refuses a signed manifest for another product or publisher', () => {
    const key = ed25519();
    const product = signed(JSON.stringify(release(key.id, { product: 'puck-server' }).manifest), key);
    expect(failure(() => verifyRunnerRelease(product.bytes, product.sig, [key.pem])).code).toBe('wrong-product');
    const publisher = signed(JSON.stringify(release(key.id, { publisher: 'fork/puck' }).manifest), key);
    expect(failure(() => verifyRunnerRelease(publisher.bytes, publisher.sig, [key.pem])).code).toBe('wrong-publisher');
  });

  it('refuses malformed signatures and encodings', () => {
    const key = ed25519();
    const { bytes, sig } = signed(formatRunnerRelease(release(key.id).manifest), key);
    for (const bad of [Buffer.alloc(0), sig.subarray(0, 63), Buffer.concat([sig, Buffer.alloc(1)]), Buffer.from(sig.toString('base64'))]) {
      expect(failure(() => verifyRunnerRelease(bytes, bad, [key.pem])).code).toBe('malformed');
    }
    for (const body of [Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]), Buffer.from('{"schemaVersion":1'), Buffer.from('[]')]) {
      const s = signed(body, key);
      expect(failure(() => verifyRunnerRelease(s.bytes, s.sig, [key.pem])).code).toBe('malformed');
    }
  });

  it('refuses an oversized manifest before verifying it', () => {
    const key = ed25519();
    const s = signed(Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20), key);
    expect(failure(() => verifyRunnerRelease(s.bytes, s.sig, [key.pem])).message).toMatch(/over 262144 bytes/);
  });
});

describe('trust root loading', () => {
  it('derives the key id from the DER SPKI', () => {
    const [key] = loadReleaseKeys([FIXTURE_KEY]);
    expect(key.id).toBe(JSON.parse(MANIFEST.toString('utf8')).signingKeyId);
    expect(key.id).toBe(sha256(key.key.export({ type: 'spki', format: 'der' })));
  });

  it('takes Ed25519 SPKI public keys only', () => {
    const pems = [
      generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }),
      generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }),
      generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'pem' }),
      generateKeyPairSync('ed448').publicKey.export({ type: 'spki', format: 'pem' }),
    ] as string[];
    for (const pem of pems) expect(failure(() => loadReleaseKeys([pem])).message).toMatch(/must be Ed25519/);
  });

  it('refuses a private key, a PKCS#1 key, garbage, and two blocks in one entry', () => {
    const key = generateKeyPairSync('ed25519');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    for (const pem of [key.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, rsa, 'not a key', `${FIXTURE_KEY}${ed25519().pem}`, '']) {
      expect(failure(() => loadReleaseKeys([pem])).code).toBe('bad-key');
    }
    const corrupt = FIXTURE_KEY.replace(/[A-Za-z]/, (c) => (c === 'A' ? 'B' : 'A'));
    expect(failure(() => loadReleaseKeys([corrupt])).code).toBe('bad-key');
  });

  it('refuses the same key twice and more than MAX_RELEASE_KEYS keys', () => {
    expect(failure(() => loadReleaseKeys([FIXTURE_KEY, FIXTURE_KEY])).message).toMatch(/listed twice/);
    const many = Array.from({ length: MAX_RELEASE_KEYS + 1 }, () => ed25519().pem);
    expect(failure(() => loadReleaseKeys(many)).message).toMatch(`at most ${MAX_RELEASE_KEYS}`);
    expect(loadReleaseKeys(many.slice(0, MAX_RELEASE_KEYS))).toHaveLength(MAX_RELEASE_KEYS);
  });
});

describe('SHA256SUMS', () => {
  it('requires the signature of the key the manifest names', () => {
    const signer = ed25519();
    const other = ed25519();
    const { manifest, sums } = release(signer.id);
    expect(() => verifyRunnerReleaseSums(manifest, sums, sign(null, sums, signer.privateKey), [signer.pem, other.pem])).not.toThrow();
    expect(failure(() => verifyRunnerReleaseSums(manifest, sums, sign(null, sums, other.privateKey), [signer.pem, other.pem])).code).toBe('bad-signature');
    expect(failure(() => verifyRunnerReleaseSums(manifest, sums, sign(null, sums, signer.privateKey), [other.pem])).code).toBe('no-trusted-key');
  });

  it('refuses signed sums that the manifest does not name', () => {
    const signer = ed25519();
    const { manifest } = release(signer.id);
    const altered = Buffer.from(formatSha256Sums(manifest.assets.map((a, i) => (i ? a : { ...a, sha256: sha256('other') }))));
    expect(failure(() => verifyRunnerReleaseSums(manifest, altered, sign(null, altered, signer.privateKey), [signer.pem])).code).toBe('sums-mismatch');
  });

  it('checks agreement on the exact bytes', () => {
    const { manifest, sums } = release('a'.repeat(64));
    expect(() => checkRunnerReleaseSums(manifest, sums)).not.toThrow();
    expect(failure(() => checkRunnerReleaseSums(manifest, Buffer.from(sums.toString('utf8').replace(/\n/g, '\r\n')))).code).toBe('sums-mismatch');
    expect(failure(() => checkRunnerReleaseSums(manifest, Buffer.alloc(17 * 1024, 0x61))).message).toMatch(/over 16384 bytes/);
  });
});

describe('OpenSSL interoperability', () => {
  const probe = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  const opensslVersion = probe.status === 0 ? probe.stdout.trim() : null;
  const major = Number(/^OpenSSL (\d+)\./.exec(opensslVersion ?? '')?.[1] ?? 0);
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const openssl = (args: string[]): { status: number | null; out: string } => {
    const r = spawnSync('openssl', args, { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it('OpenSSL 3 verifies the committed fixture, derives the same key id, and signs what Node verifies', (ctx) => {
    if (major < 3) ctx.skip(`needs an OpenSSL 3 binary on PATH for pkeyutl -rawin; openssl version printed ${JSON.stringify(opensslVersion ?? 'nothing')}`);
    const dir = mkdtempSync(join(tmpdir(), 'puck-openssl-'));
    dirs.push(dir);
    const pub = join(FIXTURE, 'release-public.pem');
    for (const name of ['runner-release.json', 'SHA256SUMS']) {
      const r = openssl(['pkeyutl', '-verify', '-pubin', '-inkey', pub, '-rawin', '-in', join(FIXTURE, name), '-sigfile', join(FIXTURE, `${name}.sig`)]);
      expect(r.status, r.out).toBe(0);
    }
    const tampered = join(dir, 'runner-release.json');
    writeFileSync(tampered, MANIFEST.toString('utf8').replace('0.1.0', '0.1.1'));
    expect(openssl(['pkeyutl', '-verify', '-pubin', '-inkey', pub, '-rawin', '-in', tampered, '-sigfile', join(FIXTURE, 'runner-release.json.sig')]).status).not.toBe(0);

    const der = execFileSync('openssl', ['pkey', '-pubin', '-in', pub, '-outform', 'DER']);
    expect(sha256(der)).toBe(JSON.parse(MANIFEST.toString('utf8')).signingKeyId);

    const key = ed25519();
    const priv = join(dir, 'private.pem');
    writeFileSync(priv, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const manifestFile = join(dir, 'signed.json');
    writeFileSync(manifestFile, formatRunnerRelease(release(key.id).manifest));
    const r = openssl(['pkeyutl', '-sign', '-inkey', priv, '-rawin', '-in', manifestFile, '-out', join(dir, 'signed.json.sig')]);
    expect(r.status, r.out).toBe(0);
    expect(verifyRunnerRelease(readFileSync(manifestFile), readFileSync(join(dir, 'signed.json.sig')), [key.pem]).keyId).toBe(key.id);
  });
});
