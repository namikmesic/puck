/**
 * Credentials and secrets inside the environment.
 *
 * - The GitHub credential lives in /puck/state/secrets/github.json (root,
 *   0600): one installation token per repository owner (a grant), pushed
 *   by the runner before the previous one expires. It never leaves root:
 *   agents cannot read it, and it is never put in a harness environment.
 *   The daemon never refreshes a token.
 * - Environment secret values live in /puck/state/secrets/env.json (root,
 *   0600) and reach harness processes through their environment only.
 * - Harness CLI credential files live in the puck user's HOME, where the
 *   CLIs read and rotate them. The daemon reads and writes them AS the puck
 *   user (a short child process), never as root: HOME is agent-writable, and
 *   root following a planted symlink there could overwrite or disclose
 *   daemon state.
 *
 * The runner delivers all of these before first start as files in
 * /puck/inbox (root 0700): the app's files, plus the first GitHub grants,
 * which the runner fetches from the Puck server itself; `ingestInbox` validates each file, moves it into place and
 * deletes the inbox copy. Inbox files:
 *
 *   instance.json         { envId, name, pin, definition }
 *   github.json           { grants: [...] }: GitHub installation tokens (see `normalizeGithub`)
 *   secrets.json          { values: { NAME: "value", ... } }
 *   harness-<id>.json     a harness CLI credential file, verbatim
 *
 * A file that fails validation is renamed to `<name>.rejected` (the daemon
 * logs its name and the reason, never its content).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GithubAuth, GithubGrant } from '../harness/daemon-protocol';
import { readDefinition } from '../harness/env-definition';
import { validHarnessContent, validPin, validSecretValues } from '../harness/inbox';
import { harnessDescriptorById } from '../harness/providers';
import type { CommandRunner, RunOptions } from './exec';
import type { Logger } from './log';
import type { DaemonPaths } from './paths';
import { readJsonFile, writeFileAtomicSync } from './store/jsonfile';
import type { InstanceRecord } from './store/instance';

/** An environment's repositories span at most this many installations (one grant each). */
export const MAX_GRANTS = 20;
const MAX_GRANT_REPOS = 100;
/** `github.auth` reads `expiring` once the earliest grant has less than this left. */
export const EXPIRING_WITHIN_MS = 10 * 60_000;

/**
 * The environment's GitHub credential: the installation token grants the
 * runner pushed last, one per installation. Each push replaces the whole
 * set. There is no refresh token; the runner pushes fresh grants before
 * these expire, and the daemon never asks GitHub for a token itself.
 */
export interface GithubGrants {
  grants: GithubGrant[];
  savedAt: number;
}

/**
 * Printable ASCII. Installation tokens are no longer a fixed 40 characters:
 * GitHub's stateless `ghs_<app id>_<JWT>` form is much longer, so the cap
 * leaves room for a JWT.
 */
const TOKEN_RE = /^[\x21-\x7e]{8,8192}$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

function normalizeGrant(raw: unknown): GithubGrant | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.owner !== 'string' || !OWNER_RE.test(r.owner)) return null;
  if (typeof r.installationId !== 'number' || !Number.isSafeInteger(r.installationId) || r.installationId <= 0) return null;
  if (!Array.isArray(r.repos) || r.repos.length === 0 || r.repos.length > MAX_GRANT_REPOS) return null;
  const owner = r.owner.toLowerCase();
  for (const repo of r.repos) {
    if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.split('/')[0].toLowerCase() !== owner) return null;
  }
  if (typeof r.token !== 'string' || !TOKEN_RE.test(r.token)) return null;
  if (typeof r.expiresAt !== 'number' || !Number.isFinite(r.expiresAt) || r.expiresAt <= 0) return null;
  return { owner: r.owner, installationId: r.installationId, repos: [...r.repos] as string[], token: r.token, expiresAt: r.expiresAt };
}

/**
 * Accepts a non-empty list of installation token grants, each with an
 * expiry and repositories of its own owner, at most one per owner. Anything
 * else (a bare token, a refreshable user-token pair) is refused.
 */
export function normalizeGithub(raw: unknown, now: number): GithubGrants | null {
  const list = Array.isArray(raw) ? raw : (raw as { grants?: unknown } | null)?.grants;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_GRANTS) return null;
  const grants: GithubGrant[] = [];
  const owners = new Set<string>();
  for (const item of list) {
    const grant = normalizeGrant(item);
    if (!grant || owners.has(grant.owner.toLowerCase())) return null;
    owners.add(grant.owner.toLowerCase());
    grants.push(grant);
  }
  return { grants, savedAt: now };
}

