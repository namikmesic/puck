import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  acceptRunnerHandshake,
  ChannelCryptoError,
  MAX_PLAINTEXT_BYTES,
  startAppHandshake,
  type ChannelBinding,
} from '../../src/channel/e2e';
import { decodeData, encodeData, keyFingerprint, MAX_CIPHERTEXT_BYTES, rawKey, readdress } from '../../src/channel/wire';

function runnerKey() {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: 'jwk' }).x) };
}

const binding: ChannelBinding = { appCh: 7, kind: 'attach', envId: 'env_01' };

function pair(b: ChannelBinding = binding, runnerSees: ChannelBinding = b) {
  const key = runnerKey();
  const app = startAppHandshake();
  const runner = acceptRunnerHandshake(runnerSees, app.appEphemeralPub, key.privateKey);
  return { key, app, runner };
}

describe('channel handshake', () => {
  it('derives matching keys in both directions', () => {
    const { key, app, runner } = pair();
    const appCipher = app.finish(binding, runner.reply, key.publicKey);
    const up = appCipher.seal(Buffer.from('hello runner'));
    expect(runner.cipher.open(up.seq, up.ciphertext).toString()).toBe('hello runner');
    const down = runner.cipher.seal(Buffer.from('hello app'));
    expect(appCipher.open(down.seq, down.ciphertext).toString()).toBe('hello app');
    // The ciphertext carries no plaintext.
    expect(up.ciphertext.includes(Buffer.from('hello runner'))).toBe(false);
  });

  it('refuses a runner that cannot prove the listed key', () => {
    const { app, runner } = pair();
    const impostor = runnerKey();
    expect(() => app.finish(binding, runner.reply, impostor.publicKey)).toThrow(ChannelCryptoError);
  });

  it.each([
    ['another channel number', { ...binding, appCh: 8 }],
    ['another environment', { ...binding, envId: 'env_02' }],
    ['another kind', { ...binding, kind: 'control' as const, envId: null }],
  ])('refuses a handshake the runner signed for %s', (_what, runnerSees) => {
    const { key, app, runner } = pair(binding, runnerSees);
    expect(() => app.finish(binding, runner.reply, key.publicKey)).toThrow(/prove/);
  });

  it('refuses a swapped ephemeral key', () => {
    const { key, app, runner } = pair();
    const other = pair();
    const reply = { ...runner.reply, runnerEphemeralPub: other.runner.reply.runnerEphemeralPub };
    expect(() => app.finish(binding, reply, key.publicKey)).toThrow(ChannelCryptoError);
  });

  it('rejects malformed keys', () => {
    const key = runnerKey();
    expect(() => acceptRunnerHandshake(binding, 'short', key.privateKey)).toThrow(/ephemeral/);
  });
});

describe('channel frames', () => {
  function ciphers() {
    const { key, app, runner } = pair();
    return { a: app.finish(binding, runner.reply, key.publicKey), r: runner.cipher };
  }

  it('numbers frames from zero and accepts only the next one', () => {
    const { a, r } = ciphers();
    const f0 = a.seal(Buffer.from('0'));
    const f1 = a.seal(Buffer.from('1'));
    expect([f0.seq, f1.seq]).toEqual([0n, 1n]);
    expect(() => r.open(f1.seq, f1.ciphertext)).toThrow(/order/);
    expect(r.open(f0.seq, f0.ciphertext).toString()).toBe('0');
    expect(() => r.open(f0.seq, f0.ciphertext)).toThrow(/order/);
    expect(r.open(f1.seq, f1.ciphertext).toString()).toBe('1');
  });

  it('fails closed on tampering', () => {
    const { a, r } = ciphers();
    const f = a.seal(Buffer.from('payload'));
    const bad = Buffer.from(f.ciphertext);
    bad[0] ^= 1;
    expect(() => r.open(f.seq, bad)).toThrow(/authentication/);
    // A failed frame does not advance the counter: the genuine one still opens.
    expect(r.open(f.seq, f.ciphertext).toString()).toBe('payload');
  });

  it('keeps each direction separate', () => {
    const { a } = ciphers();
    const f = a.seal(Buffer.from('x'));
    expect(() => a.open(f.seq, f.ciphertext)).toThrow(/authentication/);
  });

  it('caps plaintext so a sealed frame fits the relay limit', () => {
    const { a } = ciphers();
    expect(a.seal(Buffer.alloc(MAX_PLAINTEXT_BYTES)).ciphertext.length).toBe(MAX_CIPHERTEXT_BYTES);
    expect(() => a.seal(Buffer.alloc(MAX_PLAINTEXT_BYTES + 1))).toThrow(/too large/);
  });
});

describe('wire', () => {
  it('encodes and readdresses data frames without touching seq or payload', () => {
    const frame = encodeData(5, 2n ** 40n, Buffer.from('abc'));
    const moved = readdress(frame, 9);
    expect(decodeData(moved)).toEqual({ ch: 9, seq: 2n ** 40n, payload: Buffer.from('abc') });
    expect(decodeData(frame)?.ch).toBe(5);
  });

  it('rejects empty and oversized frames', () => {
    expect(decodeData(Buffer.alloc(12))).toBeNull();
    expect(decodeData(Buffer.alloc(12 + MAX_CIPHERTEXT_BYTES + 1))).toBeNull();
  });

  it('fingerprints raw keys as SHA256:<base64>', () => {
    const { publicKey } = runnerKey();
    expect(rawKey(publicKey)).toHaveLength(32);
    expect(keyFingerprint(publicKey)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(rawKey('x'.repeat(43) + '=')).toBeNull();
  });
});
