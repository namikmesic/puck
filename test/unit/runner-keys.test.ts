/**
 * Runner key pinning: the fingerprint pinned is the one of the key channels
 * are encrypted to, so a server that keeps a runner's fingerprint label but
 * lists another key is caught, and channels to that runner are refused.
 * Pins survive a runner missing from one listing and go only on removal.
 */

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyFingerprint } from '../../src/channel/wire';
import type { ServerRunner } from '../../src/harness/server-api';
import { onPush, row, transport } from '../../src/main/runners';
import { checkPinnedKey, normalizeRunners } from '../../src/main/runners/store';

const rawKey = (): string => {
  const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
  return jwk.x as string;
};

function runner(id: string, publicKey: string, over: Partial<ServerRunner> = {}): ServerRunner {
  return {
    id,
    name: 'build-box',
    labels: ['linux', 'x64'],
    os: 'linux',
    arch: 'x64',
    version: '0.1.0',
    publicKey,
    fingerprint: keyFingerprint(publicKey),
    maxEnvironments: null,
    docker: null,
    status: 'idle',
    running: 0,
    createdAt: 1,
    lastSeenAt: 1,
    ...over,
  };
}

describe('runner key pinning', () => {
  it('pins the key it encrypts to, and refuses channels when the listed key changes under the same label', () => {
    const id = 'rnr_01J8Z3X0000000000000000011';
    const first = rawKey();
    onPush({ type: 'runner.upsert', runner: runner(id, first) });
    expect(row(runner(id, first)).keyChanged).toBe(false);
    expect(transport(id).kind).toBe('relay');

    // Same fingerprint label, different key: the label is not what is trusted.
    const swapped = runner(id, rawKey(), { fingerprint: keyFingerprint(first) });
    onPush({ type: 'runner.upsert', runner: swapped });
    expect(row(swapped)).toMatchObject({ keyChanged: true, fingerprint: keyFingerprint(swapped.publicKey) });
    expect(() => transport(id)).toThrow(/different key/);
  });

  it('keeps a pin while a runner is absent, and drops it on removal', () => {
    const id = 'rnr_01J8Z3X0000000000000000012';
    const key = rawKey();
    onPush({ type: 'runner.upsert', runner: runner(id, key) });
    row(runner(id, key));
    const other = rawKey();
    expect(checkPinnedKey(id, keyFingerprint(other))).toBe(false);
    onPush({ type: 'runner.removed', runnerId: id });
    expect(() => transport(id)).toThrow(/does not know that runner/);
    // After removal a new registration may use a new key (it always gets a new id; the pin went anyway).
    expect(checkPinnedKey(id, keyFingerprint(other))).toBe(true);
  });

  it('loads older or damaged files leniently', () => {
    expect(normalizeRunners(null)).toEqual({ v: 1, keys: {}, local: null });
    expect(normalizeRunners({ keys: { a: 'SHA256:x', b: 3 }, local: { dir: '/d', socket: '/d/s' } })).toEqual({
      v: 1,
      keys: { a: 'SHA256:x' },
      local: { runnerId: null, dir: '/d', socket: '/d/s' },
    });
  });
});
