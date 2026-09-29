/**
 * The instance index and repository grants, and GitHub installation tokens
 * for environments.
 *
 * Starting an environment records it here first (`POST /v1/instances`): the
 * server mints the `env_` id so the index and the container agree, checks
 * the owner's own access to every repository with the owner's GitHub user
 * token, finds the App installation covering each one, and stores the grant
 * with the permission set the environment's policies need.
 *
 * Access means push access. An installation token can write to every
 * repository the installation covers, so minting for a repository the user
 * can only read would let the App write where the user cannot.
 *
 * The runner hosting an environment asks for its tokens
 * (`POST /v1/runners/instances/:envId/github-token`). Before minting, every
 * repository verified more than ten minutes ago is checked again with the
 * owner's token; one the owner lost is dropped from the grant, so losing
 * access stops new tokens within one token lifetime. The server mints one
 * token per installation, scoped with `repository_ids` and the grant's
 * permissions, audits each mint without its value, and keeps no copy.
 * A definition update that changes those policies replaces the permission
 * set (`PUT /v1/instances/:envId/policies`) without re-checking
 * repositories; the next mint uses the new set.
 */

import { DEFAULT_TOKEN_POLICIES, permissionsFor, type GitHubTokenPolicies } from '../harness/github-permissions';
import { type ServerContext, requireGitHub, sessionFor } from './context';
import type { GitHubApp, RepoAccess } from './github';
import { HttpError, str, type Req, type Router } from './http';
import { newId } from './ids';
import { authenticateRunner } from './runners';
import { OFFLINE_AFTER_MS } from '../channel/wire';
import type { GrantRepo, Instance } from './store';
import { GitHubAuthLostError, type UserTokenCustody } from './user-tokens';

export const REVERIFY_AFTER_MS = 10 * 60_000;
export const MAX_REPOS = 20;
const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/** The `policies.github` fields that decide an environment's token permissions. */
export type GitHubPolicies = GitHubTokenPolicies;

export const DEFAULT_POLICIES: GitHubPolicies = DEFAULT_TOKEN_POLICIES;

export { permissionsFor };

export function parsePolicies(body: Record<string, unknown>): GitHubPolicies {
  const policies = body.policies as { github?: Record<string, unknown> } | undefined;
  const g = policies?.github ?? {};
  if (typeof g !== 'object' || g === null) throw new HttpError(400, 'invalid-body', 'policies.github must be an object.');
  const pick = <T>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = (g as Record<string, unknown>)[key];
    if (v === undefined) return fallback;
    if (!allowed.includes(v as T)) throw new HttpError(400, 'invalid-body', `policies.github.${key} has an unsupported value.`);
    return v as T;
  };
  return {
    intake: pick('intake', ['off', 'label'] as const, DEFAULT_POLICIES.intake),
    statusComment: pick('statusComment', [true, false] as const, DEFAULT_POLICIES.statusComment),
    ci: pick('ci', ['notify', 'fix'] as const, DEFAULT_POLICIES.ci),
    allowWorkflowEdits: pick('allowWorkflowEdits', [true, false] as const, DEFAULT_POLICIES.allowWorkflowEdits),
    allowCiRerun: pick('allowCiRerun', [true, false] as const, DEFAULT_POLICIES.allowCiRerun),
  };
}

function parseRepos(body: Record<string, unknown>): { owner: string; name: string }[] {
  const v = body.repos;
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_REPOS) {
    throw new HttpError(400, 'invalid-body', `repos must list 1 to ${MAX_REPOS} repositories as owner/name.`);
  }
  const seen = new Set<string>();
  const out: { owner: string; name: string }[] = [];
  for (const item of v) {
    const m = typeof item === 'string' ? REPO_RE.exec(item) : null;
    if (!m) throw new HttpError(400, 'invalid-body', 'Each repository is owner/name.');
    const key = item.toLowerCase();
    if (!seen.has(key)) out.push({ owner: m[1], name: m[2] });
    seen.add(key);
  }
  return out;
}

async function userRepoAccess(
  github: GitHubApp,
  custody: UserTokenCustody,
  userId: string,
  owner: string,
  name: string,
): Promise<RepoAccess | null> {
  try {
    return await custody.use(userId, (token) => github.repoAccess(token, owner, name));
  } catch (err) {
    if (err instanceof GitHubAuthLostError) throw new HttpError(403, 'owner-auth-lost', 'The owner must sign in to Puck again.');
    throw err;
  }
}

