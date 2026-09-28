/**
 * The runner credential: an Ed25519 key pair generated at registration.
 * The private key stays in `.runner_key` (0600); the server keeps only the
 * raw public key. The runner proves itself by signing a short JWT
 * assertion (EdDSA; iss = sub = runnerId; audience the server's own URL
 * plus the endpoint path; at most five minutes; a fresh `jti` every time),
 * which the server exchanges for a one-hour runner access token or accepts
 * for `config.sh remove`. The same key signs each channel handshake
 * (src/channel/e2e.ts).
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import * as fs from 'node:fs';
import { keyFingerprint } from '../channel/wire';
import { writeFileAtomic, type RunnerPaths } from './files';

/** Kept under the server's five-minute limit. */
export const ASSERTION_LIFE_S = 240;

export interface RunnerKey {
  privateKey: KeyObject;
  /** Raw 32-byte public key, base64url: what the server stores. */
  publicKey: string;
  fingerprint: string;
}

export function publicKeyOf(privateKey: KeyObject): string {
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new Error('not an Ed25519 key');
  return jwk.x;
}

function fromPrivate(privateKey: KeyObject): RunnerKey {
  const publicKey = publicKeyOf(privateKey);
  return { privateKey, publicKey, fingerprint: keyFingerprint(publicKey) };
}

/** A new key pair, written to `.runner_key` (0600) before anything is sent anywhere. */
export function createRunnerKey(paths: RunnerPaths): RunnerKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileAtomic(paths.key, privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600);
  return fromPrivate(privateKey);
}

export function loadRunnerKey(paths: RunnerPaths): RunnerKey {
  const pem = fs.readFileSync(paths.key, 'utf8');
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('.runner_key is not an Ed25519 key.');
  return fromPrivate(key);
}

const b64url = (v: string | Buffer): string => Buffer.from(v).toString('base64url');

export function signAssertion(runnerId: string, key: KeyObject, audience: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: runnerId, sub: runnerId, aud: audience, iat, exp: iat + ASSERTION_LIFE_S, jti: randomUUID() }));
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}
