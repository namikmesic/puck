/**
 * Signing in to the Puck server, and the Puck session.
 *
 * Sign-in is GitHub's web flow run by the server, in the system browser
 * (RFC 8252): the app opens its loopback listener on 127.0.0.1, asks the
 * server for GitHub's authorize URL with that redirect, a PKCE S256
 * challenge and its own state, and opens the URL. GitHub returns the browser
 * to the server, which exchanges the code with the App's client secret and
 * redirects to the loopback with a one-time Puck code. The app redeems it
 * with its PKCE verifier for a 15-minute access token and a rotating
 * refresh token. The app never sees GitHub's refresh token or the client
 * secret.
 *
 * The session lives in `puck-session.bin` through createOAuthAccount:
 * refresh is single-flight (a refresh token presented twice revokes the
 * whole session on the server) and sign-out is a fence, so a sign-in or
 * refresh already in flight cannot sign the user back in. A session for
 * another server URL reads as signed out.
 */

import { log } from '../log';
import { LoginCancelledError, startLoopback, type LoopbackListener } from '../providers/loopback';
import { createOAuthAccount, pkce, randomState } from '../providers/oauth';
import { serverDeps, serverRequest, serverUrl, ServerApiError } from './http';

export interface PuckSession {
  server: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
  refreshExpiresAt: number;
  user: { id: string; login: string };
}

const CALLBACK_PATH = '/callback';
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

let forceRefresh = false;

class RefreshRejected extends Error {}

