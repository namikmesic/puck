import { describe, expect, it } from 'vitest';
import {
  agentConfigFrom,
  askAnswersFrom,
  envConfigFrom,
  objArgs,
  appliedPinFrom,
  pinFrom,
  repoNameFrom,
  requireId,
  requireSecretKey,
  requireString,
  daemonCallFrom,
  enrollTokenIdFrom,
  instanceIdFrom,
  runnerIdFrom,
  runnerPatchFrom,
  startSpecFrom,
} from '../../src/main/ipcguard';

describe('requireId', () => {
  it('accepts ids we mint', () => {
    expect(requireId('claude-default', 'agent')).toBe('claude-default');
    expect(requireId('msujajyg', 'environment')).toBe('msujajyg');
  });
  it('rejects traversal and junk', () => {
    expect(() => requireId('../../etc/passwd', 'environment')).toThrow();
    expect(() => requireId('', 'agent')).toThrow();
    expect(() => requireId(42, 'agent')).toThrow();
    expect(() => requireId('UPPER', 'agent')).toThrow();
  });
});

describe('envConfigFrom', () => {
  it('rejects docker-flag injection in image and workspace', () => {
    expect(() => envConfigFrom({ image: '--privileged' })).toThrow();
    expect(() => envConfigFrom({ image: 'node:22', workspacePath: '--pid=host' })).toThrow();
  });
  it('filters invalid env var keys', () => {
    const cfg = envConfigFrom({
      image: 'node:22',
      envVars: { GOOD_KEY: 'v', 'bad key': 'x', 'ALSO-BAD': 'y' },
    });
    expect(cfg.envVars).toEqual({ GOOD_KEY: 'v' });
  });
  it('throws on non-object payloads', () => {
    expect(() => envConfigFrom(null)).toThrow();
    expect(() => envConfigFrom('x')).toThrow();
  });
});

describe('agentConfigFrom', () => {
  it('coerces missing fields to safe defaults', () => {
    const cfg = agentConfigFrom({ name: 'A', provider: 'codex' });
    expect(cfg.model).toBe('auto');
    expect(cfg.systemPrompt).toBe('');
    expect(cfg.options).toEqual({});
  });

  it('passes object options through and defaults garbage to {}', () => {
    expect(agentConfigFrom({ options: { maxTurns: 3 } }).options).toEqual({ maxTurns: 3 });
    expect(agentConfigFrom({ options: [1, 2] }).options).toEqual({});
    expect(agentConfigFrom({ options: 'x' }).options).toEqual({});
    expect(agentConfigFrom({ options: null }).options).toEqual({});
  });
});

describe('requireSecretKey', () => {
  it('accepts env-var-shaped keys and rejects everything else', () => {
    expect(requireSecretKey('API_KEY')).toBe('API_KEY');
    expect(requireSecretKey('_x9')).toBe('_x9');
    expect(() => requireSecretKey('9lives')).toThrow();
    expect(() => requireSecretKey('BAD-KEY')).toThrow();
    expect(() => requireSecretKey('')).toThrow();
    expect(() => requireSecretKey(42)).toThrow();
  });
});

describe('objArgs', () => {
  it('passes plain objects through and rejects everything else', () => {
    expect(objArgs({ id: 'a' })).toEqual({ id: 'a' });
    expect(() => objArgs(null)).toThrow();
    expect(() => objArgs([])).toThrow();
    expect(() => objArgs('x')).toThrow();
    expect(() => objArgs(undefined)).toThrow();
  });
});

describe('requireString', () => {
  it('accepts any string (including empty) and rejects non-strings', () => {
    expect(requireString('ipc-1', 'turn id')).toBe('ipc-1');
    expect(requireString('', 'prompt')).toBe('');
    expect(() => requireString(7, 'turn id')).toThrow(/turn id/);
    expect(() => requireString(undefined, 'prompt')).toThrow(/prompt/);
  });
});

describe('askAnswersFrom', () => {
  it('passes null (dismissed) and string records; rejects the rest', () => {
    expect(askAnswersFrom(null)).toBeNull();
    expect(askAnswersFrom(undefined)).toBeNull();
    expect(askAnswersFrom({ 'Which one?': 'A' })).toEqual({ 'Which one?': 'A' });
    expect(() => askAnswersFrom({ q: 42 })).toThrow();
    expect(() => askAnswersFrom([])).toThrow();
    expect(() => askAnswersFrom('yes')).toThrow();
  });
});

describe('runner and environment ids', () => {
  const ulid = '01J8Z3X0000000000000000000';
  it('accepts the ids the Puck server mints', () => {
    expect(runnerIdFrom(`rnr_${ulid}`)).toBe(`rnr_${ulid}`);
    expect(instanceIdFrom(`env_${ulid}`)).toBe(`env_${ulid}`);
    expect(enrollTokenIdFrom(`reg_${ulid}`)).toBe(`reg_${ulid}`);
  });
  it('rejects other prefixes, lowercase, traversal and junk', () => {
    for (const bad of [`env_${ulid}`, `rnr_${ulid.toLowerCase()}`, '../etc', `rnr_${ulid}x`, 42, null]) {
      expect(() => runnerIdFrom(bad), String(bad)).toThrow(/Invalid runner id/);
    }
    expect(() => instanceIdFrom(`rnr_${ulid}`)).toThrow(/Invalid environment id/);
    expect(() => enrollTokenIdFrom('PRT_secret')).toThrow(/Invalid token id/);
  });
});

