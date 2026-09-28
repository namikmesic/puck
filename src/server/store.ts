/**
 * The server's one store: users and their sessions, the encrypted GitHub
 * user tokens, runner registration and access tokens, runners, the instance
 * index with its repository grants, and the audit log.
 *
 * `Store` is async and speaks in records, never SQL, so a Postgres
 * implementation can replace `SqliteStore` without touching a caller. Each
 * method is one atomic step: node:sqlite is synchronous, so a method body
 * runs to completion before any other request is served, and the few
 * multi-statement methods also run inside a transaction.
 *
 * What is stored: every bearer secret only as its sha256 (`ids.hashSecret`);
 * GitHub user tokens only as ciphertext the caller produced; never a GitHub
 * App secret, an installation token, or any channel content.
 *
 * Migrations are append-only entries of `MIGRATIONS`; `schema_version`
 * records how many have run.
 */

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export interface User {
  id: string;
  githubId: number;
  login: string;
  createdAt: number;
}

export interface Session {
  id: string;
  userId: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  createdAt: number;
  revokedAt: number | null;
}

export type EnrollKind = 'registration' | 'removal';

export interface EnrollToken {
  id: string;
  kind: EnrollKind;
  userId: string;
  expiresAt: number;
  revokedAt: number | null;
}

export interface DockerInfo {
  ok: boolean;
  version: string | null;
  /** A classified Docker problem the runner reported, when not ok. */
  problem: string | null;
  ncpu: number | null;
  memTotal: number | null;
}

export interface Runner {
  id: string;
  userId: string;
  name: string;
  labels: string[];
  os: string;
  arch: string;
  /** Ed25519 public key, raw 32 bytes in base64url. */
  publicKey: string;
  fingerprint: string;
  version: string;
  maxEnvironments: number | null;
  docker: DockerInfo | null;
  createdAt: number;
  lastSeenAt: number | null;
  removedAt: number | null;
}

/** `active`, or kept on a runner that was removed (`orphaned`), or on a runner force-removed (`lost`). */
export type InstanceStatus = 'active' | 'orphaned' | 'lost';

export interface Instance {
  id: string;
  userId: string;
  runnerId: string;
  definition: string;
  status: InstanceStatus;
  /** The GitHub App permissions its installation tokens carry. */
  permissions: Record<string, 'read' | 'write'>;
  createdAt: number;
  updatedAt: number;
}

export interface GrantRepo {
  envId: string;
  repoId: number;
  owner: string;
  name: string;
  installationId: number;
  verifiedAt: number;
  /** Set when a re-verification found the owner lost push access. */
  revokedAt: number | null;
}

export interface AuditEvent {
  id: string;
  at: number;
  kind: string;
  userId: string | null;
  runnerId: string | null;
  envId: string | null;
  detail: Record<string, unknown>;
}

export interface SignInRequest {
  redirectUri: string;
  codeChallenge: string;
  appState: string;
  expiresAt: number;
}

export interface SignInCode {
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

export interface NewRunner {
  id: string;
  userId: string;
  name: string;
  labels: string[];
  os: string;
  arch: string;
  publicKey: string;
  fingerprint: string;
  version: string;
  maxEnvironments: number | null;
  docker: DockerInfo | null;
  createdAt: number;
}

export interface Store {
  close(): Promise<void>;

  upsertUser(githubId: number, login: string, newId: string, now: number): Promise<User>;
  getUser(id: string): Promise<User | null>;
  putGitHubTokens(userId: string, ciphertext: Buffer, now: number): Promise<void>;
  getGitHubTokens(userId: string): Promise<Buffer | null>;
  deleteGitHubTokens(userId: string): Promise<void>;

  putSignInRequest(stateHash: string, req: SignInRequest): Promise<void>;
  /** Returns and deletes the request: a GitHub callback is honored once. */
  takeSignInRequest(stateHash: string): Promise<SignInRequest | null>;
  putSignInCode(codeHash: string, code: SignInCode): Promise<void>;
  takeSignInCode(codeHash: string): Promise<SignInCode | null>;

