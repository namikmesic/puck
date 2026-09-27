/**
 * GitHub App user tokens through the OAuth device flow - the one GitHub
 * flow that needs only the client id, both to obtain and to refresh a
 * token (the web flow's code exchange requires the client secret, which a
 * desktop app cannot keep). Fetch only, so the app and the code running
 * inside environments share it.
 *
 * Refresh rotates the pair: the old refresh token stops working the moment
 * a refresh succeeds, so callers must refresh single-flight and persist
 * the new pair before using it. `bad_refresh_token` means signed out.
 */

import { defaultDeps, type GitHubDeps } from './http';

export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
/** The only verification page Puck ever shows (checked on every device code). */
export const DEVICE_VERIFICATION_URI = 'https://github.com/login/device';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** GitHub's floor for the polling interval, and the slow_down increment. */
export const MIN_INTERVAL_MS = 5_000;
export const SLOW_DOWN_MS = 5_000;

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Epoch ms after which polling stops (expired_token). */
  expiresAt: number;
  intervalMs: number;
}

export interface UserTokens {
  accessToken: string;
  /** Epoch ms; null for a token that does not expire. */
  expiresAt: number | null;
  refreshToken: string | null;
  /** Epoch ms; null when there is no refresh token. */
  refreshExpiresAt: number | null;
}

export type DeviceFlowFailure = 'expired_token' | 'access_denied' | 'unsupported' | 'error';

export class DeviceFlowError extends Error {
  constructor(
    readonly reason: DeviceFlowFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

/** The refresh token was rejected (rotated elsewhere, revoked, or expired): signed out. */
export class RefreshRejectedError extends Error {
  constructor(message = 'GitHub sign-in expired. Sign in again.') {
    super(message);
    this.name = 'RefreshRejectedError';
  }
}

async function postForm(
  url: string,
  form: Record<string, string>,
  deps: GitHubDeps,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await deps.fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Puck' },
    body: new URLSearchParams(form).toString(),
    signal,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* reported below */
  }
  if (typeof body !== 'object' || body === null) {
    throw new DeviceFlowError('error', `GitHub answered ${res.status} without JSON.`);
  }
  // The OAuth endpoints report flow errors as 200 + { error }; anything else
  // non-2xx without an error code is a transport failure.
  const data = body as Record<string, unknown>;
  if (!res.ok && typeof data.error !== 'string') {
    throw new DeviceFlowError('error', `GitHub answered ${res.status}.`);
  }
  return data;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The token pair from an access_token response (seconds → epoch ms). */
export function tokensFrom(data: Record<string, unknown>, now: number): UserTokens {
  const accessToken = str(data.access_token);
  if (!accessToken) throw new DeviceFlowError('error', 'GitHub returned no access token.');
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

function flowErrorText(data: Record<string, unknown>): string {
  return str(data.error_description) ?? str(data.error) ?? 'unknown error';
}

/** Step 1: ask GitHub for a device code the user enters on the verification page. */
export async function requestDeviceCode(
  clientId: string,
  deps: GitHubDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<DeviceCode> {
  const data = await postForm(DEVICE_CODE_URL, { client_id: clientId }, deps, signal);
  if (typeof data.error === 'string') {
    const reason: DeviceFlowFailure = data.error === 'device_flow_disabled' ? 'unsupported' : 'error';
    throw new DeviceFlowError(reason, `GitHub refused the sign-in: ${flowErrorText(data)}`);
  }
  const deviceCode = str(data.device_code);
  const userCode = str(data.user_code);
  if (!deviceCode || !userCode) throw new DeviceFlowError('error', 'GitHub returned an incomplete device code.');
  // Show only a code Puck requested, for the one page it belongs to.
  if (data.verification_uri !== DEVICE_VERIFICATION_URI) {
    throw new DeviceFlowError('error', 'GitHub returned an unexpected verification page; sign-in stopped.');
  }
  const expiresIn = num(data.expires_in) ?? 900;
  return {
    deviceCode,
    userCode,
    verificationUri: DEVICE_VERIFICATION_URI,
    expiresAt: deps.now() + expiresIn * 1000,
    intervalMs: Math.max(MIN_INTERVAL_MS, (num(data.interval) ?? 5) * 1000),
  };
}

/**
 * Step 2: poll until the user approves (tokens), denies, or the code
 * expires. Waits the interval before every poll, adds 5 s on slow_down, and
 * stops when `signal` aborts (rejecting with an AbortError).
 */
export async function pollDeviceToken(
  clientId: string,
  code: DeviceCode,
  deps: GitHubDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<UserTokens> {
  let interval = code.intervalMs;
  for (;;) {
    await deps.sleep(interval, signal);
    if (deps.now() >= code.expiresAt) {
      throw new DeviceFlowError('expired_token', 'The sign-in code expired. Start again.');
    }
    const data = await postForm(
      ACCESS_TOKEN_URL,
      { client_id: clientId, device_code: code.deviceCode, grant_type: DEVICE_GRANT },
      deps,
      signal,
    );
    switch (data.error) {
      case undefined:
        return tokensFrom(data, deps.now());
      case 'authorization_pending':
        continue;
      case 'slow_down': {
        const asked = num(data.interval);
        interval = Math.max(interval + SLOW_DOWN_MS, asked !== null ? asked * 1000 : 0);
        continue;
      }
      case 'expired_token':
        throw new DeviceFlowError('expired_token', 'The sign-in code expired. Start again.');
      case 'access_denied':
        throw new DeviceFlowError('access_denied', 'Sign-in was denied on GitHub.');
      default:
        throw new DeviceFlowError('error', `GitHub sign-in failed: ${flowErrorText(data)}`);
    }
  }
}

/**
 * Exchange a refresh token for a new pair. The old pair is invalid once
 * this resolves: persist the result before using it.
 */
export async function refreshUserToken(
  clientId: string,
  refreshToken: string,
  deps: GitHubDeps = defaultDeps,
): Promise<UserTokens> {
  const data = await postForm(
    ACCESS_TOKEN_URL,
    { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken },
    deps,
  );
  if (data.error === 'bad_refresh_token') throw new RefreshRejectedError();
  if (typeof data.error === 'string') {
    throw new DeviceFlowError('error', `GitHub token refresh failed: ${flowErrorText(data)}`);
  }
  return tokensFrom(data, deps.now());
}
