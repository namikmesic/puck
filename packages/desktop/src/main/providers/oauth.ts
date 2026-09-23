/**
 * Shared OAuth plumbing for provider auth modules.
 *
 * `createOAuthAccount` owns everything that is identical across providers:
 * the encrypted token store, login-callback fan-in, refresh-before-use,
 * adopting fresher container-side credentials, and the freshness comparison
 * used when mirroring credential files into containers. The per-provider
 * modules keep only what genuinely differs: the authorize URL, the callback
 * transport (window-redirect intercept vs loopback server), the token
 * exchange, and the credential-file serialization.
 */

import * as crypto from 'node:crypto';
import { clearAuthSession } from '../authwindow';
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
  save(tokens: T): void;
  setOnLogin(cb: () => void): void;
  /** Called by the transport once an exchange lands; fans out to the app. */
  notifyLogin(): void;
  logout(): void;
  /** Valid tokens, refreshed when stale. A failed refresh keeps the old
   *  tokens (offline starts must not break) and records the error. */
  getFreshTokens(): Promise<T | null>;
  /** Adopt container-side credentials when fresher (CLIs rotate tokens). */
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
  let lastError: string | null = null;

  return {
    load: store.load,
    save(tokens: T): void {
      lastError = null;
      store.save(tokens);
    },
    setOnLogin(cb) {
      onLoginCb = cb;
    },
    notifyLogin() {
      onLoginCb?.();
    },
    logout() {
      lastError = null;
      store.clear();
    },
    async getFreshTokens(): Promise<T | null> {
      const tokens = store.load();
      if (!tokens) return null;
      if (!cfg.needsRefresh(tokens)) return tokens;
      try {
        const refreshed = await cfg.refresh(tokens);
        if (refreshed) {
          store.save(refreshed);
          return refreshed;
        }
      } catch (err) {
        this.recordError(err);
      }
      return tokens;
    },
    adoptIfNewer(containerJson: string): void {
      const candidate = cfg.parseContainerFile(parseJson(containerJson));
      if (!candidate) return;
      const current = store.load();
      if (current && cfg.freshnessOf(current) >= cfg.freshnessOf(candidate)) return;
      store.save(candidate);
    },
    supersedes(containerJson: string): boolean {
      const ours = store.load();
      if (!ours) return false;
      const theirs = cfg.parseContainerFile(parseJson(containerJson));
      if (!theirs) return true; // unparseable container copy — overwrite
      return cfg.freshnessOf(ours) > cfg.freshnessOf(theirs);
    },
    lastError: () => lastError,
    recordError(err: unknown): void {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`${cfg.storeName} auth error:`, err);
    },
  };
}

/**
 * The Provider `auth` surface over a shared account: status text, login
 * start, logout (which also drops the sign-in window's cookies so the next
 * login prompts again). Providers supply only what differs.
 */
export function providerAuth<T>(
  account: OAuthAccount<T>,
  cfg: {
    start(): Promise<string> | string;
    /** Status detail while logged out, e.g. which account to sign in with. */
    signInHint: string;
    connectedDetail(tokens: T): string;
    beforeLogout?(): void;
  },
): ProviderAuth {
  return {
    status: () => {
      const tokens = account.load();
      if (!tokens) {
        const err = account.lastError();
        return { connected: false, detail: err ? `Sign-in failed: ${err}` : cfg.signInHint };
      }
      return { connected: true, detail: cfg.connectedDetail(tokens) };
    },
    start: async () => cfg.start(),
    logout: () => {
      cfg.beforeLogout?.();
      account.logout();
      clearAuthSession();
    },
    setOnLogin: (cb) => account.setOnLogin(cb),
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
    fresh: async () => {
      const tokens = await account.getFreshTokens();
      if (!tokens) return null;
      return { content: cfg.serialize(tokens), supersedes: account.supersedes };
    },
    adoptIfNewer: account.adoptIfNewer,
  };
}
