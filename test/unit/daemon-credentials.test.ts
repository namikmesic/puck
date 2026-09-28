import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Credentials, EXPIRING_WITHIN_MS, githubAuthOf, normalizeGithub } from '../../src/daemon/credentials';
import { nullLogger } from '../../src/daemon/log';
import { exampleDefinition, fakeRunner, tempRoot } from './daemon-fakes';

let root: ReturnType<typeof tempRoot>;
beforeEach(() => {
  root = tempRoot();
  fs.mkdirSync(root.paths.inbox, { recursive: true });
});
afterEach(() => root.cleanup());

const grant = { owner: 'octo', installationId: 42, repos: ['octo/app'], token: 'ghs_abcdefghijk', expiresAt: 99 * 60_000 };
const claudeCred = JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } });

describe('credential ingest', () => {
  it('ingests every known inbox file into place and deletes the inbox copy', () => {
    const { run } = fakeRunner();
    const creds = new Credentials({ paths: root.paths, log: nullLogger, run, asPuck: {}, now: () => 7 });
    const inbox = (name: string, body: string) => fs.writeFileSync(path.join(root.paths.inbox, name), body);
    inbox(
      'instance.json',
      JSON.stringify({ envId: 'env_01J0000000000000000000000A', name: 'Example', pin: { kind: 'tag', name: 'v1', sha: 'abc1234' }, definition: exampleDefinition() }),
    );
    inbox('github.json', JSON.stringify({ grants: [grant] }));
    inbox('secrets.json', JSON.stringify({ values: { NPM_TOKEN: 's3cret' } }));
    inbox('harness-claude-code.json', claudeCred);
    inbox('harness-gemini.json', '{}');
    inbox('notes.txt', 'hello');
    const applied: unknown[] = [];
    const report = creds.ingestInbox((u) => applied.push(u));
    expect(report.ingested.sort()).toEqual(['github.json', 'harness-claude-code.json', 'instance.json', 'secrets.json']);
    expect(report.rejected.sort()).toEqual(['harness-gemini.json', 'notes.txt']);
    expect(fs.readdirSync(root.paths.inbox).sort()).toEqual(['harness-gemini.json.rejected', 'notes.txt.rejected']);
    expect(applied).toEqual([
      expect.objectContaining({ envId: 'env_01J0000000000000000000000A', name: 'Example', sha: 'abc1234', pin: { kind: 'tag', name: 'v1', sha: 'abc1234' } }),
    ]);
    const github = path.join(root.paths.secrets, 'github.json');
    expect(JSON.parse(fs.readFileSync(github, 'utf8'))).toEqual({ grants: [grant], savedAt: 7 });
    expect(fs.statSync(github).mode & 0o777).toBe(0o600);
    expect(creds.envSecrets()).toEqual({ NPM_TOKEN: 's3cret' });
    expect(fs.readFileSync(path.join(root.paths.stagedCredentials, 'claude-code.json'), 'utf8')).toBe(claudeCred);
    expect(creds.githubAuth()).toEqual({ state: 'ok', expiresAt: grant.expiresAt });
    expect(creds.grantFor('OCTO')?.token).toBe('ghs_abcdefghijk');
    expect(creds.grantFor('acme')).toBeNull();
  });

  it('rejects an instance file with an invalid definition', () => {
    const creds = new Credentials({ paths: root.paths, log: nullLogger, run: fakeRunner().run, asPuck: {} });
    fs.writeFileSync(path.join(root.paths.inbox, 'instance.json'), JSON.stringify({ envId: 'env_1', definition: { name: 'x' } }));
    expect(creds.ingestInbox(() => undefined).rejected).toEqual(['instance.json']);
  });

  it('writes and reads harness credential files as the puck user, content over stdin only', async () => {
    const { run, calls } = fakeRunner((argv) =>
      argv[0] === 'cat' ? (argv[2].includes('.claude') ? { stdout: claudeCred } : { code: 1, stderr: 'No such file' }) : undefined,
    );
    const creds = new Credentials({ paths: root.paths, log: nullLogger, run, asPuck: { uid: 10001, gid: 10001 } });
    await creds.putHarness('claude-code', claudeCred, true);
    const write = calls[0];
    expect(write.opts).toMatchObject({ uid: 10001, gid: 10001, input: claudeCred });
    expect(write.argv.join(' ')).not.toContain('accessToken');
    expect(write.argv.slice(-3)).toEqual([
      path.join(root.paths.home, '.claude'),
      path.join(root.paths.home, '.claude', '.credentials.json.puckd.tmp'),
      path.join(root.paths.home, '.claude', '.credentials.json'),
    ]);
    expect(await creds.getHarness(['claude-code', 'codex'])).toEqual([{ id: 'claude-code', content: claudeCred }]);
    expect(calls.slice(1).map((c) => [c.argv, c.opts.uid])).toEqual([
      [['cat', '--', path.join(root.paths.home, '.claude', '.credentials.json')], 10001],
      [['cat', '--', path.join(root.paths.home, '.codex', 'auth.json')], 10001],
    ]);
    await expect(creds.putHarness('claude-code', 'not json', true)).rejects.toThrow(/Invalid credential/);
  });

  it('stages credentials until HOME exists, then writes them once', async () => {
    const { run, calls } = fakeRunner();
    const creds = new Credentials({ paths: root.paths, log: nullLogger, run, asPuck: {} });
    await creds.putHarness('codex', '{"tokens":{}}', false);
    expect(calls).toHaveLength(0);
    expect(await creds.writeStaged()).toEqual(['codex']);
    expect(await creds.writeStaged()).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('removes a harness credential file as the puck user, and a staged copy with it', async () => {
    const { run, calls } = fakeRunner();
    const creds = new Credentials({ paths: root.paths, log: nullLogger, run, asPuck: { uid: 10001, gid: 10001 } });
    await creds.putHarness('codex', '{"tokens":{}}', false);
    await creds.removeHarness('codex');
    expect(fs.existsSync(path.join(root.paths.stagedCredentials, 'codex.json'))).toBe(false);
    expect(calls.map((c) => [c.argv, c.opts.uid])).toEqual([[['rm', '-f', '--', path.join(root.paths.home, '.codex', 'auth.json')], 10001]]);
    expect(await creds.writeStaged()).toEqual([]);
    await expect(creds.removeHarness('gemini')).rejects.toThrow(/Unknown harness/);
  });

  it('accepts only installation token grants with an expiry, one per owner', () => {
    expect(normalizeGithub({ grants: [grant] }, 1)).toEqual({ grants: [grant], savedAt: 1 });
    expect(normalizeGithub([grant], 1)).toEqual({ grants: [grant], savedAt: 1 });
    const other = { ...grant, owner: 'acme', installationId: 7, repos: ['acme/api', 'acme/web'] };
    expect(normalizeGithub({ grants: [grant, other] }, 1)?.grants).toHaveLength(2);
    // The stateless installation-token format is far longer than 40 characters.
    const stateless = `ghs_424242_${'e'.repeat(36)}.${'p'.repeat(400)}.${'s'.repeat(86)}`;
    expect(normalizeGithub({ grants: [{ ...grant, token: stateless }] }, 1)).not.toBeNull();
    // A refreshable user-token pair or a bare token is not an environment credential.
    expect(normalizeGithub({ accessToken: 'ghu_abcdefgh', refreshToken: 'ghr_abcdefgh', expiresAt: 99 }, 1)).toBeNull();
    expect(normalizeGithub('ghp_abcdefgh', 1)).toBeNull();
    expect(normalizeGithub({ grants: [] }, 1)).toBeNull();
    expect(normalizeGithub({ grants: [{ ...grant, expiresAt: undefined }] }, 1)).toBeNull();
    expect(normalizeGithub({ grants: [{ ...grant, token: 'has space x' }] }, 1)).toBeNull();
    expect(normalizeGithub({ grants: [{ ...grant, owner: '-bad' }] }, 1)).toBeNull();
    expect(normalizeGithub({ grants: [{ ...grant, repos: ['../etc'] }] }, 1)).toBeNull();
    expect(normalizeGithub({ grants: [{ ...grant, installationId: 0 }] }, 1)).toBeNull();
    // Every repository belongs to the grant's owner, and an owner has one grant.
    expect(normalizeGithub({ grants: [{ ...grant, repos: ['acme/api'] }] }, 1)).toBeNull();
    expect(normalizeGithub({ grants: [grant, { ...grant, owner: 'OCTO', repos: ['OCTO/x'] }] }, 1)).toBeNull();
  });

  it('reads the state from the earliest grant: ok, expiring under ten minutes, missing once all expired', () => {
    const at = (min: number) => min * 60_000;
    const cred = { grants: [{ ...grant, expiresAt: at(60) }, { ...grant, owner: 'acme', repos: ['acme/api'], expiresAt: at(30) }], savedAt: 0 };
    expect(githubAuthOf(null, 0)).toEqual({ state: 'missing' });
    expect(githubAuthOf(cred, at(0))).toEqual({ state: 'ok', expiresAt: at(30) });
    expect(githubAuthOf(cred, at(21))).toEqual({ state: 'expiring', expiresAt: at(30) });
    // One installation's token lapsed: the environment is short of access.
    expect(githubAuthOf(cred, at(31))).toEqual({ state: 'expiring', expiresAt: at(30) });
    expect(githubAuthOf(cred, at(61))).toEqual({ state: 'missing', expiresAt: at(30) });
  });

  it('reports expiring when any stored grant has under ten minutes left', () => {
    let now = 1_000;
    const creds = new Credentials({ paths: root.paths, log: nullLogger, run: fakeRunner().run, asPuck: {}, now: () => now });
    expect(creds.githubAuth()).toEqual({ state: 'missing' });
    const soon = now + EXPIRING_WITHIN_MS + 5;
    const other = { ...grant, owner: 'acme', repos: ['acme/web'], expiresAt: soon };
    expect(creds.putGithub({ grants: [{ ...grant, expiresAt: now + 3_600_000 }, other] })).toBe(true);
    expect(creds.githubAuth()).toEqual({ state: 'ok', expiresAt: soon });
    expect(creds.grantFor('acme')?.token).toBe(grant.token);
    now += 10;
    expect(creds.githubAuth()).toEqual({ state: 'expiring', expiresAt: soon });
  });
});
