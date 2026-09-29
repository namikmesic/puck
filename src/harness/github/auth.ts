/**
 * GitHub App user tokens: the shared token shape (`tokensFrom`) and the
 * signed-out error. The Puck server runs the web flow, exchanges the code
 * and refreshes with the client secret (`src/server/github.ts`); the app
 * never holds a GitHub refresh token. Fetch only, so callers share this
 * module.
 *
 * Refresh rotates the pair: the old refresh token stops working the moment
 * a refresh succeeds, so callers must refresh single-flight and persist
 * the new pair before using it. `bad_refresh_token` means signed out.
 */

export interface UserTokens {
  accessToken: string;
  /** Epoch ms; null for a token that does not expire. */
  expiresAt: number | null;
  refreshToken: string | null;
  /** Epoch ms; null when there is no refresh token. */
  refreshExpiresAt: number | null;
}

/** The refresh token was rejected (rotated elsewhere, revoked, or expired): signed out. */
export class RefreshRejectedError extends Error {
  constructor(message = 'GitHub sign-in expired. Sign in again.') {
    super(message);
    this.name = 'RefreshRejectedError';
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The token pair from an access_token response (seconds → epoch ms). */
export function tokensFrom(data: Record<string, unknown>, now: number): UserTokens {
  const accessToken = str(data.access_token);
  if (!accessToken) throw new Error('GitHub returned no access token.');
  const expiresIn = num(data.expires_in);
  const refreshToken = str(data.refresh_token);
  const refreshIn = num(data.refresh_token_expires_in);
  return {
    accessToken,
    expiresAt: expiresIn !== null ? now + expiresIn * 1000 : null,
    refreshToken,
    refreshExpiresAt: refreshToken && refreshIn !== null ? now + refreshIn * 1000 : null,
  };
}
