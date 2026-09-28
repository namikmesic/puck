/**
 * The Puck GitHub App's public identity. Sign-in uses the OAuth device
 * flow, which needs only the client id - there is no client secret
 * anywhere in Puck. User tokens reach only the repositories where the app
 * is installed.
 *
 * The app is "Puck Agents" (github.com/apps/puck-agents). It requests
 * repository permissions Contents, Pull requests, Issues, Workflows and
 * Actions read/write, and Checks, Commit statuses and Metadata read; device
 * flow on; user tokens expire after 8 hours with a refresh token; no webhook.
 */

/** The registered app's client id (public, not a secret). */
export const GITHUB_APP_CLIENT_ID = 'Iv23liEFTqLz112apImK';

/** The app's URL slug (github.com/apps/<slug>). */
export const GITHUB_APP_SLUG = 'puck-agents';

/**
 * Development overrides for one test app. Setting either variable selects
 * this pair: each half comes only from its own variable, and the install
 * link is offered only when both are set. With neither set, the registered
 * Puck Agents pair is used.
 */
export const CLIENT_ID_ENV = 'PUCK_GITHUB_CLIENT_ID';
export const APP_SLUG_ENV = 'PUCK_GITHUB_APP_SLUG';

function isPlaceholder(id: string): boolean {
  return id.startsWith('PLACEHOLDER');
}

function devApp(env: NodeJS.ProcessEnv): { clientId: string | null; slug: string | null } | null {
  const clientId = env[CLIENT_ID_ENV]?.trim() || null;
  const slug = env[APP_SLUG_ENV]?.trim() || null;
  return clientId || slug ? { clientId, slug } : null;
}

/** The client id to sign in with, or null while that half of the selected app is unset. */
export function githubClientId(env: NodeJS.ProcessEnv = process.env): string | null {
  const dev = devApp(env);
  if (dev) return dev.clientId;
  return isPlaceholder(GITHUB_APP_CLIENT_ID) ? null : GITHUB_APP_CLIENT_ID;
}

/** The app slug, or null while that half of the selected app is unset. */
export function githubAppSlug(env: NodeJS.ProcessEnv = process.env): string | null {
  const dev = devApp(env);
  if (dev) return dev.slug;
  return isPlaceholder(GITHUB_APP_SLUG) ? null : GITHUB_APP_SLUG;
}

/**
 * Where a user installs the app on an account (then Puck re-checks
 * installations), or null unless both the client id and the slug are set.
 */
export function githubInstallUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const slug = githubAppSlug(env);
  if (slug === null || githubClientId(env) === null) return null;
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}
