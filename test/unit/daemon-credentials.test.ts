import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Credentials, normalizeGithub } from '../../src/daemon/credentials';
import { nullLogger } from '../../src/daemon/log';
import { exampleDefinition, fakeRunner, tempRoot } from './daemon-fakes';

let root: ReturnType<typeof tempRoot>;
beforeEach(() => {
  root = tempRoot();
  fs.mkdirSync(root.paths.inbox, { recursive: true });
});
afterEach(() => root.cleanup());

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
    inbox('github.json', JSON.stringify({ accessToken: 'ghu_abcdefghijk', refreshToken: 'ghr_abcdefgh', expiresAt: 99, login: 'octo' }));
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
    expect(JSON.parse(fs.readFileSync(github, 'utf8'))).toEqual({
      accessToken: 'ghu_abcdefghijk',
      refreshToken: 'ghr_abcdefgh',
      expiresAt: 99,
      refreshExpiresAt: null,
      login: 'octo',
      savedAt: 7,
    });
    expect(fs.statSync(github).mode & 0o777).toBe(0o600);
    expect(creds.envSecrets()).toEqual({ NPM_TOKEN: 's3cret' });
    expect(fs.readFileSync(path.join(root.paths.stagedCredentials, 'claude-code.json'), 'utf8')).toBe(claudeCred);
    expect(creds.githubAuth()).toEqual({ state: 'ok', login: 'octo' });
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

  it('accepts only a device-flow token pair with an expiry', () => {
    const pair = { accessToken: 'ghu_abcdefgh', refreshToken: 'ghr_abcdefgh', expiresAt: 99, refreshExpiresAt: 199, login: 'octo' };
    expect(normalizeGithub(pair, 1)).toEqual({ ...pair, savedAt: 1 });
    expect(normalizeGithub({ ...pair, refreshExpiresAt: undefined }, 1)).toMatchObject({ refreshExpiresAt: null });
    // A bare or non-expiring token (a personal token) is not an environment credential.
    expect(normalizeGithub('ghp_abcdefgh', 1)).toBeNull();
    expect(normalizeGithub({ accessToken: 'ghp_abcdefgh' }, 1)).toBeNull();
    expect(normalizeGithub({ ...pair, expiresAt: undefined }, 1)).toBeNull();
    expect(normalizeGithub({ ...pair, refreshToken: undefined }, 1)).toBeNull();
    expect(normalizeGithub({ ...pair, accessToken: 'has space x' }, 1)).toBeNull();
  });
});
