/**
 * Runners: machines a user registered to host their environments.
 *
 * Registration mirrors GitHub's self-hosted runners. The app asks for a
 * registration token (`PRT_`, one hour, reusable within the hour so one
 * token can set up a fleet, revocable). `config.sh` generates an Ed25519
 * key pair and calls `POST /v1/runners/register` with the token and the
 * public key. From then on the runner authenticates by signing a short JWT
 * assertion (EdDSA, `iss = sub = runnerId`, audience this endpoint, at most
 * five minutes, single-use `jti`) and exchanging it at `POST /v1/runners/token`
 * for a one-hour runner access token (`PRA_`), which opens its socket.
 *
 * Removal takes a removal token (`PRR_`, one hour) or the runner's own
 * signed assertion. It revokes the key and either keeps the runner's
 * environments in the index as `orphaned` or forgets them (the runner
 * deletes the containers). Force removal from the app (the machine is gone)
 * marks them `lost`. A removed runner's assertions are refused with
 * `runner-removed`, the runner's signal to stop for good. Nothing removes a
 * runner automatically, however long it stays offline.
 *
 * Status is computed, not stored: Offline when no frame arrived for 60 s,
 * Active when online and hosting at least one running environment, Idle
 * otherwise. The Docker health the runner last reported rides alongside.
 */

import { createPublicKey, verify } from 'node:crypto';
import { keyFingerprint, OFFLINE_AFTER_MS, rawKey } from '../channel/wire';
import { compareVersions } from './config';
import { sessionFor, type ServerContext } from './context';
import { HttpError, intOrNull, str, strList, type Req, type Router } from './http';
import { fromB64url, hashSecret, hasPrefix, newId, newSecret, type SecretPrefix } from './ids';
import type { DockerInfo, EnrollKind, Runner } from './store';

export const ENROLL_TTL_MS = 60 * 60_000;
export const RUNNER_TOKEN_TTL_MS = 60 * 60_000;
export const MAX_ASSERTION_LIFE_S = 300;
/** Tolerated clock skew for assertion `iat`. */
export const ASSERTION_SKEW_S = 60;
export const RUNNER_OS = ['linux', 'macos'] as const;
export const RUNNER_ARCH = ['x64', 'arm64'] as const;

export type RunnerStatusWord = 'idle' | 'active' | 'offline';

export interface RunnerView {
  id: string;
  name: string;
  labels: string[];
  os: string;
  arch: string;
  version: string;
  publicKey: string;
  fingerprint: string;
  maxEnvironments: number | null;
  docker: DockerInfo | null;
  status: RunnerStatusWord;
  /** Running environments, as the runner last reported. */
  running: number;
  createdAt: number;
  lastSeenAt: number | null;
}