/** Checks each repository with the owner's token and finds its installation; throws on the first that fails. */
async function verifyRepos(
  github: GitHubApp,
  custody: UserTokenCustody,
  userId: string,
  envId: string,
  repos: { owner: string; name: string }[],
  now: number,
): Promise<GrantRepo[]> {
  const out: GrantRepo[] = [];
  for (const { owner, name } of repos) {
    const full = `${owner}/${name}`;
    const access = await userRepoAccess(github, custody, userId, owner, name);
    if (!access) {
      // A user token sees only repositories where the App is installed, so
      // "not found" is also what a missing installation looks like.
      throw new HttpError(403, 'repo-not-accessible', `${full} was not found, or the Puck GitHub App is not installed on ${owner}.`, {
        repo: full,
        installUrl: await github.installUrl(),
      });
    }
    if (!access.push) throw new HttpError(403, 'repo-not-writable', `You need push access to ${full}.`, { repo: full });
    const installationId = await github.repoInstallation(access.owner, access.name);
    if (installationId === null) {
      throw new HttpError(409, 'app-not-installed', `The Puck GitHub App is not installed on ${access.owner}.`, {
        repo: full,
        installUrl: await github.installUrl(),
      });
    }
    out.push({ envId, repoId: access.id, owner: access.owner, name: access.name, installationId, verifiedAt: now, revokedAt: null });
  }
  return out;
}

export interface InstanceView extends Instance {
  repos: { owner: string; name: string; revoked: boolean }[];
}

async function instanceView(ctx: ServerContext, i: Instance): Promise<InstanceView> {
  const repos = await ctx.store.grantRepos(i.id);
  return { ...i, repos: repos.map((r) => ({ owner: r.owner, name: r.name, revoked: r.revokedAt !== null })) };
}

