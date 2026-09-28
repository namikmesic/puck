/**
 * Signing in to Puck with GitHub's web flow, and Puck sessions.
 *
 * 1. The app opens its loopback listener and calls `POST /v1/auth/github/start`
 *    with that redirect URI, a PKCE S256 challenge and its own state. The
 *    server keeps the request under a fresh GitHub `state` of its own and
 *    returns GitHub's authorize URL, which the app opens in the browser.
 * 2. GitHub sends the browser to `/v1/auth/github/callback`. The server
 *    exchanges the code with the client secret, keeps the user's token pair
 *    sealed (user-tokens.ts), upserts the user by GitHub id, and redirects
 *    the browser to the app's loopback URL with a one-time Puck code (two
 *    minutes) and the app's state.
 * 3. The app redeems the code with its PKCE verifier at `POST /v1/auth/token`
 *    and gets a 15-minute access token and a 30-day refresh token. Refresh
 *    rotates both; presenting a refresh token that was already rotated away
 *    revokes the whole session, since only a copy could still hold it.
 *
 * Only loopback redirect URIs (`http://127.0.0.1:<any port>/...`) are
 * accepted, so the one-time code can only land on the machine that asked.
 * `GET /v1/github/token` hands the app the user's current GitHub *access*
 * token for its own API calls; the refresh token never leaves the server.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { authenticate, requireGitHub, sessionFor, type ServerContext } from './context';
import { GitHubSignInError } from './github';
import { HttpError, str, type Router } from './http';
import { b64url, hashSecret, hasPrefix, newId, newSecret } from './ids';
import { GitHubAuthLostError } from './user-tokens';

export const SIGN_IN_REQUEST_TTL_MS = 10 * 60_000;
export const SIGN_IN_CODE_TTL_MS = 2 * 60_000;
export const ACCESS_TTL_MS = 15 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
export const CALLBACK_PATH = '/v1/auth/github/callback';

/** An `http://127.0.0.1:<port>/<path>` URL with nothing else in it, or null. */
export function loopbackRedirect(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) return null;
  if (url.username || url.password || url.hash || url.search) return null;
  return url.toString();
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function withParams(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

export function registerAuthRoutes(router: Router, ctx: ServerContext): void {
  router.add('POST', '/v1/auth/github/start', async (req) => {
    const { github } = requireGitHub(ctx);
    const body = await req.json();
    const redirectUri = loopbackRedirect(str(body, 'redirectUri', { max: 512 }));
    if (!redirectUri) throw new HttpError(400, 'invalid-redirect', 'redirectUri must be http://127.0.0.1:<port>/<path>.');
    const method = str(body, 'codeChallengeMethod', { optional: true }) ?? 'S256';
    const codeChallenge = str(body, 'codeChallenge');
    if (method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      throw new HttpError(400, 'invalid-challenge', 'codeChallenge must be an S256 PKCE challenge.');
    }
    const appState = str(body, 'state', { max: 256 });
    const state = b64url(randomBytes(32));
    const expiresAt = ctx.clock.now() + SIGN_IN_REQUEST_TTL_MS;
    await ctx.store.putSignInRequest(hashSecret(state), { redirectUri, codeChallenge, appState, expiresAt });
    return { body: { authorizeUrl: github.authorizeUrl(state, ctx.config.publicUrl + CALLBACK_PATH), expiresAt } };
  });

  router.add('GET', CALLBACK_PATH, async (req) => {
    const { github, custody } = requireGitHub(ctx);
    const state = req.query.get('state') ?? '';
    const request = state ? await ctx.store.takeSignInRequest(hashSecret(state)) : null;
    if (!request || request.expiresAt <= ctx.clock.now()) {
      return { status: 400, text: 'This sign-in link has expired or was already used. Start signing in again from Puck.' };
    }
    const back = (params: Record<string, string>) => ({ redirect: withParams(request.redirectUri, { ...params, state: request.appState }) });
    const denied = req.query.get('error');
    const code = req.query.get('code');
    if (denied || !code) return back({ error: denied === 'access_denied' ? 'access_denied' : 'server_error' });
    try {
      const tokens = await github.exchangeCode(code, ctx.config.publicUrl + CALLBACK_PATH);
      const ghUser = await github.user(tokens.accessToken);
      const now = ctx.clock.now();
      const user = await ctx.store.upsertUser(ghUser.id, ghUser.login, newId('usr', now), now);
      await custody.save(user.id, tokens);
      const puckCode = newSecret('PSC');
      await ctx.store.putSignInCode(hashSecret(puckCode), {
        userId: user.id,
        codeChallenge: request.codeChallenge,
        redirectUri: request.redirectUri,
        expiresAt: now + SIGN_IN_CODE_TTL_MS,
      });
      await ctx.audit('user.sign-in', { userId: user.id, detail: { githubId: ghUser.id, login: ghUser.login } });
      return back({ code: puckCode });
    } catch (err) {
      ctx.log.warn('github sign-in failed', { reason: err instanceof GitHubSignInError ? err.reason : 'error' });
      return back({ error: 'server_error' });
    }
  });

  router.add('POST', '/v1/auth/token', async (req) => {
    const body = await req.json();
    const grant = str(body, 'grant_type', { max: 64 });
    const invalid = (message: string) => new HttpError(400, 'invalid_grant', message);
    const now = ctx.clock.now();
    const pair = () => {
      const accessToken = newSecret('PSA');
      const refreshToken = newSecret('PSR');
      return { accessToken, refreshToken, accessExpiresAt: now + ACCESS_TTL_MS, refreshExpiresAt: now + REFRESH_TTL_MS };
    };

    if (grant === 'authorization_code') {
      const code = str(body, 'code', { max: 128 });
      const verifier = str(body, 'code_verifier', { max: 128 });
      const redeemed = hasPrefix(code, 'PSC') ? await ctx.store.takeSignInCode(hashSecret(code)) : null;
      if (!redeemed || redeemed.expiresAt <= now) throw invalid('The sign-in code is unknown, used or expired.');
      if (verifier.length < 43 || !sameText(pkceChallenge(verifier), redeemed.codeChallenge)) {
        throw invalid('The PKCE verifier does not match.');
      }
      const user = await ctx.store.getUser(redeemed.userId);
      if (!user) throw invalid('The user no longer exists.');
      const p = pair();
      const session = { id: newId('ses', now), userId: user.id, accessExpiresAt: p.accessExpiresAt, refreshExpiresAt: p.refreshExpiresAt, createdAt: now, revokedAt: null };
      await ctx.store.createSession(session, hashSecret(p.accessToken), hashSecret(p.refreshToken));
      await ctx.audit('session.created', { userId: user.id, detail: { sessionId: session.id } });
      return { body: { ...p, user: { id: user.id, login: user.login } } };
    }

    if (grant === 'refresh_token') {
      const refresh = str(body, 'refresh_token', { max: 128 });
      if (!hasPrefix(refresh, 'PSR')) throw invalid('The refresh token is unknown.');
      const p = pair();
      const out = await ctx.store.rotateRefresh(
        hashSecret(refresh),
        { accessHash: hashSecret(p.accessToken), refreshHash: hashSecret(p.refreshToken), accessExpiresAt: p.accessExpiresAt, refreshExpiresAt: p.refreshExpiresAt },
        now,
      );
      if (!out) throw invalid('The refresh token is unknown, revoked or expired.');
      if ('reused' in out) {
        ctx.hub.dropSession(out.session.id);
        await ctx.audit('session.refresh-reused', { userId: out.session.userId, detail: { sessionId: out.session.id } });
        throw invalid('The refresh token was already used; the session is revoked.');
      }
      const user = await ctx.store.getUser(out.session.userId);
      if (!user) throw invalid('The user no longer exists.');
      return { body: { ...p, user: { id: user.id, login: user.login } } };
    }

    throw new HttpError(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token.');
  });

  router.add('POST', '/v1/auth/logout', async (req) => {
    const { session, user } = await authenticate(ctx, req.bearer());
    await ctx.store.revokeSession(session.id, ctx.clock.now());
    ctx.hub.dropSession(session.id);
    await ctx.audit('session.revoked', { userId: user.id, detail: { sessionId: session.id } });
    return { status: 204 };
  });

  router.add('GET', '/v1/me', async (req) => {
    const { user } = await sessionFor(ctx, req);
    return { body: { user: { id: user.id, login: user.login, githubId: user.githubId } } };
  });

  router.add('GET', '/v1/github/token', async (req) => {
    const { user } = await sessionFor(ctx, req);
    const { custody } = requireGitHub(ctx);
    try {
      const { token, expiresAt } = await custody.accessToken(user.id);
      return { body: { token, expiresAt } };
    } catch (err) {
      if (err instanceof GitHubAuthLostError) throw new HttpError(401, 'github-auth-lost', err.message);
      throw err;
    }
  });
}
