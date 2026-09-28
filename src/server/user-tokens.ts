/**
 * Custody of each user's GitHub user-to-server token pair.
 *
 * The pair is sealed with AES-256-GCM under the server's token key (from
 * outside the image) before it reaches the store, with the user id as
 * associated data so a row copied onto another user does not open. The
 * refresh token never leaves this module: callers get the current access
 * token, refreshed single-flight when it is within five minutes of expiry.
 * GitHub rotates the refresh token on every refresh, so the new pair is
 * stored before the access token is handed out. A refresh GitHub rejects
 * deletes the pair; the user signs in again.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Clock } from './clock';
import { RefreshRejectedError, type GitHubApp, type UserTokens } from './github';
import type { Store } from './store';

export const REFRESH_MARGIN_MS = 5 * 60_000;

/** The user has no usable GitHub authorization; they must sign in again. */
export class GitHubAuthLostError extends Error {
  constructor() {
    super('GitHub authorization is missing or was revoked. Sign in again.');
    this.name = 'GitHubAuthLostError';
  }
}

export function seal(key: Buffer, userId: string, tokens: UserTokens): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(userId));
  const body = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

export function unseal(key: Buffer, userId: string, blob: Buffer): UserTokens | null {
  if (blob.length < 29 || blob[0] !== 1) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13));
    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(blob.subarray(13, 29));
    const text = Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString('utf8');
    return JSON.parse(text) as UserTokens;
  } catch {
    return null;
  }
}

export class UserTokenCustody {
  private inflight = new Map<string, Promise<UserTokens>>();

  constructor(
    private store: Store,
    private github: GitHubApp,
    private key: Buffer,
    private clock: Clock,
  ) {}

  async save(userId: string, tokens: UserTokens): Promise<void> {
    await this.store.putGitHubTokens(userId, seal(this.key, userId, tokens), this.clock.now());
  }

  async forget(userId: string): Promise<void> {
    await this.store.deleteGitHubTokens(userId);
  }

  /** The user's current GitHub access token and its expiry (epoch ms, or null when it does not expire). */
  async accessToken(userId: string): Promise<{ token: string; expiresAt: number | null }> {
    const pending = this.inflight.get(userId);
    const tokens = pending ? await pending : await this.load(userId);
    if (tokens.expiresAt === null || tokens.expiresAt - this.clock.now() > REFRESH_MARGIN_MS) {
      return { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    }
    const fresh = await this.refresh(userId, tokens);
    return { token: fresh.accessToken, expiresAt: fresh.expiresAt };
  }

  private async load(userId: string): Promise<UserTokens> {
    const blob = await this.store.getGitHubTokens(userId);
    const tokens = blob ? unseal(this.key, userId, blob) : null;
    if (!tokens) throw new GitHubAuthLostError();
    return tokens;
  }

  private refresh(userId: string, stale: UserTokens): Promise<UserTokens> {
    const running = this.inflight.get(userId);
    if (running) return running;
    const job = (async () => {
      const now = this.clock.now();
      if (!stale.refreshToken || (stale.refreshExpiresAt !== null && stale.refreshExpiresAt <= now)) {
        await this.forget(userId);
        throw new GitHubAuthLostError();
      }
      try {
        const fresh = await this.github.refresh(stale.refreshToken);
        await this.save(userId, fresh);
        return fresh;
      } catch (err) {
        if (err instanceof RefreshRejectedError) {
          await this.forget(userId);
          throw new GitHubAuthLostError();
        }
        throw err;
      }
    })();
    this.inflight.set(userId, job);
    const clear = (): void => {
      if (this.inflight.get(userId) === job) this.inflight.delete(userId);
    };
    job.then(clear, clear);
    return job;
  }
}
