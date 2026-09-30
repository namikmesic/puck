#!/usr/bin/env node
/**
 * Signing tooling for runner releases (src/harness/runner-releases.ts).
 * Ordinary CI and development packaging never run it; `sign` is the
 * explicit maintainer step after `npm run package:runner:release`. Run it
 * as `npm run runner-release -- <command>`, or directly as
 * `node scripts/runner-release.mjs <command>`:
 *
 *   node scripts/runner-release.mjs keygen [--out <dir>]
 *     Makes an Ed25519 release key pair and prints it with its key id: the
 *     private key (PKCS#8 PEM) goes straight into the maintainer's secret
 *     store, and the public key (SPKI PEM) into RELEASE_KEYS in
 *     src/runner-release/trust.ts. With --out it writes
 *     <dir>/runner-release-private.pem (mode 0600) and
 *     <dir>/runner-release-public.pem instead, and never overwrites a file.
 *
 *   node scripts/runner-release.mjs sign <dir>
 *     Signs <dir>/runner-release.json and <dir>/SHA256SUMS with the private
 *     key in PUCK_RUNNER_RELEASE_PRIVATE_KEY (its PEM text), writing the two
 *     .sig files: 64-byte detached Ed25519 signatures over each file's
 *     exact bytes. Refuses without that key, when its public key is not
 *     committed in RELEASE_KEYS, when the manifest names another key, and
 *     when the manifest, SHA256SUMS, the .sha256 files and the packages
 *     disagree. Then it verifies the result as a consumer would.
 *
 *   node scripts/runner-release.mjs verify <dir>
 *     Verifies <dir> against the committed RELEASE_KEYS: both signatures,
 *     and that the manifest, SHA256SUMS, the .sha256 files and the packages
 *     agree byte for byte. With no committed key it fails, because no
 *     publisher is trusted.
 *
 * The same checks run standalone with OpenSSL 3:
 *
 *   openssl pkeyutl -verify -pubin -inkey release-public.pem -rawin \
 *     -in runner-release.json -sigfile runner-release.json.sig
 *
 * A private key never belongs in the repository, an image, the app or a
 * runner.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  formatRunnerRelease,
  readRunnerRelease,
  RUNNER_RELEASE_MANIFEST,
  RUNNER_RELEASE_PRODUCT,
  RUNNER_RELEASE_PUBLISHER,
  RUNNER_RELEASE_SCHEMA_VERSION,
  RUNNER_RELEASE_SUMS,
  RUNNER_TARGETS,
  runnerPackageFile,
  SIGNATURE_SUFFIX,
  targetName,
} from '../src/harness/runner-releases.ts';
import { registerTsResolution } from './ts-resolve.mjs';

registerTsResolution();
const { RELEASE_KEYS } = await import('../src/runner-release/trust.ts');
const { checkRunnerReleaseSums, loadReleaseKeys, releaseKeyId, verifyRunnerRelease, verifyRunnerReleaseSums } = await import('../src/runner-release/verify.ts');

/** The committed trust roots and their loader, for scripts/package-runner.mjs (which cannot import src/runner-release statically). */
export { loadReleaseKeys, RELEASE_KEYS };

export const PRIVATE_KEY_ENV = 'PUCK_RUNNER_RELEASE_PRIVATE_KEY';
export const PRIVATE_KEY_FILE = 'runner-release-private.pem';
export const PUBLIC_KEY_FILE = 'runner-release-public.pem';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function readReleaseFile(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) throw new Error(`${dir} has no ${name}.`);
  return fs.readFileSync(file);
}

/** A fresh Ed25519 release key pair and its key id. */
export function generateReleaseKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    keyId: releaseKeyId(publicKey),
  };
}

