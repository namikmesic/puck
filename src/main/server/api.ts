/**
 * The Puck server's REST API as the app uses it, one function per call,
 * every one authenticated with the Puck session (session.ts). Answers are
 * read leniently (src/harness/server-api.ts).
 */

import {
  readInstance,
  readReleases,
  readRunner,
  type RunnerReleases,
  type ServerInstance,
  type ServerRunner,
} from '../../harness/server-api';
import { serverRequest } from './http';
import { authed } from './session';

export interface EnrollToken {
  id: string;
  token: string;
  expiresAt: number;
  serverUrl: string;
}

function enrollToken(body: Record<string, unknown>): EnrollToken {
  if (typeof body.token !== 'string' || typeof body.id !== 'string') throw new Error('The Puck server did not issue a token.');
  return {
    id: body.id,
    token: body.token,
    expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : 0,
    serverUrl: typeof body.serverUrl === 'string' ? body.serverUrl.replace(/\/+$/, '') : '',
  };
}

export async function me(): Promise<{ id: string; login: string }> {
  const body = await authed<{ user?: { id?: unknown; login?: unknown } }>('GET', '/v1/me');
  return { id: String(body.user?.id ?? ''), login: String(body.user?.login ?? '') };
}

/** The user's current GitHub access token (never the refresh token). */
export async function githubToken(): Promise<{ token: string; expiresAt: number }> {
  const body = await authed('GET', '/v1/github/token');
  if (typeof body.token !== 'string') throw new Error('The Puck server returned no GitHub token.');
  return { token: body.token, expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : 0 };
}

export async function listRunners(): Promise<ServerRunner[]> {
  const body = await authed<{ runners?: unknown[] }>('GET', '/v1/runners');
  return (body.runners ?? []).flatMap((r) => readRunner(r) ?? []);
}

export async function updateRunner(id: string, patch: { name?: string; labels?: string[] }): Promise<ServerRunner> {
  const body = await authed<{ runner?: unknown }>('PATCH', `/v1/runners/${encodeURIComponent(id)}`, patch);
  const runner = readRunner(body.runner);
  if (!runner) throw new Error('The Puck server returned no runner.');
  return runner;
}

export async function forceRemoveRunner(id: string): Promise<void> {
  await authed('DELETE', `/v1/runners/${encodeURIComponent(id)}`);
}

export async function registrationToken(): Promise<EnrollToken> {
  return enrollToken(await authed('POST', '/v1/runners/registration-token'));
}

export async function removalToken(): Promise<EnrollToken> {
  return enrollToken(await authed('POST', '/v1/runners/removal-token'));
}

export async function revokeEnrollToken(kind: 'registration' | 'removal', id: string): Promise<void> {
  await authed('DELETE', `/v1/runners/${kind}-token/${encodeURIComponent(id)}`);
}

export async function listInstances(): Promise<ServerInstance[]> {
  const body = await authed<{ instances?: unknown[] }>('GET', '/v1/instances');
  return (body.instances ?? []).flatMap((i) => readInstance(i) ?? []);
}

export interface CreateInstance {
  runnerId: string;
  definition: string;
  repos: string[];
  policies?: { github?: object };
}

/** Records a new environment in the index; the server mints its id and checks every repository. */
export async function createInstance(req: CreateInstance): Promise<ServerInstance> {
  const body = await authed<{ instance?: unknown }>('POST', '/v1/instances', req);
  const instance = readInstance(body.instance);
  if (!instance) throw new Error('The Puck server did not record the environment.');
  return instance;
}

/** Forgets an environment in the index (its container is the runner's business). */
export async function forgetInstance(envId: string): Promise<void> {
  await authed('DELETE', `/v1/instances/${encodeURIComponent(envId)}`);
}

export async function releases(): Promise<RunnerReleases> {
  return readReleases(await serverRequest('GET', '/v1/runner/releases'));
}