function sessionFrom(body: Record<string, unknown>, server: string): PuckSession {
  const user = (body.user ?? {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const n = (k: string): number => (typeof body[k] === 'number' ? (body[k] as number) : 0);
  if (!s('accessToken') || !s('refreshToken') || typeof user.id !== 'string' || typeof user.login !== 'string') {
    throw new Error('The Puck server answered sign-in without a session.');
  }
  return {
    server,
    accessToken: s('accessToken'),
    accessExpiresAt: n('accessExpiresAt'),
    refreshToken: s('refreshToken'),
    refreshExpiresAt: n('refreshExpiresAt'),
    user: { id: user.id, login: user.login },
  };
}

export const account = createOAuthAccount<PuckSession>({
  storeName: 'puck-session.bin',
  freshnessOf: (t) => t.accessExpiresAt,
  needsRefresh: (t) => forceRefresh || t.accessExpiresAt - REFRESH_MARGIN_MS <= serverDeps().now(),
  refresh: async (t) => {
    forceRefresh = false;
    if (t.server !== serverUrl() || t.refreshExpiresAt <= serverDeps().now()) throw new RefreshRejected();
    try {
      const body = await serverRequest('POST', '/v1/auth/token', { body: { grant_type: 'refresh_token', refresh_token: t.refreshToken } });
      return sessionFrom(body, t.server);
    } catch (err) {
      if (err instanceof ServerApiError && err.status === 400 && err.code === 'invalid_grant') throw new RefreshRejected();
      throw err;
    }
  },
  // Nothing mirrors the session into containers.
  parseContainerFile: () => null,
  refreshRejected: (err) => err instanceof RefreshRejected,
});

type SessionListener = (signedIn: boolean) => void;
const listeners: SessionListener[] = [];

/** Sign-in and sign-out, for the modules that follow the session (the server socket, runners, GitHub). */
export function onSessionChange(cb: SessionListener): void {
  listeners.push(cb);
}

function announce(signedIn: boolean): void {
  for (const cb of listeners) {
    try {
      cb(signedIn);
    } catch (err) {
      log.error('session listener failed', err);
    }
  }
}

account.setOnLogin(() => announce(true));
account.setOnLogout(() => announce(false));

export class NotSignedInError extends Error {
  constructor() {
    super('Sign in to Puck first (Settings → Providers → GitHub).');
    this.name = 'NotSignedInError';
  }
}

let announcedOut = false;

/** The stored session when it belongs to this server. */
export function current(): PuckSession | null {
  const s = account.load();
  if (s && s.server === serverUrl()) {
    announcedOut = false;
    return s;
  }
  // A refresh the server rejected signs out without the logout hook; say so once.
  if (!s && !announcedOut && listeners.length) {
    announcedOut = true;
    queueMicrotask(() => announce(false));
  }
  return null;
}

/** A valid access token, refreshed when stale; throws NotSignedInError when signed out. */
export async function accessToken(): Promise<string> {
  if (!current()) throw new NotSignedInError();
  const s = await account.getFreshTokens();
  if (!s || s.server !== serverUrl()) throw new NotSignedInError();
  return s.accessToken;
}

/** The session with an access token valid for at least a minute (the app socket's auth). */
export async function freshSession(): Promise<PuckSession> {
  await accessToken();
  const s = current();
  if (!s) throw new NotSignedInError();
  return s;
}

/**
 * An authenticated request. A 401 refreshes once and retries; a second 401
 * means the session is gone (revoked on the server or signed out
 * elsewhere), which signs out here too.
 */
export async function authed<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  try {
    return await serverRequest<T>(method, path, { body, token });
  } catch (err) {
    if (!(err instanceof ServerApiError) || err.status !== 401 || err.code !== 'unauthorized') throw err;
  }
  forceRefresh = true;
  const again = await accessToken();
  try {
    return await serverRequest<T>(method, path, { body, token: again });
  } catch (err) {
    if (err instanceof ServerApiError && err.status === 401 && err.code === 'unauthorized') {
      log.warn('server.session-lost');
      await account.logout();
      throw new NotSignedInError();
    }
    throw err;
  }
}

let pending: LoopbackListener | null = null;

export function signInPending(): boolean {
  return pending !== null;
}

export function cancelSignIn(): void {
  pending?.cancel();
  pending = null;
}

/**
 * Starts signing in: opens the loopback listener, asks the server for the
 * authorize URL, opens it in the browser and resolves with it. The sign-in
 * completes when the browser lands on the listener.
 */
export async function startSignIn(): Promise<string> {
  cancelSignIn();
  const fence = account.fence();
  const server = serverUrl();
  const { verifier, challenge } = pkce(32);
  const state = randomState();
  const listener = await startLoopback({ path: CALLBACK_PATH, state });
  pending = listener;
  let authorizeUrl: string;
  try {
    // The server accepts only 127.0.0.1 loopback redirects, never localhost.
    const redirectUri = `http://127.0.0.1:${listener.port}${CALLBACK_PATH}`;
    const res = await serverRequest('POST', '/v1/auth/github/start', {
      body: { redirectUri, codeChallenge: challenge, codeChallengeMethod: 'S256', state },
    });
    authorizeUrl = typeof res.authorizeUrl === 'string' ? res.authorizeUrl : '';
    if (!/^https?:\/\//.test(authorizeUrl)) throw new Error('The Puck server did not return a sign-in page.');
  } catch (err) {
    listener.cancel();
    if (pending === listener) pending = null;
    if (err instanceof ServerApiError && err.code === 'github-not-configured') {
      throw new Error('This Puck server has no GitHub App configured, so it cannot sign anyone in yet.');
    }
    throw err;
  }

  listener.code
    .then(async (code) => {
      const body = await serverRequest('POST', '/v1/auth/token', {
        body: { grant_type: 'authorization_code', code, code_verifier: verifier },
      });
      const session = sessionFrom(body, server);
      if (account.save(session, fence)) {
        log.info('server.signin', { login: session.user.login });
        account.notifyLogin();
      }
    })
    .catch((err: unknown) => {
      if (!(err instanceof LoginCancelledError)) account.recordError(err);
    })
    .finally(() => {
      if (pending === listener) pending = null;
    });

  await serverDeps().openExternal(authorizeUrl);
  return authorizeUrl;
}

/**
 * Signs out: the local fence first (nothing in flight can sign back in),
 * then the server revokes the session, best effort: a server that is down
 * cannot keep the user signed in here.
 */
export async function signOut(): Promise<void> {
  cancelSignIn();
  const s = current();
  await account.logout();
  if (s && s.refreshExpiresAt > serverDeps().now()) {
    await revoke(s).catch((err: unknown) => {
      log.warn('server.logout-failed', { error: err instanceof Error ? err.message : String(err) });
    });
  }
}

/** Revokes a session that was already dropped locally; an expired access token is renewed once for it. */
async function revoke(s: PuckSession): Promise<void> {
  let token = s.accessToken;
  if (s.accessExpiresAt - REFRESH_MARGIN_MS <= serverDeps().now()) {
    const body = await serverRequest('POST', '/v1/auth/token', {
      body: { grant_type: 'refresh_token', refresh_token: s.refreshToken },
      timeoutMs: 5_000,
    });
    token = sessionFrom(body, s.server).accessToken;
  }
  await serverRequest('POST', '/v1/auth/logout', { token, timeoutMs: 5_000 });
}
