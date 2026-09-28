/**
 * Push the permission-relevant GitHub policies to the Puck server so the
 * next installation-token mint uses them. The daemon does not mint tokens.
 * `PUCK_SERVER_URL` is the server origin and `PUCK_GRANT_TOKEN` is the
 * owner's session access token. Neither value is logged.
 */

import { tokenPoliciesFrom, type GitHubTokenPolicies } from '../harness/github-permissions';
import { OpError } from './ops';

export async function syncGrantPolicies(env: NodeJS.ProcessEnv, envId: string, policies: GitHubTokenPolicies): Promise<void> {
  const base = env.PUCK_SERVER_URL;
  const token = env.PUCK_GRANT_TOKEN;
  if (typeof base !== 'string' || base === '' || typeof token !== 'string' || token === '') {
    throw new OpError('invalid-state', 'This update changes GitHub token permissions, and this environment has no way to update its grant.');
  }
  const body = JSON.stringify({ policies: { github: tokenPoliciesFrom(policies) } });
  let res: Response;
  try {
    res = await fetch(new URL(`/v1/instances/${encodeURIComponent(envId)}/policies`, base), {
      method: 'PUT',
      redirect: 'manual',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    await res.arrayBuffer();
  } catch (err) {
    if (err instanceof OpError) throw err;
    throw new OpError('invalid-state', 'The environment grant could not be updated, so this definition was not applied.');
  }
  if (!res.ok) {
    throw new OpError('invalid-state', 'The environment grant could not be updated, so this definition was not applied.');
  }
}
