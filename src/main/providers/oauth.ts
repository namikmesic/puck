/**
 * Shared OAuth plumbing for provider auth modules.
 *
 * `createOAuthAccount` owns everything that is identical across providers:
 * the encrypted token store, login-callback fan-in, refresh-before-use,
 * adopting fresher container-side credentials, the freshness comparison
 * used when mirroring credential files into containers - and the logout
 * fence that makes a sign-out final. The per-provider modules keep only what
 * genuinely differs: the authorize URL, the loopback callback shape (port and
 * path), the token exchange, and the credential-file serialization.
 */

import * as crypto from 'node:crypto';
import { log } from '../log';
import { deleteSecret, loadSecret, saveSecret } from '../secrets';
import type { ProviderAuth, ProviderCredential } from './types';

/** PKCE verifier + S256 challenge. Verifier size differs per provider. */
export function pkce(verifierBytes: number): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(verifierBytes).toString('base64url');
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
  };
}

export function randomState(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** JSON.parse that reports garbage as null instead of throwing. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** JSON tokens on the encrypted secret store (safeStorage / OS keychain). */
function tokenStore<T>(storeName: string): {
  load(): T | null;
  save(tokens: T): void;
  clear(): void;
} {
  return {
    load(): T | null {
      const json = loadSecret(storeName);
      return json ? (parseJson(json) as T | null) : null;
    },
    save(tokens: T): void {
      saveSecret(storeName, JSON.stringify(tokens));
    },
    clear(): void {
      deleteSecret(storeName);
    },
  };
}

/**
 * A point in an account's logout history. Async work that ends in a token
 * write - a login exchange, a refresh, a credential copy into a container -
 * takes a fence when it starts and checks it before writing: `current()` is
 * false once a logout happened after the fence was taken, and the write is
 * dropped. This is what makes logout final: nothing already in flight can
 * sign the account back in.
 */
export interface LogoutFence {
  current(): boolean;
}

export interface OAuthAccountConfig<T> {
  /** Encrypted store file name, e.g. 'claude-oauth.bin'. */
  storeName: string;
  /** Monotonic freshness of a token set (ms epoch); newer wins everywhere. */
  freshnessOf(tokens: T): number;
  /** True when the tokens should be refreshed before use. */
  needsRefresh(tokens: T): boolean;
  /** Perform the provider's refresh call; null keeps the current tokens. */
  refresh(tokens: T): Promise<T | null>;
  /** Tokens from a container-side credential file's parsed JSON (null = invalid). */
  parseContainerFile(parsed: unknown): T | null;
}

export interface OAuthAccount<T> {
  load(): T | null;
  /**
   * Persist tokens. With a fence, the write is refused (returns false) when a
   * logout happened after the fence was taken - every async path that ends
   * in a save passes the fence it took at its start.
   */
  save(tokens: T, fence?: LogoutFence): boolean;
  fence(): LogoutFence;
  setOnLogin(cb: () => void): void;
  /** Called by the transport once an exchange lands; fans out to the app. */
  notifyLogin(): void;
  /**
   * Runs after the local fence on logout (tokens cleared, fences tripped);
   * the app removes the credentials it mirrored into containers here. A
   * failure propagates out of logout() - the local sign-out has already held.
   */
  setOnLogout(cb: () => Promise<void> | void): void;
  /** Sign out: trip every fence, clear the stored tokens, run the logout hook. */
  logout(): Promise<void>;
  /**
   * Valid tokens, refreshed when stale. A failed refresh keeps the old
   * tokens (offline starts must not break) and records the error. A logout
   * during the refresh wins: the result is dropped and null is returned.
   */
  getFreshTokens(): Promise<T | null>;
  /**
   * Adopt container-side credentials when strictly fresher than the ones we
   * hold (CLIs rotate tokens). A signed-out account adopts nothing - a
   * container copy must never undo a logout.
   */
  adoptIfNewer(containerJson: string): void;
  /** True when our tokens should overwrite the container's copy. */
  supersedes(containerJson: string): boolean;
  /** Last login/refresh failure, for surfacing in auth status. */
  lastError(): string | null;
  recordError(err: unknown): void;
}

export function createOAuthAccount<T>(cfg: OAuthAccountConfig<T>): OAuthAccount<T> {
  const store = tokenStore<T>(cfg.storeName);
  let onLoginCb: (() => void) | null = null;
  let onLogoutCb: (() => Promise<void> | void) | null = null;
  let lastError: string | null = null;
  /** Advances on every logout; a fence remembers the value it was taken at. */
  let epoch = 0;

  const account: OAuthAccount<T> = {
    load: store.load,
    fence(): LogoutFence {
      const at = epoch;
      return { current: () => at === epoch };
    },
    save(tokens: T, fence?: LogoutFence): boolean {
      if (fence && !fence.current()) return false;
      lastError = null;
      store.save(tokens);
      return true;
    },
    setOnLogin(cb) {
      onLoginCb = cb;
    },
    notifyLogin() {
      log.info('auth.login', { store: cfg.storeName });
      onLoginCb?.();
    },
    setOnLogout(cb) {
      onLogoutCb = cb;
    },
    async logout(): Promise<void> {
      // The local fence first, synchronously: from here on no exchange,
      // refresh or adoption can write, and nothing can re-inject into a
      // container while the hook below cleans up.
      epoch += 1;
      lastError = null;
      store.clear();
      log.info('auth.logout', { store: cfg.storeName });
      await onLogoutCb?.();
    },
    async getFreshTokens(): Promise<T | null> {
      const tokens = store.load();
      if (!tokens) return null;
      if (!cfg.needsRefresh(tokens)) return tokens;
      const fence = account.fence();
      try {
        const refreshed = await cfg.refresh(tokens);
        if (refreshed && account.save(refreshed, fence)) return refreshed;
      } catch (err) {
        if (fence.current()) account.recordError(err);
      }
      return fence.current() ? tokens : null;
    },
    adoptIfNewer(containerJson: string): void {
      const candidate = cfg.parseContainerFile(parseJson(containerJson));
      if (!candidate) return;
      const current = store.load();
      if (!current) return; // signed out (or never signed in): not ours to adopt
      if (cfg.freshnessOf(current) >= cfg.freshnessOf(candidate)) return;
      store.save(candidate);
    },
    supersedes(containerJson: string): boolean {
      const ours = store.load();
      if (!ours) return false;
      const theirs = cfg.parseContainerFile(parseJson(containerJson));
      if (!theirs) return true; // unparseable container copy - overwrite
      return cfg.freshnessOf(ours) > cfg.freshnessOf(theirs);
    },
    lastError: () => lastError,
    recordError(err: unknown): void {
      lastError = err instanceof Error ? err.message : String(err);
      log.error(`${cfg.storeName} auth error`, err);
    },
  };
  return account;
}

/**
 * The Provider `auth` surface over a shared account: status text, login
 * start/cancel, logout (aborts a pending login, then runs the account's
 * fence and logout hook; only Puck's own stored tokens are cleared - the
 * browser session is the user's). Providers supply only what differs.
 */
export function providerAuth<T>(
  account: OAuthAccount<T>,
  cfg: {
    start(): Promise<string> | string;
    /** Abort a login in progress; must be a no-op when none is pending. */
    cancel(): void;
    /** True while a login waits for its browser callback. */
    pending(): boolean;
    /** Status detail while logged out, e.g. which account to sign in with. */
    signInHint: string;
    connectedDetail(tokens: T): string;
  },
): ProviderAuth {
  return {
    status: () => {
      const tokens = account.load();
      const pending = cfg.pending();
      if (!tokens) {
        const err = account.lastError();
        return {
          connected: false,
          pending,
          detail: err ? `Sign-in failed: ${err}` : cfg.signInHint,
        };
      }
      return { connected: true, pending, detail: cfg.connectedDetail(tokens) };
    },
    start: async () => cfg.start(),
    cancel: () => cfg.cancel(),
    logout: async () => {
      cfg.cancel(); // a callback that lands later finds no listener
      await account.logout();
    },
    setOnLogin: (cb) => account.setOnLogin(cb),
    setOnLogout: (cb) => account.setOnLogout(cb),
  };
}

/** The Provider `container.credential` surface: the CLI file mirrored from
 *  the shared account's (refreshed) tokens. */
export function providerCredential<T>(
  account: OAuthAccount<T>,
  cfg: { hostPath: string; containerPath: string; serialize(tokens: T): string },
): ProviderCredential {
  return {
    hostPath: cfg.hostPath,
    containerPath: cfg.containerPath,
    signedIn: () => account.load() !== null,
    fresh: async () => {
      // Taken before the refresh so a logout during it trips the snapshot too.
      const fence = account.fence();
      const tokens = await account.getFreshTokens();
      if (!tokens) return null;
      return {
        content: cfg.serialize(tokens),
        supersedes: account.supersedes,
        current: fence.current,
      };
    },
    adoptIfNewer: account.adoptIfNewer,
  };
}
