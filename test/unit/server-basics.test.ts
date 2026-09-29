import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/server/clock';
import { compareVersions, ConfigError, loadConfig } from '../../src/server/config';
import { hashSecret, hasPrefix, newId, newSecret, ulid } from '../../src/server/ids';
import { createServerLog, redact } from '../../src/server/log';
import { SqliteStore } from '../../src/server/store';
import { seal, unseal } from '../../src/server/user-tokens';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'puck-server-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KEY = Buffer.alloc(32, 7).toString('base64');
const GITHUB = {
  PUCK_SERVER_TOKEN_KEY: KEY,
  PUCK_GITHUB_APP_ID: '1',
  PUCK_GITHUB_CLIENT_ID: 'Iv1.x',
  PUCK_GITHUB_CLIENT_SECRET: 's',
  PUCK_GITHUB_PRIVATE_KEY: 'not a key',
};

describe('loadConfig', () => {
  it('boots with nothing configured: loopback, port 8080, no GitHub', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ host: '127.0.0.1', port: 8080, publicUrl: 'http://localhost:8080', github: null, tokenKey: null });
  });

  it('reads the whole GitHub App, with secrets from files', () => {
    const d = tmp();
    writeFileSync(join(d, 'secret'), 'from-file\n');
    writeFileSync(join(d, 'key.pem'), '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
    const c = loadConfig({
      ...GITHUB,
      PUCK_GITHUB_CLIENT_SECRET: undefined,
      PUCK_GITHUB_PRIVATE_KEY: undefined,
      PUCK_GITHUB_CLIENT_SECRET_FILE: join(d, 'secret'),
      PUCK_GITHUB_PRIVATE_KEY_FILE: join(d, 'key.pem'),
      PUCK_SERVER_URL: 'https://puck.example.com/',
    });
    expect(c.github).toMatchObject({ clientSecret: 'from-file', apiUrl: 'https://api.github.com', webUrl: 'https://github.com' });
    expect(c.github?.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(c.publicUrl).toBe('https://puck.example.com');
  });

  it('accepts the private key base64-encoded on one line', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
    const c = loadConfig({ ...GITHUB, PUCK_GITHUB_PRIVATE_KEY: Buffer.from(pem).toString('base64') });
    expect(c.github?.privateKeyPem).toBe(pem);
    expect(() => loadConfig(GITHUB)).toThrow(/neither a PEM/);
  });

  it.each([
    [{ PUCK_GITHUB_APP_ID: '1' }, /incomplete/],
    [{ ...GITHUB, PUCK_SERVER_TOKEN_KEY: undefined }, /TOKEN_KEY is required/],
    [{ PUCK_SERVER_TOKEN_KEY: 'c2hvcnQ=' }, /32 bytes/],
    [{ PUCK_GITHUB_CLIENT_SECRET: 'a', PUCK_GITHUB_CLIENT_SECRET_FILE: '/x' }, /not both/],
    [{ PUCK_GITHUB_CLIENT_SECRET_FILE: '/nonexistent/puck' }, /cannot be read/],
    [{ PUCK_SERVER_URL: 'ftp://x' }, /http or https/],
    [{ PUCK_SERVER_PORT: 'eighty' }, /not a port/],
    [{ PUCK_RUNNER_MIN_VERSION: '1.2' }, /MAJOR.MINOR.PATCH/],
    [{ PUCK_DEVELOPMENT: 'yes' }, /true or false/],
    [{ PUCK_RUNNER_DOWNLOADS: '/srv/runners' }, /only a development server/],
    [{ PUCK_RUNNER_DOWNLOADS: '/srv/runners', PUCK_DEVELOPMENT: 'false' }, /only a development server/],
  ])('refuses %j', (env, message) => {
    expect(() => loadConfig(env as Record<string, string>)).toThrow(ConfigError);
    expect(() => loadConfig(env as Record<string, string>)).toThrow(message);
  });

  it('hosts runner downloads only in development mode', () => {
    expect(loadConfig({})).toMatchObject({ development: false, runnerDownloads: null });
    expect(loadConfig({ PUCK_DEVELOPMENT: 'false' })).toMatchObject({ development: false, runnerDownloads: null });
    expect(loadConfig({ PUCK_DEVELOPMENT: 'true' })).toMatchObject({ development: true, runnerDownloads: null });
    expect(loadConfig({ PUCK_DEVELOPMENT: 'true', PUCK_RUNNER_DOWNLOADS: '/srv/runners' })).toMatchObject({
      development: true,
      runnerDownloads: '/srv/runners',
    });
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
  });
});

