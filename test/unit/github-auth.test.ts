import { describe, expect, it } from 'vitest';
import {
  DEVICE_GRANT,
  DeviceFlowError,
  pollDeviceToken,
  RefreshRejectedError,
  refreshUserToken,
  requestDeviceCode,
  type DeviceCode,
} from '../../src/harness/github';
import { fakeGitHub, form } from './github-fakes';

const CODE_RESPONSE = {
  device_code: 'dev-123',
  user_code: 'WDJB-MJHT',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5,
};

const TOKEN_RESPONSE = {
  access_token: 'ghu_access',
  expires_in: 28800,
  refresh_token: 'ghr_refresh',
  refresh_token_expires_in: 15897600,
  token_type: 'bearer',
};

function code(gh: ReturnType<typeof fakeGitHub>, over: Partial<DeviceCode> = {}): DeviceCode {
  return {
    deviceCode: 'dev-123',
    userCode: 'WDJB-MJHT',
    verificationUri: 'https://github.com/login/device',
    expiresAt: gh.now() + 900_000,
    intervalMs: 5_000,
    ...over,
  };
}

describe('device flow: requesting the code', () => {
  it('sends the client id only and returns the code with the interval floored at 5 s', async () => {
    const gh = fakeGitHub([{ body: { ...CODE_RESPONSE, interval: 1 } }]);
    const got = await requestDeviceCode('Iv1.abc', gh.deps);
    expect(gh.requests[0].url).toBe('https://github.com/login/device/code');
    expect(gh.requests[0].method).toBe('POST');
    expect(form(gh.requests[0])).toEqual({ client_id: 'Iv1.abc' });
    expect(gh.requests[0].body).not.toMatch(/secret/);
    expect(got).toEqual({
      deviceCode: 'dev-123',
      userCode: 'WDJB-MJHT',
      verificationUri: 'https://github.com/login/device',
      expiresAt: gh.now() + 900_000,
      intervalMs: 5_000,
    });
  });

  it('refuses to show a code for any other verification page', async () => {
    for (const uri of ['https://evil.example/login/device', 'http://github.com/login/device', 'https://github.com/login/device/x']) {
      const gh = fakeGitHub([{ body: { ...CODE_RESPONSE, verification_uri: uri } }]);
      await expect(requestDeviceCode('Iv1.abc', gh.deps)).rejects.toThrow(/unexpected verification page/);
    }
  });

  it('reports a disabled device flow and non-JSON answers', async () => {
    const off = fakeGitHub([{ body: { error: 'device_flow_disabled', error_description: 'Device Flow must be explicitly enabled' } }]);
    await expect(requestDeviceCode('Iv1.abc', off.deps)).rejects.toMatchObject({ reason: 'unsupported' });
    const html = fakeGitHub([{ status: 502, body: '<html>bad gateway</html>' }]);
    await expect(requestDeviceCode('Iv1.abc', html.deps)).rejects.toThrow(/without JSON/);
  });
});

describe('device flow: polling', () => {
  it('waits the interval before every poll and continues while authorization is pending', async () => {
    const gh = fakeGitHub([
      { body: { error: 'authorization_pending' } },
      { body: { error: 'authorization_pending' } },
      { body: TOKEN_RESPONSE },
    ]);
    const start = gh.now();
    const tokens = await pollDeviceToken('Iv1.abc', code(gh), gh.deps);
    expect(gh.sleeps).toEqual([5_000, 5_000, 5_000]);
    expect(gh.requests.map((r) => r.url)).toEqual(Array(3).fill('https://github.com/login/oauth/access_token'));
    expect(form(gh.requests[0])).toEqual({ client_id: 'Iv1.abc', device_code: 'dev-123', grant_type: DEVICE_GRANT });
    expect(tokens).toEqual({
      accessToken: 'ghu_access',
      expiresAt: start + 15_000 + 28_800_000,
      refreshToken: 'ghr_refresh',
      refreshExpiresAt: start + 15_000 + 15_897_600_000,
    });
  });

  it('adds 5 s on slow_down, or takes the larger interval GitHub asks for', async () => {
    const gh = fakeGitHub([
      { body: { error: 'slow_down' } },
      { body: { error: 'slow_down', interval: 20 } },
      { body: { error: 'authorization_pending' } },
      { body: TOKEN_RESPONSE },
    ]);
    await pollDeviceToken('Iv1.abc', code(gh), gh.deps);
    expect(gh.sleeps).toEqual([5_000, 10_000, 20_000, 20_000]);
  });

  it('stops on expired_token and access_denied with the reason', async () => {
    const expired = fakeGitHub([{ body: { error: 'expired_token' } }]);
    await expect(pollDeviceToken('Iv1.abc', code(expired), expired.deps)).rejects.toMatchObject({
      name: 'DeviceFlowError',
      reason: 'expired_token',
    });
    const denied = fakeGitHub([{ body: { error: 'access_denied' } }]);
    await expect(pollDeviceToken('Iv1.abc', code(denied), denied.deps)).rejects.toMatchObject({
      reason: 'access_denied',
    });
  });

  it('stops by itself once the code has expired, without another poll', async () => {
    const gh = fakeGitHub(() => ({ body: { error: 'authorization_pending' } }));
    const err = await pollDeviceToken('Iv1.abc', code(gh, { expiresAt: gh.now() + 12_000 }), gh.deps).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect(err.reason).toBe('expired_token');
    expect(gh.requests).toHaveLength(2); // at +5 s and +10 s; +15 s is past expiry
  });

  it('an abort ends the poll with an AbortError', async () => {
    const abort = new AbortController();
    const gh = fakeGitHub(() => {
      abort.abort();
      return { body: { error: 'authorization_pending' } };
    });
    await expect(pollDeviceToken('Iv1.abc', code(gh), gh.deps, abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(gh.requests).toHaveLength(1);
  });
});

describe('refresh', () => {
  it('rotates the pair with client id, grant type and the refresh token only', async () => {
    const gh = fakeGitHub([{ body: { ...TOKEN_RESPONSE, access_token: 'ghu_new', refresh_token: 'ghr_new' } }]);
    const tokens = await refreshUserToken('Iv1.abc', 'ghr_old', gh.deps);
    expect(form(gh.requests[0])).toEqual({
      client_id: 'Iv1.abc',
      grant_type: 'refresh_token',
      refresh_token: 'ghr_old',
    });
    expect(tokens.accessToken).toBe('ghu_new');
    expect(tokens.refreshToken).toBe('ghr_new');
  });

  it('maps bad_refresh_token to a sign-out, and other errors to a failure', async () => {
    const bad = fakeGitHub([{ body: { error: 'bad_refresh_token' } }]);
    await expect(refreshUserToken('Iv1.abc', 'ghr_old', bad.deps)).rejects.toBeInstanceOf(RefreshRejectedError);
    const other = fakeGitHub([{ body: { error: 'unsupported_grant_type' } }]);
    const err = await refreshUserToken('Iv1.abc', 'ghr_old', other.deps).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect(err).not.toBeInstanceOf(RefreshRejectedError);
  });
});
