/**
 * Claude account OAuth — the provider-specific half.
 *
 * Drives the same Authorization Code + PKCE flow `claude /login` performs,
 * from inside Puck: open the authorize page in the app's sign-in window,
 * intercept the callback redirect, exchange the code for tokens. Everything
 * generic (storage, refresh-before-use, container-credential adoption and
 * freshness) lives in the shared account (oauth.ts).
 */

import { closeAuthWindow, openAuthWindow } from '../authwindow';
import { createOAuthAccount, pkce, randomState } from './oauth';

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'; // Claude Code's public OAuth client
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
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

let pending: { verifier: string; state: string } | null = null;

/**
 * Opens the authorize page in a dedicated sign-in window and intercepts the
 * OAuth callback URL, so the login completes with no code pasting. Returns
 * the authorize URL.
 */
export function startLogin(): string {
  const { verifier, challenge } = pkce(32);
  const state = randomState();
  pending = { verifier, state };
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  const url = `${AUTHORIZE_URL}?${params.toString()}`;

  const win = openAuthWindow(url, 'Sign in to Claude');
  let consumed = false; // three navigation hooks can see one callback
  const intercept = (target: string): void => {
    if (consumed || !target.startsWith(REDIRECT_URI)) return;
    try {
      const cb = new URL(target);
      const code = cb.searchParams.get('code');
      const cbState = cb.searchParams.get('state');
      if (code) {
        if (cbState !== null && cbState !== state) return; // CSRF check
        consumed = true;
        closeAuthWindow();
        void exchange(code, cbState ?? undefined)
          .then(() => account.notifyLogin())
          .catch((err) => account.recordError(err));
      }
    } catch {
      // not a parseable URL — ignore
    }
  };
  win.webContents.on('will-redirect', (_event, target) => intercept(target));
  win.webContents.on('will-navigate', (_event, target) => intercept(target));
  win.webContents.on('did-navigate', (_event, target) => intercept(target));
  return url;
}

async function exchange(code: string, state?: string): Promise<void> {
  if (!pending) throw new Error('No login in progress.');
  const attempt = pending;
  pending = null; // a code is single-use — never leave a half-open login
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: attempt.verifier,
      state: state ?? attempt.state,
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
  account.save({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scopes: data.scope ? data.scope.split(' ') : ['user:inference', 'user:profile'],
  });
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
