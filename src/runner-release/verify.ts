/**
 * Verifies a signed runner release (src/harness/runner-releases.ts)
 * against trust roots: the one check the Puck server, the app's main
 * process and the runner run before they trust a runner package. Node's
 * crypto only; the renderer and the daemon never import this directory
 * (.eslintrc.json).
 *
 * The order is the contract. Load the roots: Ed25519 SPKI public keys
 * only, at most MAX_RELEASE_KEYS, none twice. No roots means no trusted
 * publisher, and every release fails with `no-trusted-key`. Then bound the
 * input and verify the signature over the exact bytes as received. Only
 * then decode and read the manifest, whose signingKeyId must name the key
 * that verified it.
 *
 * `keys` defaults to the compiled RELEASE_KEYS. Only tests pass others.
 *
 * Only erasable TypeScript here: the build scripts load this file with
 * Node's type stripping (scripts/ts-resolve.mjs).
 */

import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import {
  checkSha256Sums,
  ED25519_SIGNATURE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_SUMS_BYTES,
  readRunnerRelease,
  RunnerReleaseError,
  type RunnerReleaseManifest,
} from '../harness/runner-releases';
import { MAX_RELEASE_KEYS, RELEASE_KEYS } from './trust';

export interface ReleaseKey {
  /** Lowercase hex SHA-256 of the key's DER SPKI (RELEASE_KEY_ID_RE). */
  id: string;
  key: KeyObject;
}

export interface VerifiedRunnerRelease {
  manifest: RunnerReleaseManifest;
  /** The trust root that verified it. */
  keyId: string;
}

const NO_TRUSTED_KEY = 'This build trusts no runner-release key, so it accepts no signed runner package.';
const PUBLIC_PEM_RE = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/;

/** A public key's release key id. `openssl pkey -pubin -outform DER | sha256sum` gives the same. */
export function releaseKeyId(key: KeyObject): string {
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
}

/** Loads trust roots, refusing anything but distinct Ed25519 SPKI public keys, and more than MAX_RELEASE_KEYS. */
export function loadReleaseKeys(pems: readonly string[]): ReleaseKey[] {
  if (pems.length > MAX_RELEASE_KEYS) throw new RunnerReleaseError('bad-key', `A build trusts at most ${MAX_RELEASE_KEYS} release keys; this one lists ${pems.length}.`);
  const keys: ReleaseKey[] = [];
  for (const pem of pems) {
    // A private key's PEM would load as its public half; only a public key block is a root.
    if (typeof pem !== 'string' || !PUBLIC_PEM_RE.test(pem.trim())) throw new RunnerReleaseError('bad-key', 'A release key must be one SPKI public key PEM block.');
    let key: KeyObject;
    try {
      key = createPublicKey({ key: pem, format: 'pem' });
    } catch {
      throw new RunnerReleaseError('bad-key', 'A release key PEM does not parse.');
    }
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
      throw new RunnerReleaseError('bad-key', `A release key must be Ed25519, not ${String(key.asymmetricKeyType)}.`);
    }
    const id = releaseKeyId(key);
    if (keys.some((k) => k.id === id)) throw new RunnerReleaseError('bad-key', `Release key ${id} is listed twice.`);
    keys.push({ id, key });
  }
  return keys;
}

/** The root whose Ed25519 signature `signature` is over exactly `bytes`. */
export function verifyDetached(bytes: Uint8Array, signature: Uint8Array, roots: readonly ReleaseKey[]): ReleaseKey {
  if (!roots.length) throw new RunnerReleaseError('no-trusted-key', NO_TRUSTED_KEY);
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new RunnerReleaseError('malformed', `A release signature is ${ED25519_SIGNATURE_BYTES} bytes; this one is ${signature.length}.`);
  }
  const root = roots.find((r) => verify(null, bytes, r.key, signature));
  if (!root) throw new RunnerReleaseError('bad-signature', 'No trusted runner-release key signed these bytes.');
  return root;
}

function decode(bytes: Uint8Array, what: string): string {
  try {
    // A byte-order mark stays in the text, so JSON.parse refuses it.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new RunnerReleaseError('malformed', `${what} is not UTF-8.`);
  }
}

/**
 * Verifies runner-release.json's exact bytes and detached signature, then
 * reads the manifest. Throws RunnerReleaseError.
 */
export function verifyRunnerRelease(bytes: Uint8Array, signature: Uint8Array, keys: readonly string[] = RELEASE_KEYS): VerifiedRunnerRelease {
  const roots = loadReleaseKeys(keys);
  if (!roots.length) throw new RunnerReleaseError('no-trusted-key', NO_TRUSTED_KEY);
  if (bytes.length > MAX_MANIFEST_BYTES) throw new RunnerReleaseError('malformed', `runner-release.json is over ${MAX_MANIFEST_BYTES} bytes.`);
  const root = verifyDetached(bytes, signature, roots);
  const manifest = readRunnerRelease(decode(bytes, 'runner-release.json'));
  if (manifest.signingKeyId !== root.id) {
    throw new RunnerReleaseError('key-id-mismatch', `runner-release.json names signing key ${manifest.signingKeyId}, but key ${root.id} signed it.`);
  }
  return { manifest, keyId: root.id };
}

/** Checks that SHA256SUMS's exact bytes are the file a verified manifest names, listing the same packages and digests. */
export function checkRunnerReleaseSums(manifest: RunnerReleaseManifest, sums: Uint8Array): void {
  if (sums.length > MAX_SUMS_BYTES) throw new RunnerReleaseError('sums-mismatch', `SHA256SUMS is over ${MAX_SUMS_BYTES} bytes.`);
  checkSha256Sums(manifest, decode(sums, 'SHA256SUMS'), createHash('sha256').update(sums).digest('hex'));
}

/**
 * Verifies SHA256SUMS's detached signature by the key the verified manifest
 * names (which must be a trust root), and that it agrees with the manifest.
 */
export function verifyRunnerReleaseSums(manifest: RunnerReleaseManifest, sums: Uint8Array, signature: Uint8Array, keys: readonly string[] = RELEASE_KEYS): void {
  const root = loadReleaseKeys(keys).filter((k) => k.id === manifest.signingKeyId);
  if (!root.length) throw new RunnerReleaseError('no-trusted-key', `Release key ${manifest.signingKeyId} is not trusted by this build.`);
  if (sums.length > MAX_SUMS_BYTES) throw new RunnerReleaseError('sums-mismatch', `SHA256SUMS is over ${MAX_SUMS_BYTES} bytes.`);
  verifyDetached(sums, signature, root);
  checkRunnerReleaseSums(manifest, sums);
}