  createSession(s: Session, accessHash: string, refreshHash: string): Promise<void>;
  sessionByAccess(accessHash: string): Promise<Session | null>;
  getSession(id: string): Promise<Session | null>;
  /**
   * Rotates the refresh token. `reused` means `oldHash` was already spent
   * (the session is revoked as a precaution); `null` means it never existed.
   */
  rotateRefresh(
    oldHash: string,
    next: { accessHash: string; refreshHash: string; accessExpiresAt: number; refreshExpiresAt: number },
    now: number,
  ): Promise<{ session: Session } | { reused: true; session: Session } | null>;
  revokeSession(id: string, now: number): Promise<void>;
  revokeUserSessions(userId: string, now: number): Promise<void>;

  createEnrollToken(t: EnrollToken, hash: string, createdAt: number): Promise<void>;
  enrollTokenByHash(hash: string): Promise<EnrollToken | null>;
  revokeEnrollToken(userId: string, id: string, now: number): Promise<boolean>;

  /** Inserts a live runner. Throws `NameTakenError` when that user already has the name. */
  createRunner(r: NewRunner): Promise<Runner>;
  /**
   * Removes `oldId` and its tokens, inserts `next`, and moves its instances,
   * in one transaction. Throws `NameTakenError` (and keeps `oldId`) when the
   * new name is already live.
   */
  replaceRunner(oldId: string, next: NewRunner, now: number): Promise<{ runner: Runner; moved: string[] }>;
  getRunner(id: string): Promise<Runner | null>;
  activeRunnerByName(userId: string, name: string): Promise<Runner | null>;
  listRunners(userId: string): Promise<Runner[]>;
  updateRunner(id: string, patch: Partial<Pick<Runner, 'name' | 'labels' | 'version' | 'docker' | 'maxEnvironments' | 'lastSeenAt'>>): Promise<void>;
  /**
   * Removes the runner and its tokens and settles its instances, in one
   * transaction: `delete` forgets them, `keep` marks them orphaned, `force`
   * marks them lost. Returns the affected environment ids.
   */
  retireRunner(id: string, now: number, how: 'keep' | 'delete' | 'force'): Promise<string[]>;

  putRunnerToken(hash: string, runnerId: string, expiresAt: number): Promise<void>;
  runnerByToken(hash: string, now: number): Promise<Runner | null>;
  /** Records an assertion id; false when it was already seen and has not expired. */
  useAssertionId(runnerId: string, jti: string, expiresAt: number, now: number): Promise<boolean>;
  /** Deletes expired sign-in state, tokens and assertion ids. */
  sweep(now: number): Promise<void>;

  /**
   * Inserts the instance and its grant. `gone` when that runner row is
   * missing or already removed; `full` when it already hosts
   * `maxEnvironments` active instances.
   */
  createInstance(i: Instance, repos: GrantRepo[]): Promise<'ok' | 'gone' | { full: number }>;
  getInstance(id: string): Promise<Instance | null>;
  listInstances(userId: string): Promise<Instance[]>;
  instancesOnRunner(runnerId: string): Promise<Instance[]>;
  setInstanceStatus(id: string, status: InstanceStatus, now: number): Promise<void>;
  replaceGrant(envId: string, repos: GrantRepo[], permissions: Instance['permissions'], now: number): Promise<void>;
  /** Replaces the permission set minted for this environment. Repositories stay. */
  setPermissions(envId: string, permissions: Instance['permissions'], now: number): Promise<void>;
  deleteInstance(id: string): Promise<void>;
  grantRepos(envId: string): Promise<GrantRepo[]>;
  markRepoVerified(envId: string, repoId: number, now: number): Promise<void>;
  revokeRepo(envId: string, repoId: number, now: number): Promise<void>;