/** Makes a key pair; returns what to print. With `out`, writes the two files there instead of printing the private key. */
export function keygen({ out } = {}) {
  const { privateKeyPem, publicKeyPem, keyId } = generateReleaseKey();
  if (!out) {
    return [
      `# Runner release key ${keyId}`,
      `# Private key (PKCS#8): keep it only in the maintainer's secret store, as ${PRIVATE_KEY_ENV}. Never commit it.`,
      privateKeyPem.trimEnd(),
      '# Public key (SPKI): add it to RELEASE_KEYS in src/runner-release/trust.ts.',
      publicKeyPem.trimEnd(),
      '',
    ].join('\n');
  }
  const privateFile = path.join(out, PRIVATE_KEY_FILE);
  const publicFile = path.join(out, PUBLIC_KEY_FILE);
  for (const file of [privateFile, publicFile]) if (fs.existsSync(file)) throw new Error(`${file} exists; keygen never overwrites a key.`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(privateFile, privateKeyPem, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(publicFile, publicKeyPem, { flag: 'wx', mode: 0o644 });
  return [
    `# Runner release key ${keyId}`,
    `# Private key: ${privateFile} (keep it out of the repository; sign reads it from ${PRIVATE_KEY_ENV})`,
    `# Public key: ${publicFile} (add it to RELEASE_KEYS in src/runner-release/trust.ts)`,
    publicKeyPem.trimEnd(),
    '',
  ].join('\n');
}

/**
 * Checks a release directory against a manifest: every package present
 * with the manifest's size and sha256, its .sha256 file matching, and
 * SHA256SUMS the file the manifest names, listing the same digests.
 */
export function checkReleaseDir(dir, manifest) {
  for (const asset of manifest.assets) {
    const bytes = readReleaseFile(dir, asset.file);
    if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) {
      throw new Error(`${asset.file} is not the package runner-release.json describes (${bytes.length} bytes, sha256 ${sha256(bytes)}): it is stale or altered.`);
    }
    const sidecar = readReleaseFile(dir, `${asset.file}.sha256`).toString('utf8');
    if (sidecar !== `${asset.sha256}  ${asset.file}\n`) throw new Error(`${asset.file}.sha256 does not match ${asset.file}.`);
  }
  checkRunnerReleaseSums(manifest, readReleaseFile(dir, RUNNER_RELEASE_SUMS));
}

/**
 * Writes <dir>/runner-release.json for the packages there, from their
 * bytes on disk: all three targets present, their .sha256 files and
 * SHA256SUMS agreeing with those bytes. Returns the manifest.
 */
export function writeReleaseManifest(dir, { version, sourceCommit, runnerProtocol, signingKeyId }) {
  const assets = RUNNER_TARGETS.map((target) => {
    const file = runnerPackageFile(target, version);
    if (!fs.existsSync(path.join(dir, file))) throw new Error(`${dir} has no ${targetName(target)} package (${file}); a release carries all three.`);
    const bytes = fs.readFileSync(path.join(dir, file));
    return { os: target.os, arch: target.arch, file, sha256: sha256(bytes), size: bytes.length };
  });
  const text = formatRunnerRelease({
    schemaVersion: RUNNER_RELEASE_SCHEMA_VERSION,
    product: RUNNER_RELEASE_PRODUCT,
    publisher: RUNNER_RELEASE_PUBLISHER,
    version,
    sourceCommit,
    runnerProtocol,
    signingKeyId,
    sha256sumsSha256: sha256(readReleaseFile(dir, RUNNER_RELEASE_SUMS)),
    assets,
  });
  const manifest = readRunnerRelease(text);
  checkReleaseDir(dir, manifest);
  fs.writeFileSync(path.join(dir, RUNNER_RELEASE_MANIFEST), text);
  return manifest;
}

/** The private key in `pem`: PKCS#8, Ed25519. */
function releasePrivateKey(pem) {
  if (!pem?.trim()) throw new Error(`Signing needs the release private key: set ${PRIVATE_KEY_ENV} to its PKCS#8 PEM.`);
  if (!pem.trim().startsWith('-----BEGIN PRIVATE KEY-----')) throw new Error(`${PRIVATE_KEY_ENV} is not an unencrypted PKCS#8 private key PEM.`);
  let key;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new Error(`${PRIVATE_KEY_ENV} does not parse as a private key.`);
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`The release key must be Ed25519, not ${key.asymmetricKeyType}.`);
  return key;
}