export function runnerView(ctx: ServerContext, r: Runner): RunnerView {
  const live = ctx.hub.live(r.id);
  const now = ctx.clock.now();
  const online = !!live && now - live.lastFrameAt < OFFLINE_AFTER_MS;
  const running = online ? live.instances.filter((i) => i.state === 'running').length : 0;
  return {
    id: r.id,
    name: r.name,
    labels: r.labels,
    os: r.os,
    arch: r.arch,
    version: r.version,
    publicKey: r.publicKey,
    fingerprint: r.fingerprint,
    maxEnvironments: r.maxEnvironments,
    docker: r.docker,
    status: !online ? 'offline' : running > 0 ? 'active' : 'idle',
    running,
    createdAt: r.createdAt,
    lastSeenAt: live ? Math.max(live.lastFrameAt, r.lastSeenAt ?? 0) : r.lastSeenAt,
  };
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/;
const LABEL_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function runnerName(value: string): string {
  const name = value.trim();
  if (!NAME_RE.test(name)) throw new HttpError(400, 'invalid-name', 'A runner name is 1-64 letters, digits, spaces and ._()-.');
  return name;
}

/** The OS and architecture labels first, then the custom ones, without duplicates. */
function labelSet(os: string, arch: string, custom: string[]): string[] {
  for (const l of custom) {
    if (!LABEL_RE.test(l)) throw new HttpError(400, 'invalid-labels', `Label "${l.slice(0, 64)}" must be lowercase letters, digits and :._-.`);
  }
  return [...new Set([os, arch, ...custom])];
}

function dockerInfo(v: unknown): DockerInfo | null {
  if (typeof v !== 'object' || v === null) return null;
  const d = v as Record<string, unknown>;
  const numOrNull = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const strOrNull = (x: unknown) => (typeof x === 'string' && x.length <= 64 ? x : null);
  return {
    ok: d.ok !== false,
    version: strOrNull(d.version),
    problem: strOrNull(d.problem),
    ncpu: numOrNull(d.ncpu),
    memTotal: numOrNull(d.memTotal),
  };
}

function checkVersion(ctx: ServerContext, version: string): void {
  const min = ctx.config.minRunnerVersion;
  if (min && compareVersions(version, min) < 0) {
    throw new HttpError(426, 'runner-outdated', `This Puck server needs runner ${min} or newer.`, { minVersion: min });
  }
}

async function enrollToken(ctx: ServerContext, token: string, kind: EnrollKind) {
  const prefix: SecretPrefix = kind === 'registration' ? 'PRT' : 'PRR';
  const bad = new HttpError(401, 'invalid-token', `The ${kind} token is unknown, revoked or expired.`);
  if (!hasPrefix(token, prefix)) throw bad;
  const t = await ctx.store.enrollTokenByHash(hashSecret(token));
  if (!t || t.kind !== kind || t.revokedAt !== null || t.expiresAt <= ctx.clock.now()) throw bad;
  return t;
}

/**
 * The runner that signed `assertion` for `audPath`, after checking the
 * signature, audience, lifetime and single use. Removed runners are refused
 * with `runner-removed`.
 */
export async function verifyAssertion(ctx: ServerContext, assertion: string, audPath: string): Promise<Runner> {
  const invalid = (why: string) => new HttpError(401, 'invalid-assertion', `The runner assertion is invalid: ${why}.`);
  const parts = assertion.split('.');
  if (parts.length !== 3) throw invalid('not a JWT');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    claims = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch {
    throw invalid('unreadable');
  }
  if (header.alg !== 'EdDSA') throw invalid('alg must be EdDSA');
  const { iss, sub, aud, iat, exp, jti } = claims;
  if (typeof iss !== 'string' || iss !== sub) throw invalid('iss and sub must name the runner');
  const runner = await ctx.store.getRunner(iss);
  if (!runner) throw invalid('unknown runner');
  if (runner.removedAt !== null) {
    throw new HttpError(403, 'runner-removed', 'This runner was removed from Puck. Run ./config.sh remove to clean up.');
  }
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: runner.publicKey }, format: 'jwk' });
  if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, fromB64url(parts[2]))) throw invalid('bad signature');
  if (aud !== ctx.config.publicUrl + audPath) throw invalid('wrong audience');
  const now = Math.floor(ctx.clock.now() / 1000);
  if (typeof iat !== 'number' || typeof exp !== 'number') throw invalid('iat and exp are required');
  if (exp - iat > MAX_ASSERTION_LIFE_S || exp <= iat) throw invalid('lifetime over five minutes');
  if (iat > now + ASSERTION_SKEW_S || exp <= now) throw invalid('expired or not yet valid');
  if (typeof jti !== 'string' || !jti || jti.length > 128) throw invalid('jti is required');
  if (!(await ctx.store.useAssertionId(runner.id, jti, exp * 1000, ctx.clock.now()))) throw invalid('jti was already used');
  return runner;
}

export async function authenticateRunner(ctx: ServerContext, token: string | null): Promise<Runner> {
  const bad = new HttpError(401, 'unauthorized', 'The runner access token is unknown or expired.');
  if (!token || !hasPrefix(token, 'PRA')) throw bad;
  const runner = await ctx.store.runnerByToken(hashSecret(token), ctx.clock.now());
  if (!runner) throw bad;
  return runner;
}

/** Revokes the runner and settles its environments; shared by every removal path. */
async function removeRunner(ctx: ServerContext, runner: Runner, how: 'keep' | 'delete' | 'force', by: string): Promise<void> {
  const now = ctx.clock.now();
  await ctx.store.removeRunner(runner.id, now);
  let affected: string[];
  if (how === 'delete') {
    const instances = await ctx.store.instancesOnRunner(runner.id);
    for (const i of instances) await ctx.store.deleteInstance(i.id);
    affected = instances.map((i) => i.id);
    for (const envId of affected) ctx.hub.push(runner.userId, { type: 'instance.removed', envId });
  } else {
    affected = await ctx.store.setRunnerInstancesStatus(runner.id, how === 'keep' ? 'orphaned' : 'lost', now);
    for (const envId of affected) {
      const instance = await ctx.store.getInstance(envId);
      if (instance) ctx.hub.push(runner.userId, { type: 'instance.upsert', instance });
    }
  }
  ctx.hub.dropRunner(runner.id, 'runner-removed');
  ctx.hub.push(runner.userId, { type: 'runner.removed', runnerId: runner.id });
  await ctx.audit('runner.removed', {
    userId: runner.userId,
    runnerId: runner.id,
    detail: { how, by, environments: affected.length },
  });
}