  audit(e: AuditEvent): Promise<void>;
  listAudit(userId: string, limit: number): Promise<AuditEvent[]>;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY, github_id INTEGER NOT NULL UNIQUE, login TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE github_tokens (
     user_id TEXT PRIMARY KEY REFERENCES users(id), ciphertext BLOB NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE sign_in_requests (
     state_hash TEXT PRIMARY KEY, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
     app_state TEXT NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE sign_in_codes (
     code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, code_challenge TEXT NOT NULL,
     redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
     access_hash TEXT NOT NULL UNIQUE, access_expires_at INTEGER NOT NULL,
     refresh_hash TEXT NOT NULL UNIQUE, refresh_expires_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL, revoked_at INTEGER);
   CREATE TABLE spent_refresh (
     hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE enroll_tokens (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
   CREATE TABLE runners (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
     labels TEXT NOT NULL, os TEXT NOT NULL, arch TEXT NOT NULL, public_key TEXT NOT NULL,
     fingerprint TEXT NOT NULL, version TEXT NOT NULL, max_environments INTEGER, docker TEXT,
     created_at INTEGER NOT NULL, last_seen_at INTEGER, removed_at INTEGER);
   CREATE UNIQUE INDEX runners_live_name ON runners(user_id, name) WHERE removed_at IS NULL;
   CREATE TABLE runner_tokens (
     token_hash TEXT PRIMARY KEY, runner_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
   CREATE TABLE assertion_ids (
     runner_id TEXT NOT NULL, jti TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (runner_id, jti));
   CREATE TABLE instances (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), runner_id TEXT NOT NULL,
     definition TEXT NOT NULL, status TEXT NOT NULL, permissions TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX instances_runner ON instances(runner_id);
   CREATE TABLE grant_repos (
     env_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE, repo_id INTEGER NOT NULL,
     owner TEXT NOT NULL, name TEXT NOT NULL, installation_id INTEGER NOT NULL,
     verified_at INTEGER NOT NULL, revoked_at INTEGER, PRIMARY KEY (env_id, repo_id));
   CREATE TABLE audit (
     id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, user_id TEXT,
     runner_id TEXT, env_id TEXT, detail TEXT NOT NULL);
   CREATE INDEX audit_user ON audit(user_id, at);`,
];

type Row = Record<string, SQLInputValue>;

const num = (v: SQLInputValue): number => Number(v);
const optNum = (v: SQLInputValue): number | null => (v === null || v === undefined ? null : Number(v));
const text = (v: SQLInputValue): string => String(v);

function toUser(r: Row): User {
  return { id: text(r.id), githubId: num(r.github_id), login: text(r.login), createdAt: num(r.created_at) };
}

function toSession(r: Row): Session {
  return {
    id: text(r.id),
    userId: text(r.user_id),
    accessExpiresAt: num(r.access_expires_at),
    refreshExpiresAt: num(r.refresh_expires_at),
    createdAt: num(r.created_at),
    revokedAt: optNum(r.revoked_at),
  };
}

function toRunner(r: Row): Runner {
  return {
    id: text(r.id),
    userId: text(r.user_id),
    name: text(r.name),
    labels: JSON.parse(text(r.labels)) as string[],
    os: text(r.os),
    arch: text(r.arch),
    publicKey: text(r.public_key),
    fingerprint: text(r.fingerprint),
    version: text(r.version),
    maxEnvironments: optNum(r.max_environments),
    docker: r.docker === null ? null : (JSON.parse(text(r.docker)) as DockerInfo),
    createdAt: num(r.created_at),
    lastSeenAt: optNum(r.last_seen_at),
    removedAt: optNum(r.removed_at),
  };
}

function toInstance(r: Row): Instance {
  return {
    id: text(r.id),
    userId: text(r.user_id),
    runnerId: text(r.runner_id),
    definition: text(r.definition),
    status: text(r.status) as InstanceStatus,
    permissions: JSON.parse(text(r.permissions)) as Instance['permissions'],
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
  };
}

function toGrantRepo(r: Row): GrantRepo {
  return {
    envId: text(r.env_id),
    repoId: num(r.repo_id),
    owner: text(r.owner),
    name: text(r.name),
    installationId: num(r.installation_id),
    verifiedAt: num(r.verified_at),
    revokedAt: optNum(r.revoked_at),
  };
}

export class NameTakenError extends Error {
  constructor() {
    super('A runner with this name is already registered.');
    this.name = 'NameTakenError';
  }
}

function isLiveNameTaken(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed: runners.user_id, runners.name');
}

function toAudit(r: Row): AuditEvent {
  return {
    id: text(r.id),
    at: num(r.at),
    kind: text(r.kind),
    userId: r.user_id === null ? null : text(r.user_id),
    runnerId: r.runner_id === null ? null : text(r.runner_id),
    envId: r.env_id === null ? null : text(r.env_id),
    detail: JSON.parse(text(r.detail)) as Record<string, unknown>,
  };
}

export class SqliteStore implements Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT version FROM schema_version').get() as Row | undefined;
    let version = row ? num(row.version) : 0;
    if (!row) this.db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    if (version > MIGRATIONS.length) {
      throw new Error(`The database schema (${version}) is newer than this server (${MIGRATIONS.length}).`);
    }
    for (; version < MIGRATIONS.length; version++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[version]);
        this.db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
      });
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private one(sql: string, ...args: SQLInputValue[]): Row | null {
    return (this.db.prepare(sql).get(...args) as Row | undefined) ?? null;
  }

  private all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }

  private run(sql: string, ...args: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...args).changes);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async upsertUser(githubId: number, login: string, newId: string, now: number): Promise<User> {
    this.run(
      `INSERT INTO users (id, github_id, login, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, updated_at = excluded.updated_at`,
      newId,
      githubId,
      login,
      now,
      now,
    );
    return toUser(this.one('SELECT * FROM users WHERE github_id = ?', githubId) as Row);
  }

  async getUser(id: string): Promise<User | null> {
    const r = this.one('SELECT * FROM users WHERE id = ?', id);
    return r ? toUser(r) : null;
  }

  async putGitHubTokens(userId: string, ciphertext: Buffer, now: number): Promise<void> {
    this.run(
      `INSERT INTO github_tokens (user_id, ciphertext, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
      userId,
      ciphertext,
      now,
    );
  }

  async getGitHubTokens(userId: string): Promise<Buffer | null> {
    const r = this.one('SELECT ciphertext FROM github_tokens WHERE user_id = ?', userId);
    return r ? Buffer.from(r.ciphertext as Uint8Array) : null;
  }

  async deleteGitHubTokens(userId: string): Promise<void> {
    this.run('DELETE FROM github_tokens WHERE user_id = ?', userId);
  }

  async putSignInRequest(stateHash: string, req: SignInRequest): Promise<void> {
    this.run(
      'INSERT INTO sign_in_requests (state_hash, redirect_uri, code_challenge, app_state, expires_at) VALUES (?, ?, ?, ?, ?)',
      stateHash,
      req.redirectUri,
      req.codeChallenge,
      req.appState,
      req.expiresAt,
    );
  }

  async takeSignInRequest(stateHash: string): Promise<SignInRequest | null> {
    return this.tx(() => {
      const r = this.one('SELECT * FROM sign_in_requests WHERE state_hash = ?', stateHash);
      if (!r) return null;
      this.run('DELETE FROM sign_in_requests WHERE state_hash = ?', stateHash);
      return {
        redirectUri: text(r.redirect_uri),
        codeChallenge: text(r.code_challenge),
        appState: text(r.app_state),
        expiresAt: num(r.expires_at),
      };
    });
  }

  async putSignInCode(codeHash: string, code: SignInCode): Promise<void> {
    this.run(
      'INSERT INTO sign_in_codes (code_hash, user_id, code_challenge, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?)',
      codeHash,
      code.userId,
      code.codeChallenge,
      code.redirectUri,
      code.expiresAt,
    );
  }

  async takeSignInCode(codeHash: string): Promise<SignInCode | null> {
    return this.tx(() => {
      const r = this.one('SELECT * FROM sign_in_codes WHERE code_hash = ?', codeHash);
      if (!r) return null;
      this.run('DELETE FROM sign_in_codes WHERE code_hash = ?', codeHash);
      return {
        userId: text(r.user_id),
        codeChallenge: text(r.code_challenge),
        redirectUri: text(r.redirect_uri),
        expiresAt: num(r.expires_at),
      };
    });
  }

  async createSession(s: Session, accessHash: string, refreshHash: string): Promise<void> {
    this.run(
      `INSERT INTO sessions (id, user_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      s.id,
      s.userId,
      accessHash,
      s.accessExpiresAt,
      refreshHash,
      s.refreshExpiresAt,
      s.createdAt,
    );
  }

  async sessionByAccess(accessHash: string): Promise<Session | null> {
    const r = this.one('SELECT * FROM sessions WHERE access_hash = ?', accessHash);
    return r ? toSession(r) : null;
  }

  async getSession(id: string): Promise<Session | null> {
    const r = this.one('SELECT * FROM sessions WHERE id = ?', id);
    return r ? toSession(r) : null;
  }

  async rotateRefresh(
    oldHash: string,
    next: { accessHash: string; refreshHash: string; accessExpiresAt: number; refreshExpiresAt: number },
    now: number,
  ): Promise<{ session: Session } | { reused: true; session: Session } | null> {
    return this.tx(() => {
      const current = this.one('SELECT * FROM sessions WHERE refresh_hash = ?', oldHash);
      if (current && (current.revoked_at !== null || num(current.refresh_expires_at) <= now)) return null;
      if (current) {
        this.run(
          'INSERT INTO spent_refresh (hash, session_id, expires_at) VALUES (?, ?, ?)',
          oldHash,
          text(current.id),
          num(current.refresh_expires_at),
        );
        this.run(
          `UPDATE sessions SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ? WHERE id = ?`,
          next.accessHash,
          next.accessExpiresAt,
          next.refreshHash,
          next.refreshExpiresAt,
          text(current.id),
        );
        return { session: toSession(this.one('SELECT * FROM sessions WHERE id = ?', text(current.id)) as Row) };
      }
      const spent = this.one('SELECT session_id FROM spent_refresh WHERE hash = ?', oldHash);
      if (!spent) return null;
      this.run('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', now, text(spent.session_id));
      const s = this.one('SELECT * FROM sessions WHERE id = ?', text(spent.session_id));
      return s ? { reused: true as const, session: toSession(s) } : null;
    });
  }

  async revokeSession(id: string, now: number): Promise<void> {
    this.run('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', now, id);
  }

  async revokeUserSessions(userId: string, now: number): Promise<void> {
    this.run('UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?', now, userId);
  }

  async createEnrollToken(t: EnrollToken, hash: string, createdAt: number): Promise<void> {
    this.run(
      'INSERT INTO enroll_tokens (id, kind, token_hash, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      t.id,
      t.kind,
      hash,
      t.userId,
      createdAt,
      t.expiresAt,
    );
  }

  async enrollTokenByHash(hash: string): Promise<EnrollToken | null> {
    const r = this.one('SELECT * FROM enroll_tokens WHERE token_hash = ?', hash);
    if (!r) return null;
    return {
      id: text(r.id),
      kind: text(r.kind) as EnrollKind,
      userId: text(r.user_id),
      expiresAt: num(r.expires_at),
      revokedAt: optNum(r.revoked_at),
    };
  }

  async revokeEnrollToken(userId: string, id: string, now: number): Promise<boolean> {
    return this.run('UPDATE enroll_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND user_id = ?', now, id, userId) > 0;
  }

  private insertRunner(r: NewRunner): Runner {
    this.run(
      `INSERT INTO runners (id, user_id, name, labels, os, arch, public_key, fingerprint, version, max_environments, docker, created_at, last_seen_at, removed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      r.id,
      r.userId,
      r.name,
      JSON.stringify(r.labels),
      r.os,
      r.arch,
      r.publicKey,
      r.fingerprint,
      r.version,
      r.maxEnvironments,
      r.docker ? JSON.stringify(r.docker) : null,
      r.createdAt,
    );
    return toRunner(this.one('SELECT * FROM runners WHERE id = ?', r.id) as Row);
  }

  async createRunner(r: NewRunner): Promise<Runner> {
    try {
      return this.insertRunner(r);
    } catch (err) {
      if (isLiveNameTaken(err)) throw new NameTakenError();
      throw err;
    }
  }

  async replaceRunner(oldId: string, next: NewRunner, now: number): Promise<{ runner: Runner; moved: string[] }> {
    try {
      return this.tx(() => {
        this.run('UPDATE runners SET removed_at = COALESCE(removed_at, ?) WHERE id = ?', now, oldId);
        this.run('DELETE FROM runner_tokens WHERE runner_id = ?', oldId);
        const runner = this.insertRunner(next);
        const moved = this.all('SELECT id FROM instances WHERE runner_id = ?', oldId).map((row) => text(row.id));
        if (moved.length) this.run('UPDATE instances SET runner_id = ?, updated_at = ? WHERE runner_id = ?', next.id, now, oldId);
        return { runner, moved };
      });
    } catch (err) {
      if (isLiveNameTaken(err)) throw new NameTakenError();
      throw err;
    }
  }

  async getRunner(id: string): Promise<Runner | null> {
    const r = this.one('SELECT * FROM runners WHERE id = ?', id);
    return r ? toRunner(r) : null;
  }

  async activeRunnerByName(userId: string, name: string): Promise<Runner | null> {
    const r = this.one('SELECT * FROM runners WHERE user_id = ? AND name = ? AND removed_at IS NULL', userId, name);
    return r ? toRunner(r) : null;
  }

  async listRunners(userId: string): Promise<Runner[]> {
    return this.all('SELECT * FROM runners WHERE user_id = ? AND removed_at IS NULL ORDER BY created_at', userId).map(toRunner);
  }

  async updateRunner(
    id: string,
    patch: Partial<Pick<Runner, 'name' | 'labels' | 'version' | 'docker' | 'maxEnvironments' | 'lastSeenAt'>>,
  ): Promise<void> {
    const cols: Record<string, SQLInputValue> = {};
    if (patch.name !== undefined) cols.name = patch.name;
    if (patch.labels !== undefined) cols.labels = JSON.stringify(patch.labels);
    if (patch.version !== undefined) cols.version = patch.version;
    if (patch.docker !== undefined) cols.docker = patch.docker ? JSON.stringify(patch.docker) : null;
    if (patch.maxEnvironments !== undefined) cols.max_environments = patch.maxEnvironments;
    if (patch.lastSeenAt !== undefined) cols.last_seen_at = patch.lastSeenAt;
    const keys = Object.keys(cols);
    if (!keys.length) return;
    try {
      this.run(`UPDATE runners SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), id);
    } catch (err) {
      if (isLiveNameTaken(err)) throw new NameTakenError();
      throw err;
    }
  }

  async retireRunner(id: string, now: number, how: 'keep' | 'delete' | 'force'): Promise<string[]> {
    return this.tx(() => {
      this.run('UPDATE runners SET removed_at = COALESCE(removed_at, ?) WHERE id = ?', now, id);
      this.run('DELETE FROM runner_tokens WHERE runner_id = ?', id);
      if (how === 'delete') {
        const ids = this.all('SELECT id FROM instances WHERE runner_id = ?', id).map((row) => text(row.id));
        this.run('DELETE FROM instances WHERE runner_id = ?', id);
        return ids;
      }
      const status = how === 'keep' ? 'orphaned' : 'lost';
      const ids = this.all("SELECT id FROM instances WHERE runner_id = ? AND status = 'active'", id).map((row) => text(row.id));
      this.run("UPDATE instances SET status = ?, updated_at = ? WHERE runner_id = ? AND status = 'active'", status, now, id);
      return ids;
    });
  }

  async putRunnerToken(hash: string, runnerId: string, expiresAt: number): Promise<void> {
    this.run('INSERT INTO runner_tokens (token_hash, runner_id, expires_at) VALUES (?, ?, ?)', hash, runnerId, expiresAt);
  }

  async runnerByToken(hash: string, now: number): Promise<Runner | null> {
    const r = this.one(
      `SELECT runners.* FROM runner_tokens JOIN runners ON runners.id = runner_tokens.runner_id
       WHERE runner_tokens.token_hash = ? AND runner_tokens.expires_at > ? AND runners.removed_at IS NULL`,
      hash,
      now,
    );
    return r ? toRunner(r) : null;
  }

  async useAssertionId(runnerId: string, jti: string, expiresAt: number, now: number): Promise<boolean> {
    return this.tx(() => {
      const seen = this.one('SELECT expires_at FROM assertion_ids WHERE runner_id = ? AND jti = ?', runnerId, jti);
      if (seen && num(seen.expires_at) > now) return false;
      this.run(
        `INSERT INTO assertion_ids (runner_id, jti, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(runner_id, jti) DO UPDATE SET expires_at = excluded.expires_at`,
        runnerId,
        jti,
        expiresAt,
      );
      return true;
    });
  }

  async sweep(now: number): Promise<void> {
    this.tx(() => {
      this.run('DELETE FROM sign_in_requests WHERE expires_at <= ?', now);
      this.run('DELETE FROM sign_in_codes WHERE expires_at <= ?', now);
      this.run('DELETE FROM runner_tokens WHERE expires_at <= ?', now);
      this.run('DELETE FROM assertion_ids WHERE expires_at <= ?', now);
      this.run('DELETE FROM enroll_tokens WHERE expires_at <= ?', now);
      this.run('DELETE FROM spent_refresh WHERE expires_at <= ?', now);
      this.run('DELETE FROM sessions WHERE refresh_expires_at <= ? OR revoked_at IS NOT NULL', now);
    });
  }

  async createInstance(i: Instance, repos: GrantRepo[]): Promise<'ok' | 'gone' | { full: number }> {
    return this.tx(() => {
      const runner = this.one('SELECT max_environments, removed_at FROM runners WHERE id = ?', i.runnerId);
      if (!runner || optNum(runner.removed_at) !== null) return 'gone';
      const cap = optNum(runner.max_environments);
      if (cap !== null) {
        const count = this.one("SELECT COUNT(*) AS n FROM instances WHERE runner_id = ? AND status = 'active'", i.runnerId) as Row;
        if (num(count.n) >= cap) return { full: cap };
      }
      this.run(
        `INSERT INTO instances (id, user_id, runner_id, definition, status, permissions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        i.id,
        i.userId,
        i.runnerId,
        i.definition,
        i.status,
        JSON.stringify(i.permissions),
        i.createdAt,
        i.updatedAt,
      );
      for (const repo of repos) this.insertRepo(repo);
      return 'ok';
    });
  }

  private insertRepo(r: GrantRepo): void {
    this.run(
      `INSERT INTO grant_repos (env_id, repo_id, owner, name, installation_id, verified_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      r.envId,
      r.repoId,
      r.owner,
      r.name,
      r.installationId,
      r.verifiedAt,
      r.revokedAt,
    );
  }

  async getInstance(id: string): Promise<Instance | null> {
    const r = this.one('SELECT * FROM instances WHERE id = ?', id);
    return r ? toInstance(r) : null;
  }

  async listInstances(userId: string): Promise<Instance[]> {
    return this.all('SELECT * FROM instances WHERE user_id = ? ORDER BY created_at', userId).map(toInstance);
  }

  async instancesOnRunner(runnerId: string): Promise<Instance[]> {
    return this.all('SELECT * FROM instances WHERE runner_id = ? ORDER BY created_at', runnerId).map(toInstance);
  }

  async setInstanceStatus(id: string, status: InstanceStatus, now: number): Promise<void> {
    this.run('UPDATE instances SET status = ?, updated_at = ? WHERE id = ?', status, now, id);
  }

  async replaceGrant(envId: string, repos: GrantRepo[], permissions: Instance['permissions'], now: number): Promise<void> {
    this.tx(() => {
      this.run('DELETE FROM grant_repos WHERE env_id = ?', envId);
      for (const repo of repos) this.insertRepo(repo);
      this.run('UPDATE instances SET permissions = ?, updated_at = ? WHERE id = ?', JSON.stringify(permissions), now, envId);
    });
  }

  async setPermissions(envId: string, permissions: Instance['permissions'], now: number): Promise<void> {
    this.run('UPDATE instances SET permissions = ?, updated_at = ? WHERE id = ?', JSON.stringify(permissions), now, envId);
  }

  async deleteInstance(id: string): Promise<void> {
    this.run('DELETE FROM instances WHERE id = ?', id);
  }

  async grantRepos(envId: string): Promise<GrantRepo[]> {
    return this.all('SELECT * FROM grant_repos WHERE env_id = ? ORDER BY owner, name', envId).map(toGrantRepo);
  }

  async markRepoVerified(envId: string, repoId: number, now: number): Promise<void> {
    this.run('UPDATE grant_repos SET verified_at = ? WHERE env_id = ? AND repo_id = ?', now, envId, repoId);
  }

  async revokeRepo(envId: string, repoId: number, now: number): Promise<void> {
    this.run('UPDATE grant_repos SET revoked_at = COALESCE(revoked_at, ?) WHERE env_id = ? AND repo_id = ?', now, envId, repoId);
  }

  async audit(e: AuditEvent): Promise<void> {
    this.run(
      'INSERT INTO audit (id, at, kind, user_id, runner_id, env_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      e.id,
      e.at,
      e.kind,
      e.userId,
      e.runnerId,
      e.envId,
      JSON.stringify(e.detail),
    );
  }

  async listAudit(userId: string, limit: number): Promise<AuditEvent[]> {
    return this.all('SELECT * FROM audit WHERE user_id = ? ORDER BY at DESC, rowid DESC LIMIT ?', userId, limit).map(toAudit);
  }
}
