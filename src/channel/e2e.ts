/**
 * End-to-end encryption for relay channels, between the app and a runner.
 * The Puck server routes the frames and never holds a key; it may not import
 * this module (lint enforces that).
 *
 * Handshake, carried in the relay's `open` and `accept` frames:
 * - The app makes an ephemeral X25519 key pair per channel and sends the
 *   public half in `open`.
 * - The runner makes its own ephemeral pair and signs the transcript with
 *   its long-lived Ed25519 runner key:
 *     "puck-channel-v1" ‖ appCh u32 ‖ kind ‖ envId ‖ appEphemeralPub ‖ runnerEphemeralPub
 *   `appCh` is the app's own channel number (the server forwards it beside
 *   the number it uses on the runner's socket), so both ends sign and check
 *   the same value. `kind` and `envId` bind the channel to its purpose, so a
 *   relay cannot turn an attach to one environment into another.
 * - The app verifies that signature against the runner public key the
 *   server lists for that runner. Pinning the key per install is the app's
 *   job; a server that lists a key it controls is the residual risk, made
 *   visible by the fingerprints in Settings and in the runner's output.
 *
 * Keys: HKDF-SHA256 over the X25519 secret, salted with the transcript
 * hash, gives one ChaCha20-Poly1305 key per direction. Each direction
 * numbers its frames from 0; the frame's `seq` is the nonce and the
 * receiver accepts only the next number, so a dropped, repeated or
 * reordered frame fails closed. Fresh keys per channel give forward
 * secrecy per channel.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { MAX_CIPHERTEXT_BYTES, rawKey, type ChannelKind } from './wire';

const LABEL = 'puck-channel-v1';
const TAG_BYTES = 16;
/** The largest plaintext one data frame can carry. */
export const MAX_PLAINTEXT_BYTES = MAX_CIPHERTEXT_BYTES - TAG_BYTES;

export class ChannelCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelCryptoError';
  }
}

export interface ChannelBinding {
  appCh: number;
  kind: ChannelKind;
  envId: string | null;
}

export interface SealedFrame {
  seq: bigint;
  ciphertext: Buffer;
}

export interface ChannelCipher {
  seal(plaintext: Uint8Array): SealedFrame;
  /** The plaintext, or ChannelCryptoError for a forged, repeated or out-of-order frame. */
  open(seq: bigint, ciphertext: Uint8Array): Buffer;
}

function publicRaw(key: KeyObject): string {
  const jwk = key.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') throw new ChannelCryptoError('key export failed');
  return jwk.x;
}

function x25519Public(text: string): KeyObject {
  if (!rawKey(text)) throw new ChannelCryptoError('malformed ephemeral key');
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: text }, format: 'jwk' });
}

/** A runner's Ed25519 public key from its raw base64url form. */
export function ed25519Public(text: string): KeyObject {
  if (!rawKey(text)) throw new ChannelCryptoError('malformed runner key');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: text }, format: 'jwk' });
}

function lengthPrefixed(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length);
  return Buffer.concat([len, body]);
}

export function transcript(b: ChannelBinding, appPub: string, runnerPub: string): Buffer {
  const ch = Buffer.alloc(4);
  ch.writeUInt32BE(b.appCh);
  return Buffer.concat([
    Buffer.from(LABEL),
    ch,
    lengthPrefixed(b.kind),
    lengthPrefixed(b.envId ?? ''),
    Buffer.from(appPub, 'base64url'),
    Buffer.from(runnerPub, 'base64url'),
  ]);
}

function nonce(seq: bigint): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(seq, 4);
  return n;
}

function cipherPair(sendKey: Buffer, recvKey: Buffer): ChannelCipher {
  let sendSeq = 0n;
  let recvSeq = 0n;
  return {
    seal(plaintext) {
      if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new ChannelCryptoError('frame too large');
      const seq = sendSeq++;
      const c = createCipheriv('chacha20-poly1305', sendKey, nonce(seq), { authTagLength: TAG_BYTES });
      const body = Buffer.concat([c.update(plaintext), c.final()]);
      return { seq, ciphertext: Buffer.concat([body, c.getAuthTag()]) };
    },
    open(seq, ciphertext) {
      if (seq !== recvSeq) throw new ChannelCryptoError('frame out of order');
      if (ciphertext.length < TAG_BYTES) throw new ChannelCryptoError('frame too short');
      const d = createDecipheriv('chacha20-poly1305', recvKey, nonce(seq), { authTagLength: TAG_BYTES });
      d.setAuthTag(Buffer.from(ciphertext.subarray(ciphertext.length - TAG_BYTES)));
      let out: Buffer;
      try {
        out = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)), d.final()]);
      } catch {
        throw new ChannelCryptoError('frame failed authentication');
      }
      recvSeq++;
      return out;
    },
  };
}

function directionKeys(secret: Buffer, t: Buffer): { appToRunner: Buffer; runnerToApp: Buffer } {
  if (secret.every((b) => b === 0)) throw new ChannelCryptoError('degenerate key exchange');
  const salt = createHash('sha256').update(t).digest();
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', secret, salt, info, 32));
  return { appToRunner: derive(`${LABEL} app->runner`), runnerToApp: derive(`${LABEL} runner->app`) };
}

/** The app's half: send `appEphemeralPub` in `open`, then `finish` with the runner's `accept`. */
export function startAppHandshake(): {
  appEphemeralPub: string;
  finish(binding: ChannelBinding, accept: { runnerEphemeralPub: string; sig: string }, runnerPublicKey: string): ChannelCipher;
} {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const appEphemeralPub = publicRaw(publicKey);
  return {
    appEphemeralPub,
    finish(binding, accept, runnerPublicKey) {
      const t = transcript(binding, appEphemeralPub, accept.runnerEphemeralPub);
      const sig = Buffer.from(String(accept.sig), 'base64url');
      if (!verify(null, t, ed25519Public(runnerPublicKey), sig)) {
        throw new ChannelCryptoError('the runner did not prove its key');
      }
      const secret = diffieHellman({ privateKey, publicKey: x25519Public(accept.runnerEphemeralPub) });
      const keys = directionKeys(secret, t);
      return cipherPair(keys.appToRunner, keys.runnerToApp);
    },
  };
}

/** The runner's half: answer an `open` with `reply` (sent in `accept`) and keep `cipher`. */
export function acceptRunnerHandshake(
  binding: ChannelBinding,
  appEphemeralPub: string,
  runnerKey: KeyObject,
): { reply: { runnerEphemeralPub: string; sig: string }; cipher: ChannelCipher } {
  const appKey = x25519Public(appEphemeralPub);
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const runnerEphemeralPub = publicRaw(publicKey);
  const t = transcript(binding, appEphemeralPub, runnerEphemeralPub);
  const sig = sign(null, t, runnerKey).toString('base64url');
  const keys = directionKeys(diffieHellman({ privateKey, publicKey: appKey }), t);
  return { reply: { runnerEphemeralPub, sig }, cipher: cipherPair(keys.runnerToApp, keys.appToRunner) };
}