export function registerRunnerRoutes(router: Router, ctx: ServerContext): void {
  const issue = (kind: EnrollKind) => async (req: Req) => {
    const { user } = await sessionFor(ctx, req);
    const now = ctx.clock.now();
    const token = newSecret(kind === 'registration' ? 'PRT' : 'PRR');
    const record = { id: newId('reg', now), kind, userId: user.id, expiresAt: now + ENROLL_TTL_MS, revokedAt: null };
    await ctx.store.createEnrollToken(record, hashSecret(token), now);
    await ctx.audit(`runner.${kind}-token`, { userId: user.id, detail: { tokenId: record.id } });
    return { status: 201, body: { id: record.id, token, expiresAt: record.expiresAt, serverUrl: ctx.config.publicUrl } };
  };
  router.add('POST', '/v1/runners/registration-token', issue('registration'));
  router.add('POST', '/v1/runners/removal-token', issue('removal'));

  const revoke = async (req: Req) => {
    const { user } = await sessionFor(ctx, req);
    if (!(await ctx.store.revokeEnrollToken(user.id, req.params.id, ctx.clock.now()))) {
      throw new HttpError(404, 'not-found', 'No such token.');
    }
    return { status: 204 };
  };
  router.add('DELETE', '/v1/runners/registration-token/:id', revoke);
  router.add('DELETE', '/v1/runners/removal-token/:id', revoke);

  router.add('POST', '/v1/runners/register', async (req) => {
    const body = await req.json();
    const token = await enrollToken(ctx, str(body, 'registrationToken', { max: 128 }), 'registration');
    const user = await ctx.store.getUser(token.userId);
    if (!user) throw new HttpError(401, 'invalid-token', 'The registration token has no owner.');
    const os = str(body, 'os', { max: 16 });
    const arch = str(body, 'arch', { max: 16 });
    if (!(RUNNER_OS as readonly string[]).includes(os) || !(RUNNER_ARCH as readonly string[]).includes(arch)) {
      throw new HttpError(400, 'unsupported-platform', 'Runners run on linux or macos, x64 or arm64.');
    }
    const version = str(body, 'runnerVersion', { max: 64 });
    if (!VERSION_RE.test(version)) throw new HttpError(400, 'invalid-body', 'runnerVersion must be MAJOR.MINOR.PATCH.');
    checkVersion(ctx, version);
    const publicKey = str(body, 'publicKey', { max: 64 });
    if (!rawKey(publicKey)) throw new HttpError(400, 'invalid-key', 'publicKey must be a raw Ed25519 key, base64url.');
    const name = runnerName(str(body, 'name', { max: 64 }));
    const labels = labelSet(os, arch, strList(body, 'labels', 16));
    const maxEnvironments = intOrNull(body, 'maxEnvironments', 1, 1000);
    const now = ctx.clock.now();

    const existing = await ctx.store.activeRunnerByName(user.id, name);
    if (existing && body.replace !== true) {
      throw new HttpError(409, 'name-taken', `You already have a runner named "${name}". Pick another name or re-register with --replace.`);
    }
    if (existing) {
      // Re-registering under a name replaces that runner on the same host:
      // the old key is revoked and its environments follow the new record.
      await ctx.store.removeRunner(existing.id, now);
      ctx.hub.dropRunner(existing.id, 'runner-replaced');
      ctx.hub.push(user.id, { type: 'runner.removed', runnerId: existing.id });
    }
    const runner = await ctx.store.createRunner({
      id: newId('rnr', now),
      userId: user.id,
      name,
      labels,
      os,
      arch,
      publicKey,
      fingerprint: keyFingerprint(publicKey),
      version,
      maxEnvironments,
      docker: dockerInfo(body.docker),
      createdAt: now,
    });
    if (existing) {
      const moved = await ctx.store.moveInstances(existing.id, runner.id, now);
      await ctx.audit('runner.replaced', { userId: user.id, runnerId: existing.id, detail: { by: runner.id, environments: moved.length } });
    }
    const fresh = (await ctx.store.getRunner(runner.id)) as Runner;
    await ctx.audit('runner.registered', {
      userId: user.id,
      runnerId: fresh.id,
      detail: { name, os, arch, version, fingerprint: fresh.fingerprint, tokenId: token.id },
    });
    ctx.hub.push(user.id, { type: 'runner.upsert', runner: runnerView(ctx, fresh) });
    return {
      status: 201,
      body: { runnerId: fresh.id, name, labels, fingerprint: fresh.fingerprint, owner: { login: user.login }, serverUrl: ctx.config.publicUrl },
    };
  });

  router.add('POST', '/v1/runners/token', async (req) => {
    const body = await req.json();
    const runner = await verifyAssertion(ctx, str(body, 'assertion', { max: 2048 }), '/v1/runners/token');
    checkVersion(ctx, runner.version);
    const token = newSecret('PRA');
    const expiresAt = ctx.clock.now() + RUNNER_TOKEN_TTL_MS;
    await ctx.store.putRunnerToken(hashSecret(token), runner.id, expiresAt);
    return { body: { accessToken: token, expiresAt } };
  });

  router.add('POST', '/v1/runners/remove', async (req) => {
    const body = await req.json();
    const runnerId = str(body, 'runnerId', { max: 64 });
    const environments = str(body, 'environments', { max: 16 });
    if (environments !== 'keep' && environments !== 'delete') {
      throw new HttpError(400, 'invalid-body', 'environments must be keep or delete.');
    }
    let runner: Runner | null;
    let by: string;
    if (typeof body.assertion === 'string') {
      runner = await verifyAssertion(ctx, str(body, 'assertion', { max: 2048 }), '/v1/runners/remove');
      if (runner.id !== runnerId) throw new HttpError(401, 'invalid-assertion', 'The assertion is for another runner.');
      by = 'runner';
    } else {
      const token = await enrollToken(ctx, str(body, 'removalToken', { max: 128 }), 'removal');
      runner = await ctx.store.getRunner(runnerId);
      if (!runner || runner.userId !== token.userId || runner.removedAt !== null) {
        throw new HttpError(404, 'not-found', 'No such runner.');
      }
      by = token.id;
    }
    await removeRunner(ctx, runner, environments, by);
    return { status: 204 };
  });

  router.add('GET', '/v1/runners', async (req) => {
    const { user } = await sessionFor(ctx, req);
    const runners = await ctx.store.listRunners(user.id);
    return { body: { runners: runners.map((r) => runnerView(ctx, r)) } };
  });

  const owned = async (req: Req) => {
    const { user } = await sessionFor(ctx, req);
    const runner = await ctx.store.getRunner(req.params.id);
    if (!runner || runner.userId !== user.id || runner.removedAt !== null) throw new HttpError(404, 'not-found', 'No such runner.');
    return { user, runner };
  };

  router.add('GET', '/v1/runners/:id', async (req) => {
    const { runner } = await owned(req);
    const instances = await ctx.store.instancesOnRunner(runner.id);
    return { body: { runner: runnerView(ctx, runner), instances: instances.map((i) => i.id) } };
  });

  router.add('PATCH', '/v1/runners/:id', async (req) => {
    const { user, runner } = await owned(req);
    const body = await req.json();
    const patch: { name?: string; labels?: string[] } = {};
    if (body.name !== undefined) {
      patch.name = runnerName(str(body, 'name', { max: 64 }));
      const clash = await ctx.store.activeRunnerByName(user.id, patch.name);
      if (clash && clash.id !== runner.id) throw new HttpError(409, 'name-taken', `You already have a runner named "${patch.name}".`);
    }
    if (body.labels !== undefined) patch.labels = labelSet(runner.os, runner.arch, strList(body, 'labels', 16));
    await ctx.store.updateRunner(runner.id, patch);
    const fresh = (await ctx.store.getRunner(runner.id)) as Runner;
    ctx.hub.push(user.id, { type: 'runner.upsert', runner: runnerView(ctx, fresh) });
    await ctx.audit('runner.updated', { userId: user.id, runnerId: runner.id, detail: { fields: Object.keys(patch) } });
    return { body: { runner: runnerView(ctx, fresh) } };
  });

  router.add('DELETE', '/v1/runners/:id', async (req) => {
    const { user, runner } = await owned(req);
    await removeRunner(ctx, runner, 'force', user.id);
    return { status: 204 };
  });
}
