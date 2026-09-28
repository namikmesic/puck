/**
 * What every route module shares: configuration, the store, the clock, the
 * log, the GitHub App (null until it is configured), the user-token
 * custody, the audit writer, and the hub (the relay's live view of who is
 * connected, and the push channel to the app sockets).
 */

import type { Clock } from './clock';
import type { ServerConfig } from './config';
import type { GitHubApp } from './github';
import { HttpError, type Req } from './http';
import { hashSecret, hasPrefix, newId } from './ids';
import type { ServerLog } from './log';
import type { Session, Store, User } from './store';
import type { UserTokenCustody } from './user-tokens';

/** A runner's live state, as its socket last reported it. */
export interface LiveRunner {
  connectedAt: number;
  lastFrameAt: number;
  /** Hosted instances and their container state (`running`, `exited`, ...). */
  instances: { envId: string; state: string }[];
}

/** Events pushed to a user's app sockets. */
export type PushEvent =
  | { type: 'runner.upsert'; runner: unknown }
  | { type: 'runner.removed'; runnerId: string }
  | { type: 'instance.upsert'; instance: unknown }
  | { type: 'instance.removed'; envId: string };

export interface Hub {
  live(runnerId: string): LiveRunner | null;
  push(userId: string, event: PushEvent): void;
  /** Closes the app sockets a session opened (sign-out). */
  dropSession(sessionId: string): void;
  /** Closes a runner's socket and every channel on it (removal). */
  dropRunner(runnerId: string, reason: string): void;
}

export interface AuditFields {
  userId?: string | null;
  runnerId?: string | null;
  envId?: string | null;
  detail?: Record<string, unknown>;
}

export interface ServerContext {
  config: ServerConfig;
  store: Store;
  clock: Clock;
  log: ServerLog;
  github: GitHubApp | null;
  custody: UserTokenCustody | null;
  hub: Hub;
  audit(kind: string, fields: AuditFields): Promise<void>;
}

export function auditWriter(store: Store, clock: Clock) {
  return async (kind: string, f: AuditFields): Promise<void> => {
    const at = clock.now();
    await store.audit({
      id: newId('aud', at),
      at,
      kind,
      userId: f.userId ?? null,
      runnerId: f.runnerId ?? null,
      envId: f.envId ?? null,
      detail: f.detail ?? {},
    });
  };
}

export function requireGitHub(ctx: ServerContext): { github: GitHubApp; custody: UserTokenCustody } {
  if (!ctx.github || !ctx.custody) {
    throw new HttpError(503, 'github-not-configured', 'This Puck server has no GitHub App configured.');
  }
  return { github: ctx.github, custody: ctx.custody };
}

/** The signed-in user behind a session access token, or 401. */
export async function authenticate(ctx: ServerContext, token: string | null): Promise<{ session: Session; user: User }> {
  const unauthorized = new HttpError(401, 'unauthorized', 'Sign in to Puck again.');
  if (!token || !hasPrefix(token, 'PSA')) throw unauthorized;
  const session = await ctx.store.sessionByAccess(hashSecret(token));
  if (!session || session.revokedAt !== null || session.accessExpiresAt <= ctx.clock.now()) throw unauthorized;
  const user = await ctx.store.getUser(session.userId);
  if (!user) throw unauthorized;
  return { session, user };
}

export async function sessionFor(ctx: ServerContext, req: Req): Promise<{ session: Session; user: User }> {
  return authenticate(ctx, req.bearer());
}