/** The credential state clients render: `missing` with no live grant, `expiring` when one is close to (or past) expiry. */
export function githubAuthOf(cred: GithubGrants | null, now: number): GithubAuth {
  if (!cred || !cred.grants.length) return { state: 'missing' };
  const earliest = Math.min(...cred.grants.map((g) => g.expiresAt));
  const live = cred.grants.filter((g) => g.expiresAt > now);
  if (!live.length) return { state: 'missing', expiresAt: earliest };
  if (live.length < cred.grants.length || earliest - now < EXPIRING_WITHIN_MS) return { state: 'expiring', expiresAt: earliest };
  return { state: 'ok', expiresAt: earliest };
}

export interface CredentialsDeps {
  paths: DaemonPaths;
  log: Logger;
  run: CommandRunner;
  /** How to run as the puck user ({uid, gid} in the container; {} in tests). */
  asPuck: Pick<RunOptions, 'uid' | 'gid'>;
  now?: () => number;
}

export class Credentials {
  private readonly now: () => number;

  constructor(private readonly deps: CredentialsDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get githubFile(): string {
    return path.join(this.deps.paths.secrets, 'github.json');
  }

  private get envFile(): string {
    return path.join(this.deps.paths.secrets, 'env.json');
  }

  /* ---------- GitHub ---------- */

  github(): GithubGrants | null {
    try {
      return normalizeGithub(readJsonFile<unknown>(this.githubFile), 0);
    } catch {
      return null;
    }
  }

  /** The grant for a repository owner (case-insensitive), expired or not. */
  grantFor(owner: string): GithubGrant | null {
    const key = owner.toLowerCase();
    return this.github()?.grants.find((g) => g.owner.toLowerCase() === key) ?? null;
  }

  githubAuth(): GithubAuth {
    return githubAuthOf(this.github(), this.now());
  }

  /** Replaces the stored grants; returns false when the value is not a usable credential. */
  putGithub(raw: unknown): boolean {
    const cred = normalizeGithub(raw, this.now());
    if (!cred) return false;
    writeFileAtomicSync(this.githubFile, JSON.stringify(cred), 0o600);
    this.deps.log.info('credentials.github', {
      owners: cred.grants.map((g) => g.owner),
      expiresAt: Math.min(...cred.grants.map((g) => g.expiresAt)),
    });
    return true;
  }

  /* ---------- Environment secrets ---------- */

  envSecrets(): Record<string, string> {
    try {
      return validSecretValues(readJsonFile<unknown>(this.envFile)) ?? {};
    } catch {
      return {};
    }
  }

  /** Merges values into the stored set; returns false on invalid input. */
  putSecrets(raw: unknown): boolean {
    const values = validSecretValues(raw);
    if (!values) return false;
    const merged = { ...this.envSecrets(), ...values };
    writeFileAtomicSync(this.envFile, JSON.stringify(merged), 0o600);
    this.deps.log.info('credentials.secrets', { names: Object.keys(values) });
    return true;
  }

  /* ---------- Harness credential files ---------- */

  /** Where a harness keeps its credential file inside this container's HOME. */
  harnessFile(id: string): string | null {
    const descriptor = harnessDescriptorById(id);
    if (!descriptor) return null;
    return path.join(this.deps.paths.home, path.posix.relative('/puck/home', descriptor.credentialPath));
  }

  private stagedFile(id: string): string {
    return path.join(this.deps.paths.stagedCredentials, `${id}.json`);
  }

  /**
   * Writes a harness credential file as the puck user (0600 in a 0700
   * directory). Before the puck user exists, the file is staged under
   * /puck/state and written by provisioning.
   */
  async putHarness(id: string, content: string, homeReady: boolean): Promise<void> {
    if (!validHarnessContent(id, content)) throw new Error(`Invalid credential for ${id}.`);
    if (!homeReady) {
      writeFileAtomicSync(this.stagedFile(id), content, 0o600);
      return;
    }
    const file = this.harnessFile(id) as string;
    const dir = path.dirname(file);
    const tmp = `${file}.puckd.tmp`;
    const r = await this.deps.run(
      ['sh', '-c', 'umask 077 && mkdir -p "$1" && cat > "$2" && mv -f "$2" "$3"', 'sh', dir, tmp, file],
      { ...this.deps.asPuck, input: content, env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, timeoutMs: 15_000 },
    );
    if (r.code !== 0) throw new Error(`Could not write the ${id} credential file (exit ${String(r.code)}).`);
    this.deps.log.info('credentials.harness', { id });
  }

  /** Reads the harness credential files the CLIs hold now (for adopt-back), as the puck user. */
  async getHarness(ids: string[]): Promise<{ id: string; content: string }[]> {
    const out: { id: string; content: string }[] = [];
    for (const id of ids) {
      const file = this.harnessFile(id);
      if (!file) continue;
      const r = await this.deps.run(['cat', '--', file], {
        ...this.deps.asPuck,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
        timeoutMs: 15_000,
      });
      if (r.code === 0 && validHarnessContent(id, r.stdout)) out.push({ id, content: r.stdout });
    }
    return out;
  }

  /** Writes every staged harness credential into HOME, then drops the staged copy. */
  async writeStaged(): Promise<string[]> {
    let names: string[];
    try {
      names = fs.readdirSync(this.deps.paths.stagedCredentials);
    } catch {
      return [];
    }
    const written: string[] = [];
    for (const name of names) {
      const m = /^([a-z0-9-]+)\.json$/.exec(name);
      if (!m) continue;
      const file = path.join(this.deps.paths.stagedCredentials, name);
      const content = fs.readFileSync(file, 'utf8');
      await this.putHarness(m[1], content, true);
      fs.rmSync(file, { force: true });
      written.push(m[1]);
    }
    return written;
  }

  /* ---------- Inbox ---------- */

  /**
   * Ingests every file in /puck/inbox. `applyInstance` receives a validated
   * instance delivery. Returns what was ingested and what was rejected.
   */
  ingestInbox(applyInstance: (update: Pick<InstanceRecord, 'envId' | 'name' | 'pin' | 'sha' | 'definition'>) => void): {
    ingested: string[];
    rejected: string[];
  } {
    const { inbox } = this.deps.paths;
    const ingested: string[] = [];
    const rejected: string[] = [];
    let names: string[];
    try {
      names = fs.readdirSync(inbox).sort();
    } catch {
      return { ingested, rejected };
    }
    for (const name of names) {
      if (name.endsWith('.rejected')) continue;
      const file = path.join(inbox, name);
      let reason: string | null = null;
      try {
        if (!fs.lstatSync(file).isFile()) throw new Error('not a regular file');
        const text = fs.readFileSync(file, 'utf8');
        reason = this.ingestOne(name, text, applyInstance);
      } catch (err) {
        reason = (err as Error).message;
      }
      if (reason === null) {
        fs.rmSync(file, { force: true });
        ingested.push(name);
      } else {
        try {
          fs.renameSync(file, `${file}.rejected`);
        } catch {
          fs.rmSync(file, { force: true, recursive: true });
        }
        rejected.push(name);
        this.deps.log.warn('inbox.rejected', { file: name, reason });
      }
    }
    if (ingested.length) this.deps.log.info('inbox.ingested', { files: ingested });
    return { ingested, rejected };
  }

  /** Returns null on success, or why the file was refused. */
  private ingestOne(
    name: string,
    text: string,
    applyInstance: (update: Pick<InstanceRecord, 'envId' | 'name' | 'pin' | 'sha' | 'definition'>) => void,
  ): string | null {
    const harness = /^harness-([a-z0-9-]+)\.json$/.exec(name);
    if (harness) {
      if (!validHarnessContent(harness[1], text)) return 'not a credential file for a known harness';
      writeFileAtomicSync(this.stagedFile(harness[1]), text, 0o600);
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return 'not JSON';
    }
    switch (name) {
      case 'github.json':
        return this.putGithub(json) ? null : 'not a GitHub credential';
      case 'secrets.json': {
        const values = (json as { values?: unknown })?.values;
        return this.putSecrets(values) ? null : 'invalid secret values';
      }
      case 'instance.json': {
        const r = json as { envId?: unknown; name?: unknown; pin?: unknown; definition?: unknown };
        if (typeof r.envId !== 'string' || !/^env_[A-Za-z0-9]{1,40}$/.test(r.envId)) return 'invalid envId';
        const def = readDefinition(r.definition);
        if (!def.ok) return def.error;
        const pin = validPin(r.pin);
        applyInstance({
          envId: r.envId,
          name: typeof r.name === 'string' && r.name ? r.name.slice(0, 200) : def.value.name,
          pin,
          sha: pin?.sha ?? null,
          definition: r.definition,
        });
        return null;
      }
      default:
        return 'unknown inbox file';
    }
  }
}