describe('ids and secrets', () => {
  it('makes time-ordered prefixed ids', () => {
    const a = newId('rnr', 1_000);
    const b = newId('rnr', 2_000);
    expect(a).toMatch(/^rnr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(4, 14) < b.slice(4, 14)).toBe(true);
    expect(ulid(0).slice(0, 10)).toBe('0000000000');
  });

  it('makes base62 secrets whose kind is checked by prefix', () => {
    const t = newSecret('PRT');
    expect(hasPrefix(t, 'PRT')).toBe(true);
    expect(hasPrefix(t, 'PRR')).toBe(false);
    expect(hasPrefix('PRT_short', 'PRT')).toBe(false);
    expect(newSecret('PRT')).not.toBe(t);
    expect(hashSecret(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('FakeClock', () => {
  it('runs due jobs in order as time advances', () => {
    const clock = new FakeClock(0);
    const seen: string[] = [];
    const stop = clock.every(10, () => seen.push(`a${clock.now()}`));
    clock.every(15, () => seen.push(`b${clock.now()}`));
    clock.advance(30);
    expect(seen).toEqual(['a10', 'b15', 'a20', 'a30', 'b30']);
    stop();
    clock.advance(10);
    expect(seen.at(-1)).toBe('b30');
    expect(clock.now()).toBe(40);
  });
});

describe('server log', () => {
  it('writes JSON lines and scrubs token shapes', () => {
    const lines: string[] = [];
    const log = createServerLog((l) => lines.push(l), () => 0);
    log.info('minted', { token: 'ghs_abcdefghijklmnop', puck: newSecret('PSA'), auth: 'Bearer abc.def' });
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ level: 'info', msg: 'minted', t: '1970-01-01T00:00:00.000Z' });
    expect(lines[0]).not.toMatch(/ghs_abc|PSA_|Bearer abc/);
  });

  it('redacts PEM blocks and JWTs', () => {
    expect(redact('-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----')).toBe('[redacted-key]');
    expect(redact('eyJhbGciOiJ.eyJpc3MiOiIx.c2lnbmF0dXJl')).toBe('[redacted-jwt]');
  });
});

describe('sealed GitHub tokens', () => {
  const tokens = { accessToken: 'ghu_x', expiresAt: 1, refreshToken: 'ghr_y', refreshExpiresAt: 2 };

  it('open only under the same key and user', () => {
    const key = Buffer.alloc(32, 1);
    const blob = seal(key, 'usr_a', tokens);
    expect(unseal(key, 'usr_a', blob)).toEqual(tokens);
    expect(unseal(key, 'usr_b', blob)).toBeNull();
    expect(unseal(Buffer.alloc(32, 2), 'usr_a', blob)).toBeNull();
    expect(blob.toString('latin1')).not.toContain('ghr_y');
  });
});

describe('SqliteStore', () => {
  it('migrates once and keeps data across reopen', async () => {
    const path = join(tmp(), 'puck.db');
    const a = new SqliteStore(path);
    const user = await a.upsertUser(42, 'namik', 'usr_1', 1);
    await a.close();
    const b = new SqliteStore(path);
    expect(await b.getUser(user.id)).toMatchObject({ githubId: 42, login: 'namik' });
    // Upsert by GitHub id keeps the Puck id and follows a login rename.
    expect(await b.upsertUser(42, 'renamed', 'usr_2', 2)).toMatchObject({ id: 'usr_1', login: 'renamed' });
    await b.close();
  });

  it('remembers assertion ids until they expire', async () => {
    const s = new SqliteStore(':memory:');
    expect(await s.useAssertionId('rnr_1', 'j', 100, 0)).toBe(true);
    expect(await s.useAssertionId('rnr_1', 'j', 100, 50)).toBe(false);
    expect(await s.useAssertionId('rnr_2', 'j', 100, 50)).toBe(true);
    await s.sweep(100);
    expect(await s.useAssertionId('rnr_1', 'j', 300, 150)).toBe(true);
    await s.close();
  });

  it('sweeps expired sign-in state and dead sessions', async () => {
    const s = new SqliteStore(':memory:');
    await s.upsertUser(1, 'u', 'usr_1', 0);
    await s.putSignInRequest('h', { redirectUri: 'r', codeChallenge: 'c', appState: 'a', expiresAt: 10 });
    await s.createSession({ id: 'ses_1', userId: 'usr_1', accessExpiresAt: 5, refreshExpiresAt: 20, createdAt: 0, revokedAt: null }, 'ah', 'rh');
    await s.sweep(10);
    expect(await s.takeSignInRequest('h')).toBeNull();
    expect(await s.sessionByAccess('ah')).not.toBeNull();
    await s.sweep(20);
    expect(await s.sessionByAccess('ah')).toBeNull();
    await s.close();
  });
});
