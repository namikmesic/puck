/**
 * Push the permission-relevant GitHub policies to the Puck server so the
 * next installation-token mint uses them. The daemon does not mint tokens.
 * `PUCK_SERVER_URL` is the server origin and `PUCK_GRANT_TOKEN` is the
 * owner's session access token. Neither value is logged. Each attempt has
 * a deadline, so a hung connection cannot hold `definition.apply` open.
 */

import { tokenPoliciesFrom, type GitHubTokenPolicies } from '../harness/github-permissions';
import { OpError } from './ops';

/** How long one PUT attempt may take. There are at most two. */
export const GRANT_SYNC_TIMEOUT_MS = 15_000;

/** True when this environment can update its grant (the server URL and token are set). */
export function grantSyncConfigured(env: NodeJS.ProcessEnv): boolean {
  return !!env.PUCK_SERVER_URL && !!env.PUCK_GRANT_TOKEN;
}

export async function syncGrantPolicies(
  env: NodeJS.ProcessEnv,
  envId: string,
  policies: GitHubTokenPolicies,
  timeoutMs = GRANT_SYNC_TIMEOUT_MS,
): Promise<void> {
  const base = env.PUCK_SERVER_URL;
  const token = env.PUCK_GRANT_TOKEN;
  if (typeof base !== 'string' || base === '' || typeof token !== 'string' || token === '') {
    throw new OpError('invalid-state', 'This update changes GitHub token permissions, and this environment has no way to update its grant.');
  }
  const body = JSON.stringify({ policies: { github: tokenPoliciesFrom(policies) } });
  const url = new URL(`/v1/instances/${encodeURIComponent(envId)}/policies`, base);
  const init = (): RequestInit => ({
    method: 'PUT',
    redirect: 'manual',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const putOnce = async (): Promise<Response | undefined> => {
    try {
      const got = await fetch(url, init());
      if (got.status === 0) {
        await got.arrayBuffer().catch(() => undefined);
        return undefined;
      }
      return got;
    } catch (err) {
      if (err instanceof OpError) throw err;
      return undefined;
    }
  };
  const res = (await putOnce()) ?? (await putOnce());
  if (!res || !res.ok) {
    await res?.arrayBuffer().catch(() => undefined);
    throw new OpError('invalid-state', 'The environment grant could not be updated, so this definition was not applied.');
  }
  await res.arrayBuffer().catch(() => undefined);
}
