import * as http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeProvider } from '../../src/main/providers/claude';
import { account } from '../../src/main/providers/claude-oauth';

// The login exchange end to end against the real transport: the browser
// callback lands on the loopback listener, the token exchange (a stubbed
// fetch) is in flight, and the user signs out. The exchange result must not
// sign the account back in, and no login must be announced to the app.

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });
}

const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

afterEach(async () => {
  vi.unstubAllGlobals();
  await claudeProvider.auth.logout();
});

describe('claude sign-in vs sign-out race', () => {
  it('discards a token exchange that completes after logout', async () => {
    let release!: (r: Response) => void;
    const exchange = new Promise<Response>((r) => (release = r));
    const fetchMock = vi.fn(() => exchange);
    vi.stubGlobal('fetch', fetchMock);
    const logins: string[] = [];
    claudeProvider.auth.setOnLogin(() => logins.push('login'));

    const authorize = new URL(await claudeProvider.auth.start());
    const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    const state = authorize.searchParams.get('state') ?? '';
    expect(claudeProvider.auth.status().pending).toBe(true);

    // The browser lands on the callback; the exchange starts and hangs.
    expect(await get(`http://127.0.0.1:${redirect.port}${redirect.pathname}?code=abc&state=${state}`)).toBe(200);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await claudeProvider.auth.logout();

    release(
      new Response(
        JSON.stringify({ access_token: 'late', refresh_token: 'r', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await settle();

    expect(account.load()).toBeNull();
    expect(logins).toEqual([]);
    expect(claudeProvider.auth.status()).toMatchObject({ connected: false, pending: false });
  });

  it('a sign-in started after the sign-out still lands', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'fresh', refresh_token: 'r', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const logins: string[] = [];
    claudeProvider.auth.setOnLogin(() => logins.push('login'));

    await claudeProvider.auth.logout(); // an earlier sign-out must not poison later sign-ins
    const url = await claudeProvider.auth.start();
    expect(url.startsWith(`${AUTHORIZE_URL}?`)).toBe(true);
    const authorize = new URL(url);
    const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
    const state = authorize.searchParams.get('state') ?? '';
    await get(`http://127.0.0.1:${redirect.port}${redirect.pathname}?code=abc&state=${state}`);
    await vi.waitFor(() => expect(account.load()?.accessToken).toBe('fresh'));
    expect(logins).toEqual(['login']);
    expect(fetchMock).toHaveBeenCalledWith(TOKEN_URL, expect.objectContaining({ method: 'POST' }));
  });

  it('refreshes stale tokens against the token address', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'renewed', refresh_token: 'r2', expires_in: 3600 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    account.save({ accessToken: 'stale', refreshToken: 'r', expiresAt: Date.now() - 1000, scopes: [] });

    expect((await account.getFreshTokens())?.accessToken).toBe('renewed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(TOKEN_URL, expect.objectContaining({ method: 'POST' }));
  });
});
