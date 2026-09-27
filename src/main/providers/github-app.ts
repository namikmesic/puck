/**
 * The Puck GitHub App's public identity. Sign-in uses the OAuth device
 * flow, which needs only the client id - there is no client secret
 * anywhere in Puck. User tokens reach only the repositories where the app
 * is installed.
 *
 * The app requests: Contents read/write, Pull requests read/write, Metadata
 * read, Workflows read/write; device flow on; user-token expiration on.
 */

/**
 * PLACEHOLDER - the GitHub App is not registered yet. Replace this with the
 * registered app's client id (it is public, not a secret). Until then
 * GitHub sign-in is disabled unless PUCK_GITHUB_CLIENT_ID is set; the
 * personal-token fallback works regardless.
 */
export const GITHUB_APP_CLIENT_ID = 'PLACEHOLDER-unregistered-github-app';

/** The app's URL slug (github.com/apps/<slug>); set with the registration. */
export const GITHUB_APP_SLUG = 'puck';

/** Development override for the client id (and slug) of a test app. */
export const CLIENT_ID_ENV = 'PUCK_GITHUB_CLIENT_ID';
export const APP_SLUG_ENV = 'PUCK_GITHUB_APP_SLUG';

function isPlaceholder(id: string): boolean {
  return id.startsWith('PLACEHOLDER');
}

/** The client id to sign in with, or null while only the placeholder exists. */
export function githubClientId(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[CLIENT_ID_ENV]?.trim();
  if (override) return override;
  return isPlaceholder(GITHUB_APP_CLIENT_ID) ? null : GITHUB_APP_CLIENT_ID;
}

export function githubAppSlug(env: NodeJS.ProcessEnv = process.env): string {
  return env[APP_SLUG_ENV]?.trim() || GITHUB_APP_SLUG;
}

/** Where a user installs the app on an account (then Puck re-checks installations). */
export function githubInstallUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `https://github.com/apps/${encodeURIComponent(githubAppSlug(env))}/installations/new`;
}

/** Pre-filled fine-grained personal access token page (the fallback). */
export const GITHUB_PAT_URL =
  'https://github.com/settings/personal-access-tokens/new?name=Puck&contents=write&pull_requests=write&expires_in=90';