export function registerInstanceRoutes(router: Router, ctx: ServerContext): void {
  const ownedInstance = async (req: Req) => {
    const { user } = await sessionFor(ctx, req);
    const instance = await ctx.store.getInstance(req.params.envId);
    if (!instance || instance.userId !== user.id) throw new HttpError(404, 'not-found', 'No such environment.');
    return { user, instance };
  };

  router.add('POST', '/v1/instances', async (req) => {
    const { user } = await sessionFor(ctx, req);
    const { github, custody } = requireGitHub(ctx);
    const body = await req.json();
    const runner = await ctx.store.getRunner(str(body, 'runnerId', { max: 64 }));
    if (!runner || runner.userId !== user.id || runner.removedAt !== null) throw new HttpError(404, 'not-found', 'No such runner.');
    const live = ctx.hub.live(runner.id);
    if (!live || ctx.clock.now() - live.lastFrameAt >= OFFLINE_AFTER_MS) {
      throw new HttpError(409, 'runner-offline', `${runner.name} is offline.`);
    }
    const hosted = (await ctx.store.instancesOnRunner(runner.id)).filter((i) => i.status === 'active');
    if (runner.maxEnvironments !== null && hosted.length >= runner.maxEnvironments) {
      throw new HttpError(409, 'runner-full', `${runner.name} already hosts its maximum of ${runner.maxEnvironments} environments.`);
    }
    const definition = str(body, 'definition', { max: 128 });
    const policies = parsePolicies(body);
    const repos = parseRepos(body);
    const now = ctx.clock.now();
    const envId = newId('env', now);
    const grant = await verifyRepos(github, custody, user.id, envId, repos, now);
    const instance: Instance = {
      id: envId,
      userId: user.id,
      runnerId: runner.id,
      definition,
      status: 'active',
      permissions: permissionsFor(policies),
      createdAt: now,
      updatedAt: now,
    };
    const placed = await ctx.store.createInstance(instance, grant);
    if (placed === 'gone') throw new HttpError(404, 'not-found', 'No such runner.');
    if (placed !== 'ok') {
      throw new HttpError(409, 'runner-full', `${runner.name} already hosts its maximum of ${placed.full} environments.`);
    }
    const view = await instanceView(ctx, instance);
    await ctx.audit('instance.created', {
      userId: user.id,
      runnerId: runner.id,
      envId,
      detail: { definition, repos: grant.map((r) => `${r.owner}/${r.name}`), permissions: instance.permissions },
    });
    ctx.hub.push(user.id, { type: 'instance.upsert', instance: view });
    return { status: 201, body: { envId, instance: view } };
  });

  router.add('GET', '/v1/instances', async (req) => {
    const { user } = await sessionFor(ctx, req);
    const list = await ctx.store.listInstances(user.id);
    return { body: { instances: await Promise.all(list.map((i) => instanceView(ctx, i))) } };
  });

  router.add('GET', '/v1/instances/:envId', async (req) => {
    const { instance } = await ownedInstance(req);
    return { body: { instance: await instanceView(ctx, instance) } };
  });

  router.add('PUT', '/v1/instances/:envId/grant', async (req) => {
    const { user, instance } = await ownedInstance(req);
    const { github, custody } = requireGitHub(ctx);
    if (instance.status !== 'active') throw new HttpError(409, 'instance-inactive', 'This environment is no longer on a runner.');
    const body = await req.json();
    const policies = parsePolicies(body);
    const now = ctx.clock.now();
    const grant = await verifyRepos(github, custody, user.id, instance.id, parseRepos(body), now);
    const permissions = permissionsFor(policies);
    await ctx.store.replaceGrant(instance.id, grant, permissions, now);
    const view = await instanceView(ctx, { ...instance, permissions, updatedAt: now });
    await ctx.audit('grant.updated', {
      userId: user.id,
      runnerId: instance.runnerId,
      envId: instance.id,
      detail: { repos: grant.map((r) => `${r.owner}/${r.name}`), permissions },
    });
    ctx.hub.push(user.id, { type: 'instance.upsert', instance: view });
    return { body: { instance: view } };
  });

  router.add('PUT', '/v1/instances/:envId/policies', async (req) => {
    const { user, instance } = await ownedInstance(req);
    if (instance.status !== 'active') throw new HttpError(409, 'instance-inactive', 'This environment is no longer on a runner.');
    const policies = parsePolicies(await req.json());
    const permissions = permissionsFor(policies);
    const now = ctx.clock.now();
    await ctx.store.setPermissions(instance.id, permissions, now);
    // Committed: the reply is a success and the app hears of it, whatever
    // fails after this point.
    const failed = (err: unknown) =>
      ctx.log.error('grant.permissions', { envId: instance.id, error: err instanceof Error ? err.name : 'unknown' });
    const recorded = { ...instance, permissions, updatedAt: now };
    let view: InstanceView | null = null;
    try {
      view = await instanceView(ctx, recorded);
    } catch {
      try {
        view = await instanceView(ctx, recorded);
      } catch (err) {
        failed(err);
      }
    }
    try {
      ctx.hub.push(user.id, {
        type: 'instance.upsert',
        instance: view ?? { ...recorded, partial: true },
      });
    } catch (err) {
      failed(err);
    }
    try {
      await ctx.audit('grant.permissions', {
        userId: user.id,
        runnerId: instance.runnerId,
        envId: instance.id,
        detail: { permissions },
      });
    } catch (err) {
      failed(err);
    }
    return { body: view ? { instance: view } : {} };
  });

  router.add('DELETE', '/v1/instances/:envId', async (req) => {
    const { user, instance } = await ownedInstance(req);
    await ctx.store.deleteInstance(instance.id);
    await ctx.audit('instance.forgotten', { userId: user.id, runnerId: instance.runnerId, envId: instance.id });
    ctx.hub.push(user.id, { type: 'instance.removed', envId: instance.id });
    return { status: 204 };
  });

  router.add('POST', '/v1/runners/instances/:envId/github-token', async (req) => {
    const runner = await authenticateRunner(ctx, req.bearer());
    const { github, custody } = requireGitHub(ctx);
    const instance = await ctx.store.getInstance(req.params.envId);
    if (!instance || instance.runnerId !== runner.id) throw new HttpError(404, 'not-found', 'No such environment on this runner.');
    if (instance.status !== 'active') throw new HttpError(409, 'instance-inactive', 'This environment is no longer on a runner.');
    const now = ctx.clock.now();
    let repos = (await ctx.store.grantRepos(instance.id)).filter((r) => r.revokedAt === null);
    if (repos.some((r) => now - r.verifiedAt >= REVERIFY_AFTER_MS)) {
      const kept: GrantRepo[] = [];
      for (const r of repos) {
        if (now - r.verifiedAt < REVERIFY_AFTER_MS) {
          kept.push(r);
          continue;
        }
        const access = await userRepoAccess(github, custody, instance.userId, r.owner, r.name);
        if (access && access.push && access.id === r.repoId) {
          await ctx.store.markRepoVerified(instance.id, r.repoId, now);
          kept.push({ ...r, verifiedAt: now });
        } else {
          await ctx.store.revokeRepo(instance.id, r.repoId, now);
          await ctx.audit('grant.repo-revoked', {
            userId: instance.userId,
            runnerId: runner.id,
            envId: instance.id,
            detail: { repo: `${r.owner}/${r.name}` },
          });
        }
      }
      repos = kept;
    }
    if (!repos.length) throw new HttpError(403, 'no-repositories', 'The owner no longer has push access to any of this environment’s repositories.');

    const byInstallation = new Map<number, GrantRepo[]>();
    for (const r of repos) byInstallation.set(r.installationId, [...(byInstallation.get(r.installationId) ?? []), r]);
    const grants = [];
    for (const [installationId, group] of byInstallation) {
      const minted = await github.mintInstallationToken(
        installationId,
        group.map((r) => r.repoId),
        instance.permissions,
      );
      const names = group.map((r) => `${r.owner}/${r.name}`);
      await ctx.audit('github.token-minted', {
        userId: instance.userId,
        runnerId: runner.id,
        envId: instance.id,
        detail: { installationId, repos: names, permissions: instance.permissions, expiresAt: minted.expiresAt },
      });
      grants.push({ owner: group[0].owner, installationId, repos: names, token: minted.token, expiresAt: minted.expiresAt });
    }
    return { body: { grants } };
  });
}