describe('runnerPatchFrom', () => {
  it('trims names and normalizes labels', () => {
    expect(runnerPatchFrom({ name: ' build-box (2) ' })).toEqual({ name: 'build-box (2)' });
    expect(runnerPatchFrom({ labels: ['GPU', ' gpu', 'x:y'] })).toEqual({ labels: ['gpu', 'x:y'] });
    expect(runnerPatchFrom({ labels: [] })).toEqual({ labels: [] });
  });
  it('rejects bad names and labels, and an empty patch', () => {
    expect(() => runnerPatchFrom({ name: '-flag' })).toThrow(/runner name/);
    expect(() => runnerPatchFrom({ name: 'x'.repeat(65) })).toThrow(/runner name/);
    expect(() => runnerPatchFrom({ labels: ['has space'] })).toThrow(/Label/);
    expect(() => runnerPatchFrom({ labels: Array.from({ length: 17 }, (_, i) => `l${i}`) })).toThrow(/at most 16/);
    expect(() => runnerPatchFrom({})).toThrow(/Nothing to change/);
  });
});

describe('startSpecFrom', () => {
  const ok = { pin: { kind: 'tag', name: 'v1.0.0' }, definition: 'example', runnerId: 'rnr_01J8Z3X0000000000000000000', secrets: { API_KEY: 'v' } };
  it('accepts a pin, a definition, a runner and secret values', () => {
    expect(startSpecFrom(ok)).toEqual(ok);
    expect(startSpecFrom({ ...ok, secrets: undefined }).secrets).toEqual({});
  });
  it('rejects bad definitions, runners and secret names', () => {
    expect(() => startSpecFrom({ ...ok, definition: '../x' })).toThrow(/definition name/);
    expect(() => startSpecFrom({ ...ok, runnerId: 'local' })).toThrow(/Invalid runner id/);
    expect(() => startSpecFrom({ ...ok, secrets: { PUCK_TOKEN: 'x' } })).toThrow(/Secret names/);
    expect(() => startSpecFrom({ ...ok, pin: { kind: 'tag', name: '..' } })).toThrow();
  });
});

describe('daemonCallFrom', () => {
  const envId = 'env_01J8Z3X0000000000000000000';
  it('passes allowlisted renderer ops', () => {
    expect(daemonCallFrom({ envId, op: 'chat.send', args: { text: 'hi' } })).toEqual({ envId, op: 'chat.send', args: { text: 'hi' } });
    expect(daemonCallFrom({ envId, op: 'item.create', args: { title: 't' } }).op).toBe('item.create');
  });
  it('refuses credential, secret, GitHub, definition and upgrade ops from the renderer', () => {
    for (const op of ['credentials.put', 'credentials.get', 'github.put', 'secrets.put', 'definition.apply', 'daemon.upgrade', 'nope']) {
      expect(() => daemonCallFrom({ envId, op, args: {} }), op).toThrow(/not allowed/);
    }
    expect(() => daemonCallFrom({ envId: 'env_x', op: 'chat.send' })).toThrow(/Invalid environment id/);
  });
});

describe('repoNameFrom', () => {
  it('accepts owner/name', () => {
    expect(repoNameFrom('octo-org/puck-config')).toBe('octo-org/puck-config');
    expect(repoNameFrom('me/cfg.repo_1')).toBe('me/cfg.repo_1');
  });
  it('rejects anything else', () => {
    for (const bad of ['cfg', 'a/b/c', '../etc', 'me/', '/cfg', 'me/cfg repo', 'me_x/cfg', 42, null]) {
      expect(() => repoNameFrom(bad), String(bad)).toThrow(/Invalid repository name/);
    }
  });
});

describe('pinFrom', () => {
  it('accepts tags, branches and commit SHAs', () => {
    expect(pinFrom({ kind: 'tag', name: 'v1.2.3' })).toEqual({ kind: 'tag', name: 'v1.2.3' });
    expect(pinFrom({ kind: 'branch', name: 'release/1.x', extra: 1 })).toEqual({ kind: 'branch', name: 'release/1.x' });
    expect(pinFrom({ kind: 'commit', name: 'abc1234' })).toEqual({ kind: 'commit', name: 'abc1234' });
    expect(pinFrom({ kind: 'commit', name: 'f'.repeat(40) })).toEqual({ kind: 'commit', name: 'f'.repeat(40) });
  });

  it('rejects bad kinds, ref names that could smuggle paths or flags, and non-SHAs', () => {
    for (const bad of [
      null,
      'v1.0.0',
      { kind: 'ref', name: 'main' },
      { kind: 'tag', name: '' },
      { kind: 'tag', name: '../x' },
      { kind: 'branch', name: '-x' },
      { kind: 'branch', name: 'a b' },
      { kind: 'commit', name: 'abc' },
      { kind: 'commit', name: 'g'.repeat(40) },
      { kind: 'commit', name: 'a'.repeat(41) },
    ]) {
      expect(() => pinFrom(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe('appliedPinFrom', () => {
  const sha = 'b'.repeat(40);

  it('keeps the tag or branch together with the commit the check diffed', () => {
    expect(appliedPinFrom({ kind: 'branch', name: 'release/1', sha: sha.toUpperCase() })).toEqual({ kind: 'branch', name: 'release/1', sha });
    expect(appliedPinFrom({ kind: 'tag', name: 'v1.1.0', sha })).toEqual({ kind: 'tag', name: 'v1.1.0', sha });
  });

  it('rejects a pin that has no full commit, so a branch is not applied by name', () => {
    expect(() => appliedPinFrom({ kind: 'branch', name: 'main' })).toThrow(/commit SHA/);
    expect(() => appliedPinFrom({ kind: 'tag', name: 'v1', sha: 'abc1234' })).toThrow(/commit SHA/);
  });
});
