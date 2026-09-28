/**
 * Identifiers and bearer secrets.
 *
 * Record ids are prefixed ULIDs (`usr_`, `rnr_`, `env_`, ...) so they sort
 * by creation time. Secrets are a prefix plus 32 random bytes in base62; the
 * prefix names the kind so a leaked value is recognizable in a scanner and a
 * token of the wrong kind is refused before any lookup. The store only ever
 * sees `hashSecret(value)`: every token is shown once and kept hashed.
 */

import { createHash, randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A 26-character ULID for `time` (epoch ms). */
export function ulid(time: number): string {
  let ts = '';
  let t = Math.floor(time);
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
  return ts + rand;
}

export type IdPrefix = 'usr' | 'ses' | 'rnr' | 'env' | 'reg' | 'aud';

export function newId(prefix: IdPrefix, time: number): string {
  return `${prefix}_${ulid(time)}`;
}

/**
 * Secret kinds: registration (PRT), removal (PRR), runner access (PRA),
 * session access (PSA) and refresh (PSR), and the one-time sign-in code (PSC).
 */
export type SecretPrefix = 'PRT' | 'PRR' | 'PRA' | 'PSA' | 'PSR' | 'PSC';

export function newSecret(prefix: SecretPrefix): string {
  // Rejection sampling keeps every base62 digit uniform.
  let out = '';
  while (out.length < 43) {
    for (const b of randomBytes(48)) {
      if (b < 248 && out.length < 43) out += BASE62[b % 62];
    }
  }
  return `${prefix}_${out}`;
}

export function hasPrefix(secret: string, prefix: SecretPrefix): boolean {
  return secret.startsWith(`${prefix}_`) && /^[A-Za-z0-9]{43}$/.test(secret.slice(4));
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function b64url(data: Buffer | Uint8Array | string): string {
  return Buffer.from(data).toString('base64url');
}

export function fromB64url(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}
