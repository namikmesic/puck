import { afterEach, describe, expect, it } from 'vitest';
import { loopbackRedirect } from '../../src/server/auth';
import { call, pkcePair, signIn, startServer, type Harness } from './server-fakes';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function startSignIn(redirectUri = 'http://127.0.0.1:53123/callback') {
  const pkce = pkcePair();
  const start = await call(h, 'POST', '/v1/auth/github/start', {
    body: { redirectUri, codeChallenge: pkce.challenge, state: 'app-state' },
  });
  return { ...pkce, start };
}

async function callback(githubRedirect: string) {
  const u = new URL(githubRedirect);
  const res = await fetch(h.base + u.pathname + u.search, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), text: await res.text() };
}

describe('loopbackRedirect', () => {
  it.each([
    ['http://127.0.0.1:5000/callback', true],
    ['http://127.0.0.1:1/', true],
    ['http://localhost:5000/callback', false],
    ['https://127.0.0.1:5000/callback', false],
    ['http://127.0.0.1/callback', false],
    ['http://127.0.0.1:5000/callback?x=1', false],
    ['http://user@127.0.0.1:5000/callback', false],
    ['http://evil.example/callback', false],
    ['not a url', false],
  ])('%s → %s', (uri, ok) => {
    expect(loopbackRedirect(uri) !== null).toBe(ok);
  });
});

describe('web-flow sign-in', () => {
  it('signs in end to end and issues a working session', async () => {
    h = await startServer();
    h.github.addUser('namik');
    const s = await signIn(h, 'namik');
    expect(s.accessToken).toMatch(/^PSA_/);
    expect(s.refreshToken).toMatch(/^PSR_/);
    const me = await call(h, 'GET', '/v1/me', { token: s.accessToken });
    expect(me.body.user).toMatchObject({ login: 'namik' });
    const audit = await call(h, 'GET', '/v1/audit', { token: s.accessToken });
    expect((audit.body.events as { kind: string }[]).map((e) => e.kind)).toEqual(['session.created', 'user.sign-in']);
  });

  it('refuses redirect URIs that are not loopback and malformed challenges', async () => {
    h = await startServer();
    const bad = await startSignIn('http://localhost:53123/callback');
    expect(bad.start.status).toBe(400);
    expect(bad.start.body.error).toBe('invalid-redirect');
    const plain = await call(h, 'POST', '/v1/auth/github/start', {
      body: { redirectUri: 'http://127.0.0.1:1/cb', codeChallenge: 'short', state: 's' },
    });
    expect(plain.body.error).toBe('invalid-challenge');
  });

  it('returns the browser to the loopback URL with the app state and a one-time code', async () => {
    h = await startServer();
    h.github.addUser('namik');
    const { start } = await startSignIn();
    const authorize = new URL(String(start.body.authorizeUrl));
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://puck.test/v1/auth/github/callback');
    // The GitHub-facing state is the server's own, never the app's.
    expect(authorize.searchParams.get('state')).not.toBe('app-state');
    const cb = await callback(h.github.approve(String(start.body.authorizeUrl), 'namik'));
    expect(cb.status).toBe(302);
    const back = new URL(cb.location as string);
    expect(back.origin + back.pathname).toBe('http://127.0.0.1:53123/callback');
    expect(back.searchParams.get('state')).toBe('app-state');
    expect(back.searchParams.get('code')).toMatch(/^PSC_/);
  });

  it('honors a GitHub callback once, and not after it expires', async () => {
    h = await startServer();
    h.github.addUser('namik');
    const { start } = await startSignIn();
    const redirect = h.github.approve(String(start.body.authorizeUrl), 'namik');
    expect((await callback(redirect)).status).toBe(302);
    expect((await callback(redirect)).status).toBe(400);

    const late = await startSignIn();
    h.clock.advance(11 * 60_000);
    const cb = await callback(h.github.approve(String(late.start.body.authorizeUrl), 'namik'));
    expect(cb.status).toBe(400);
    expect(cb.text).toMatch(/expired/);
  });

  it('passes a denial back to the app', async () => {
    h = await startServer();
    const { start } = await startSignIn();
    const state = new URL(String(start.body.authorizeUrl)).searchParams.get('state');
    const cb = await callback(`http://x/v1/auth/github/callback?error=access_denied&state=${state}`);
    const back = new URL(cb.location as string);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('app-state');
  });

  it('requires the matching PKCE verifier and redeems a code once', async () => {
    h = await startServer();
    h.github.addUser('namik');
    const { start, verifier } = await startSignIn();
    const cb = await callback(h.github.approve(String(start.body.authorizeUrl), 'namik'));
    const code = new URL(cb.location as string).searchParams.get('code');
    const wrong = await call(h, 'POST', '/v1/auth/token', {
      body: { grant_type: 'authorization_code', code, code_verifier: pkcePair().verifier },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');
    // A failed attempt burns the code: it cannot be retried with the right verifier.
    const retry = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'authorization_code', code, code_verifier: verifier } });
    expect(retry.body.error).toBe('invalid_grant');
  });

  it('expires the one-time code after two minutes', async () => {
    h = await startServer();
    h.github.addUser('namik');
    const { start, verifier } = await startSignIn();
    const cb = await callback(h.github.approve(String(start.body.authorizeUrl), 'namik'));
    const code = new URL(cb.location as string).searchParams.get('code');
    h.clock.advance(2 * 60_000 + 1);
    const res = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'authorization_code', code, code_verifier: verifier } });
    expect(res.body.error).toBe('invalid_grant');
  });
});

