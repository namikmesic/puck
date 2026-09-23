import { describe, expect, it } from 'vitest';
import {
  agentConfigFrom,
  askAnswersFrom,
  envConfigFrom,
  objArgs,
  requireId,
  requireSecretKey,
  requireString,
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

