/**
 * Claude account OAuth — the provider-specific half.
 *
 * Drives the same Authorization Code + PKCE flow `claude /login` performs:
 * open the authorize page in the system browser, receive the redirect on a
 * loopback listener (http://localhost:<port>/callback - the callback shape
 * Claude Code registers for its public client, port chosen at bind time),
 * exchange the code for tokens. Everything generic (storage,
 * refresh-before-use, container-credential adoption and freshness) lives in
 * the shared account (oauth.ts); the listener lives in loopback.ts.
 */

import { shell } from 'electron';
import { LoginCancelledError, startLoopback, type LoopbackListener } from './loopback';
import { createOAuthAccount, pkce, randomState, type LogoutFence } from './oauth';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code's public OAuth client
const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CALLBACK_PATH = '/callback';
const SCOPE = 'org:create_api_key user:profile user:inference';

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  scopes: string[];
}

export const account = createOAuthAccount<StoredTokens>({
  storeName: 'claude-oauth.bin',
  freshnessOf: (t) => t.expiresAt,
  needsRefresh: (t) => Date.now() > t.expiresAt - 5 * 60_000 && !!t.refreshToken,
  async refresh(tokens) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      scopes: tokens.scopes,
    };
  },
  parseContainerFile(parsed) {
    const oauth = (parsed as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        scopes?: string[];
      };
    } | null)?.claudeAiOauth;
    if (!oauth?.accessToken || !oauth.refreshToken || !oauth.expiresAt) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes ?? ['user:inference', 'user:profile'],
    };
  },
});

let pending: LoopbackListener | null = null;

/** True while a login waits for the browser to hit the loopback callback. */
export function loginPending(): boolean {
  return pending !== null;
}

/** Abort a login in progress (Cancel button, logout, quit). No-op otherwise. */
export function cancelLogin(): void {
  pending?.cancel();
  pending = null;
}

/**
 * Starts the loopback listener, opens the authorize page in the system
 * browser and resolves with the authorize URL. The login itself completes
 * asynchronously when the browser is redirected to the listener.
 */
export async function startLogin(): Promise<string> {
  cancelLogin(); // a new attempt supersedes any pending one
  const fence = account.fence(); // a logout during the exchange discards its result
  const { verifier, challenge } = pkce(32);
  const state = randomState();
  const listener = await startLoopback({ path: CALLBACK_PATH, state });
  pending = listener;
  const redirectUri = `http://localhost:${listener.port}${CALLBACK_PATH}`;
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  const url = `${AUTHORIZE_URL}?${params.toString()}`;

  listener.code
    .then((code) => exchange(code, { redirectUri, verifier, state }, fence))
    .then((saved) => {
      if (saved) account.notifyLogin();
    })
    .catch((err) => {
      if (!(err instanceof LoginCancelledError)) account.recordError(err);
    })
    .finally(() => {
      if (pending === listener) pending = null;
    });

  await shell.openExternal(url);
  return url;
}

/** Exchange the code for tokens; false when a logout tripped `fence` meanwhile. */
async function exchange(
  code: string,
  attempt: { redirectUri: string; verifier: string; state: string },
  fence: LogoutFence,
): Promise<boolean> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: attempt.redirectUri,
      code_verifier: attempt.verifier,
      state: attempt.state,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    scope?: string;
  };
  return account.save(
    {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      scopes: data.scope ? data.scope.split(' ') : ['user:inference', 'user:profile'],
    },
    fence,
  );
}

/** The ~/.claude/.credentials.json body Claude Code reads on Linux. */
export function credentialsFileContent(tokens: StoredTokens): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      subscriptionType: 'max',
    },
  });
}
