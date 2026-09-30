import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyFingerprint } from '../../src/channel/wire';
import { RunnerSession, ServerApi, type Fetch } from '../../src/puck-runner/api';
import { publicKeyOf } from '../../src/puck-runner/identity';

describe('runner token session', () => {
  it('signs the running version on initial exchange, refresh and invalidation', async () => {
    const pair = generateKeyPairSync('ed25519');
    const publicKey = publicKeyOf(pair.privateKey);
    const key = { privateKey: pair.privateKey, publicKey, fingerprint: keyFingerprint(publicKey) };
    let now = 1_800_000_000_000;
    const assertions: Record<string, unknown>[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      expect(input).toBe('https://puck.test/v1/runners/token');
      const { assertion } = JSON.parse(String(init?.body));
      const [head, body, sig] = assertion.split('.');
      expect(verify(null, Buffer.from(`${head}.${body}`), pair.publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
      assertions.push(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
      return new Response(JSON.stringify({ accessToken: `PRA_${assertions.length}`, expiresAt: now + 60 * 60_000 }));
    };
    const session = new RunnerSession(new ServerApi('https://puck.test', fetchImpl), 'rnr_test', key, 'https://puck.test', '0.2.0', () => now);
    expect(await Promise.all([session.accessToken(), session.accessToken()])).toEqual(['PRA_1', 'PRA_1']);
    expect(await session.accessToken()).toBe('PRA_1');
    now += 56 * 60_000;
    expect(await session.accessToken()).toBe('PRA_2');
    session.invalidate();
    expect(await session.accessToken()).toBe('PRA_3');
    expect(assertions).toHaveLength(3);
    for (const claims of assertions) {
      expect(claims).toMatchObject({ iss: 'rnr_test', sub: 'rnr_test', aud: 'https://puck.test/v1/runners/token', ver: '0.2.0' });
    }
    expect(new Set(assertions.map((claims) => claims.jti)).size).toBe(3);
  });
});