/**
 * Signs a packaged release directory (see the header). `keys` is the
 * committed RELEASE_KEYS; only tests pass others.
 */
export function signRelease(dir, { privateKeyPem, keys = RELEASE_KEYS } = {}) {
  const privateKey = releasePrivateKey(privateKeyPem);
  const keyId = releaseKeyId(createPublicKey(privateKey));
  const roots = loadReleaseKeys(keys);
  if (!roots.some((root) => root.id === keyId)) {
    throw new Error(
      roots.length
        ? `Release key ${keyId} is not committed in RELEASE_KEYS (src/runner-release/trust.ts), so its signatures would be refused.`
        : `No release key is committed in RELEASE_KEYS (src/runner-release/trust.ts), so nothing would accept a signature. Commit the public key of ${keyId} first.`,
    );
  }
  const manifestBytes = readReleaseFile(dir, RUNNER_RELEASE_MANIFEST);
  const manifest = readRunnerRelease(utf8.decode(manifestBytes));
  if (manifest.signingKeyId !== keyId) {
    throw new Error(`runner-release.json names signing key ${manifest.signingKeyId}, not ${keyId}. Package again with --signing-key-id ${keyId}.`);
  }
  checkReleaseDir(dir, manifest);
  const sums = readReleaseFile(dir, RUNNER_RELEASE_SUMS);
  fs.writeFileSync(path.join(dir, RUNNER_RELEASE_MANIFEST + SIGNATURE_SUFFIX), sign(null, manifestBytes, privateKey));
  fs.writeFileSync(path.join(dir, RUNNER_RELEASE_SUMS + SIGNATURE_SUFFIX), sign(null, sums, privateKey));
  return verifyReleaseDir(dir, { keys });
}

/**
 * Verifies a signed release directory (see the header). `keys` is the
 * committed RELEASE_KEYS; only tests pass others.
 */
export function verifyReleaseDir(dir, { keys = RELEASE_KEYS } = {}) {
  const { manifest, keyId } = verifyRunnerRelease(
    readReleaseFile(dir, RUNNER_RELEASE_MANIFEST),
    readReleaseFile(dir, RUNNER_RELEASE_MANIFEST + SIGNATURE_SUFFIX),
    keys,
  );
  verifyRunnerReleaseSums(manifest, readReleaseFile(dir, RUNNER_RELEASE_SUMS), readReleaseFile(dir, RUNNER_RELEASE_SUMS + SIGNATURE_SUFFIX), keys);
  checkReleaseDir(dir, manifest);
  return { manifest, keyId };
}

const USAGE = `Usage: npm run runner-release -- keygen [--out <dir>]
       npm run runner-release -- sign <dir>      (the key comes from ${PRIVATE_KEY_ENV})
       npm run runner-release -- verify <dir>
`;

function releaseDir(args) {
  const { positionals } = parseArgs({ args, allowPositionals: true, strict: true });
  if (positionals.length !== 1) throw new Error(`Name one release directory.\n${USAGE}`);
  return path.resolve(positionals[0]);
}

/** The command line; returns the exit code. */
export function main(argv, env, print = (text) => process.stdout.write(text)) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'keygen': {
      const { values } = parseArgs({ args: rest, options: { out: { type: 'string' } }, strict: true });
      print(keygen({ out: values.out && path.resolve(values.out) }));
      return 0;
    }
    case 'sign': {
      const dir = releaseDir(rest);
      const { manifest, keyId } = signRelease(dir, { privateKeyPem: env[PRIVATE_KEY_ENV] });
      print(`Signed runner ${manifest.version} in ${dir} with release key ${keyId}.\n`);
      return 0;
    }
    case 'verify': {
      const dir = releaseDir(rest);
      const { manifest, keyId } = verifyReleaseDir(dir);
      print(`Runner ${manifest.version} in ${dir} is signed by release key ${keyId}, and its files match.\n`);
      return 0;
    }
    case 'help':
    case '--help':
    case '-h':
      print(USAGE);
      return 0;
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
