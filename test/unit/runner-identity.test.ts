import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ASSERTION_LIFE_S, signAssertion } from '../../src/puck-runner/identity';

describe('runner assertions', () => {
  it.each([undefined, '0.2.0'])('signs the optional version with the existing identity claims (ver=%s)', (version) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const now = 1_800_000_000_500;
    const aud = 'https://puck.test/v1/runners/token';
    const jwt = signAssertion('rnr_test', privateKey, aud, now, version);
    const [head, body, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(head, 'base64url').toString('utf8'))).toEqual({ alg: 'EdDSA', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    expect(claims).toEqual({
      iss: 'rnr_test', sub: 'rnr_test', aud,
      iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + ASSERTION_LIFE_S,
      jti: expect.any(String),
      ...(version === undefined ? {} : { ver: version }),
    });
    expect(verify(null, Buffer.from(`${head}.${body}`), publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    const next = signAssertion('rnr_test', privateKey, aud, now, version).split('.')[1];
    expect(JSON.parse(Buffer.from(next, 'base64url').toString('utf8')).jti).not.toBe(claims.jti);
  });
});