describe('sessions', () => {
  it('expires the access token after 15 minutes and refreshes with rotation', async () => {
    h = await startServer();
    h.github.addUser('namik');
    const s = await signIn(h, 'namik');
    h.clock.advance(15 * 60_000);
    expect((await call(h, 'GET', '/v1/me', { token: s.accessToken })).status).toBe(401);
    const r = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'refresh_token', refresh_token: s.refreshToken } });
    expect(r.status).toBe(200);
    expect(r.body.refreshToken).not.toBe(s.refreshToken);
    expect((await call(h, 'GET', '/v1/me', { token: String(r.body.accessToken) })).status).toBe(200);
  });

  it('revokes the session when a rotated refresh token is presented again', async () => {
    h = await startServer();
    h.github.addUser('namik');
    const s = await signIn(h, 'namik');
    const r = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'refresh_token', refresh_token: s.refreshToken } });
    const reuse = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'refresh_token', refresh_token: s.refreshToken } });
    expect(reuse.body.error).toBe('invalid_grant');
    // The legitimate holder of the newer pair is signed out too.
    expect((await call(h, 'GET', '/v1/me', { token: String(r.body.accessToken) })).status).toBe(401);
    const again = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'refresh_token', refresh_token: r.body.refreshToken } });
    expect(again.body.error).toBe('invalid_grant');
  });

  it('signs out: the access and refresh tokens stop working', async () => {
    h = await startServer();
    h.github.addUser('namik');
    const s = await signIn(h, 'namik');
    expect((await call(h, 'POST', '/v1/auth/logout', { token: s.accessToken })).status).toBe(204);
    expect((await call(h, 'GET', '/v1/me', { token: s.accessToken })).status).toBe(401);
    const r = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'refresh_token', refresh_token: s.refreshToken } });
    expect(r.body.error).toBe('invalid_grant');
  });

  it('rejects tokens of the wrong kind before any lookup', async () => {
    h = await startServer();
    h.github.addUser('namik');
    const s = await signIn(h, 'namik');
    expect((await call(h, 'GET', '/v1/me', { token: s.refreshToken })).status).toBe(401);
    const r = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'refresh_token', refresh_token: s.accessToken } });
    expect(r.body.error).toBe('invalid_grant');
    const g = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'password' } });
    expect(g.body.error).toBe('unsupported_grant_type');
  });
});

describe('GitHub user-token custody', () => {
  it('hands out the access token and refreshes it single-flight near expiry', async () => {
    h = await startServer();
    h.github.addUser('namik');
    const s = await signIn(h, 'namik');
    const first = await call(h, 'GET', '/v1/github/token', { token: s.accessToken });
    expect(first.body.token).toMatch(/^ghu_/);
    expect(first.body).not.toHaveProperty('refreshToken');

    h.clock.advance(8 * 60 * 60_000 - 4 * 60_000); // inside the five-minute margin
    const fresh = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'refresh_token', refresh_token: s.refreshToken } });
    const token = String(fresh.body.accessToken);
    const both = await Promise.all([
      call(h, 'GET', '/v1/github/token', { token }),
      call(h, 'GET', '/v1/github/token', { token }),
    ]);
    expect(h.github.refreshCount).toBe(1);
    expect(both[0].body.token).toBe(both[1].body.token);
    expect(both[0].body.token).not.toBe(first.body.token);
  });

  it('reports github-auth-lost when GitHub rejects the refresh, and forgets the pair', async () => {
    h = await startServer();
    h.github.addUser('namik');
    h.github.tokenLifeMs = 60 * 60_000;
    const s = await signIn(h, 'namik');
    h.github.revokeAuthorizations();
    h.clock.advance(58 * 60_000);
    const fresh = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'refresh_token', refresh_token: s.refreshToken } });
    const res = await call(h, 'GET', '/v1/github/token', { token: String(fresh.body.accessToken) });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('github-auth-lost');
    expect(await h.server.ctx.store.getGitHubTokens(s.userId)).toBeNull();
  });

  it('never stores the GitHub tokens in plaintext', async () => {
    h = await startServer();
    h.github.addUser('namik');
    const s = await signIn(h, 'namik');
    const token = String((await call(h, 'GET', '/v1/github/token', { token: s.accessToken })).body.token);
    const blob = await h.server.ctx.store.getGitHubTokens(s.userId);
    expect(blob?.toString('latin1')).not.toContain(token);
    expect(h.logs.join('\n')).not.toContain(token);
  });
});

describe('without a GitHub App', () => {
  it('boots, answers the health check, and refuses GitHub routes with a clear code', async () => {
    h = await startServer({}, { github: false });
    const health = await call(h, 'GET', '/healthz');
    expect(health.body).toMatchObject({ ok: true, github: false });
    const start = await startSignIn();
    expect(start.start.status).toBe(503);
    expect(start.start.body.error).toBe('github-not-configured');
  });
});
