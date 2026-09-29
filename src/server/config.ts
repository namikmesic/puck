/**
 * Server configuration, read once from the environment at start.
 *
 * Nothing secret is baked into the image. Every secret can be supplied as
 * `NAME` or as `NAME_FILE`, a path to a file holding it; the file form is
 * how a secret store or an orchestrator's mounted secrets reach the server
 * without the value ever sitting in the container's environment.
 *
 * GitHub sign-in is optional. With none of the App id, client id, client
 * secret, and private key, the server still boots, and every route that
 * needs GitHub answers 503 `github-not-configured`. Setting some of those
 * four but not all of them, or setting them without `PUCK_SERVER_TOKEN_KEY`,
 * is a start-up error, so a typo never silently disables sign-in. The App
 * slug and the GitHub endpoint URLs are optional.
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | PUCK_SERVER_URL | Public base URL (default `http://localhost:<port>`); runners and apps use it, and runner assertions are audienced to it |
 * | PUCK_SERVER_HOST, PUCK_SERVER_PORT | Listen address (default 127.0.0.1:8080) |
 * | PUCK_SERVER_DB | SQLite file (default `puck-server.db`; `:memory:` for tests) |
 * | PUCK_SERVER_TOKEN_KEY[_FILE] | 32 bytes, base64: encrypts GitHub user tokens at rest |
 * | PUCK_GITHUB_APP_ID, PUCK_GITHUB_CLIENT_ID | The GitHub App's id and OAuth client id |
 * | PUCK_GITHUB_APP_SLUG | Optional. The App's slug for its install link; by default the server asks GitHub |
 * | PUCK_GITHUB_CLIENT_SECRET[_FILE] | The App's client secret (web-flow code exchange) |
 * | PUCK_GITHUB_PRIVATE_KEY[_FILE] | The App's private key: PEM, or the PEM base64-encoded on one line (for env files) |
 * | PUCK_GITHUB_API_URL, PUCK_GITHUB_WEB_URL | GitHub endpoints (default github.com) |
 * | PUCK_RUNNER_DOWNLOADS | Directory of runner tarballs, `<version>/puck-runner-<os>-<arch>-<version>.tar.gz` |
 * | PUCK_RUNNER_MIN_VERSION | Runners older than this are refused |
 */

import { readFileSync } from 'node:fs';

export interface GitHubAppConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKeyPem: string;
  slug: string | null;
  apiUrl: string;
  webUrl: string;
}

export interface ServerConfig {
  publicUrl: string;
  host: string;
  port: number;
  dbPath: string;
  tokenKey: Buffer | null;
  github: GitHubAppConfig | null;
  runnerDownloads: string | null;
  minRunnerVersion: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function plain(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/** `NAME`, or the contents of the file `NAME_FILE` names; never both. */
export function secret(env: Env, name: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  const direct = plain(env, name);
  const file = plain(env, `${name}_FILE`);
  if (direct && file) throw new ConfigError(`Set ${name} or ${name}_FILE, not both.`);
  if (file) {
    let text: string;
    try {
      text = read(file);
    } catch {
      throw new ConfigError(`${name}_FILE points at a file that cannot be read.`);
    }
    return text.trim() || null;
  }
  return direct;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

function httpUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${name} must be http or https.`);
  return trimSlash(url.toString());
}

export function loadConfig(env: Env, read?: (path: string) => string): ServerConfig {
  const port = Number(plain(env, 'PUCK_SERVER_PORT') ?? '8080');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('PUCK_SERVER_PORT is not a port.');
  const publicUrl = httpUrl('PUCK_SERVER_URL', plain(env, 'PUCK_SERVER_URL') ?? `http://localhost:${port}`);

  const keyText = secret(env, 'PUCK_SERVER_TOKEN_KEY', read);
  let tokenKey: Buffer | null = null;
  if (keyText) {
    tokenKey = Buffer.from(keyText, 'base64');
    if (tokenKey.length !== 32) throw new ConfigError('PUCK_SERVER_TOKEN_KEY must be 32 bytes, base64-encoded.');
  }

  const parts = {
    appId: plain(env, 'PUCK_GITHUB_APP_ID'),
    clientId: plain(env, 'PUCK_GITHUB_CLIENT_ID'),
    clientSecret: secret(env, 'PUCK_GITHUB_CLIENT_SECRET', read),
    privateKeyPem: secret(env, 'PUCK_GITHUB_PRIVATE_KEY', read),
  };
  const missing = Object.entries(parts)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  let github: GitHubAppConfig | null = null;
  if (missing.length < 4) {
    if (missing.length) throw new ConfigError(`GitHub App configuration is incomplete; missing: ${missing.join(', ')}.`);
    if (!tokenKey) throw new ConfigError('PUCK_SERVER_TOKEN_KEY is required when the GitHub App is configured.');
    let pem = parts.privateKeyPem as string;
    if (!pem.includes('-----BEGIN')) {
      pem = Buffer.from(pem, 'base64').toString('utf8');
      if (!pem.includes('-----BEGIN')) throw new ConfigError('PUCK_GITHUB_PRIVATE_KEY is neither a PEM key nor a base64-encoded one.');
    }
    github = {
      appId: parts.appId as string,
      clientId: parts.clientId as string,
      clientSecret: parts.clientSecret as string,
      privateKeyPem: pem,
      slug: plain(env, 'PUCK_GITHUB_APP_SLUG'),
      apiUrl: httpUrl('PUCK_GITHUB_API_URL', plain(env, 'PUCK_GITHUB_API_URL') ?? 'https://api.github.com'),
      webUrl: httpUrl('PUCK_GITHUB_WEB_URL', plain(env, 'PUCK_GITHUB_WEB_URL') ?? 'https://github.com'),
    };
  }

  const minRunnerVersion = plain(env, 'PUCK_RUNNER_MIN_VERSION');
  if (minRunnerVersion && !/^\d+\.\d+\.\d+$/.test(minRunnerVersion)) {
    throw new ConfigError('PUCK_RUNNER_MIN_VERSION must be MAJOR.MINOR.PATCH.');
  }

  return {
    publicUrl,
    host: plain(env, 'PUCK_SERVER_HOST') ?? '127.0.0.1',
    port,
    dbPath: plain(env, 'PUCK_SERVER_DB') ?? 'puck-server.db',
    tokenKey,
    github,
    runnerDownloads: plain(env, 'PUCK_RUNNER_DOWNLOADS'),
    minRunnerVersion,
  };
}

/** `a` compared with `b` as MAJOR.MINOR.PATCH (a pre-release suffix is ignored). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map(Number);
  const pb = b.split('-')[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
