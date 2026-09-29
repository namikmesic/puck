import { describe, expect, it } from 'vitest';
import { RefreshRejectedError, tokensFrom } from '../../src/harness/github';

const NOW = 1_700_000_000_000;

describe('tokensFrom', () => {
  it('turns an access_token response into a pair with absolute expiries', () => {
    expect(
      tokensFrom(
        { access_token: 'ghu_access', expires_in: 28800, refresh_token: 'ghr_refresh', refresh_token_expires_in: 15897600, token_type: 'bearer' },
        NOW,
      ),
    ).toEqual({
      accessToken: 'ghu_access',
      expiresAt: NOW + 28_800_000,
      refreshToken: 'ghr_refresh',
      refreshExpiresAt: NOW + 15_897_600_000,
    });
  });

  it('keeps a token that does not expire, and one without a refresh token', () => {
    expect(tokensFrom({ access_token: 'gho_forever', refresh_token_expires_in: 60 }, NOW)).toEqual({
      accessToken: 'gho_forever',
      expiresAt: null,
      refreshToken: null,
      refreshExpiresAt: null,
    });
  });

  it('refuses a response without an access token', () => {
    expect(() => tokensFrom({ error: 'bad_verification_code' }, NOW)).toThrow(/no access token/);
    expect(() => tokensFrom({ access_token: '' }, NOW)).toThrow(/no access token/);
  });

  it('names a rejected refresh as signed out', () => {
    const err = new RefreshRejectedError();
    expect(err.name).toBe('RefreshRejectedError');
    expect(err.message).toMatch(/Sign in again/);
  });
});
