import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../mocks/electron';
import * as sessions from '../../src/main/session-registry';

const file = path.join(app.getPath('userData'), 'puck-resume.json');

beforeAll(() => {
  // Seed the on-disk map BEFORE the registry's lazy first load: one legacy
  // un-scoped key (pre-env-scoping format) and one scoped key.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ 'legacy-agent': 'legacy-resume', 'a1@e1': 'scoped-resume' }),
  );
});

const onDisk = (): Record<string, string> =>
  JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;

describe('session registry', () => {
  it('resolves scoped ids, falls back to legacy un-scoped ids', () => {
    expect(sessions.resumeIdFor('a1', 'e1')).toBe('scoped-resume');
    expect(sessions.resumeIdFor('legacy-agent', 'e1')).toBe('legacy-resume');
    expect(sessions.resumeIdFor('unknown', 'e1')).toBeNull();
  });

  it('remember() writes the scoped key and retires the legacy one', async () => {
    sessions.remember('legacy-agent', 'e1', 'fresh-id');
    expect(sessions.resumeIdFor('legacy-agent', 'e1')).toBe('fresh-id');
    await new Promise((r) => setTimeout(r, 20)); // atomic write settles
    const disk = onDisk();
    expect(disk['legacy-agent@e1']).toBe('fresh-id');
    expect(disk['legacy-agent']).toBeUndefined();
  });

  it('forget() drops both key forms', () => {
    sessions.remember('a2', 'e1', 'gone-soon');
    sessions.forget('a2', 'e1');
    expect(sessions.resumeIdFor('a2', 'e1')).toBeNull();
  });

  it('forgetEnvironment() purges that env scope plus legacy keys, leaves others', () => {
    sessions.remember('a3', 'e-dead', 'dead');
    sessions.remember('a3', 'e-alive', 'alive');
    sessions.forgetEnvironment('e-dead');
    expect(sessions.resumeIdFor('a3', 'e-dead')).toBeNull();
    expect(sessions.resumeIdFor('a3', 'e-alive')).toBe('alive');
  });

  it('recognizes provider stale-resume phrasings and nothing else', () => {
    for (const msg of [
      'No conversation found with session ID abc',
      'no rollout found for thread xyz',
      'thread 12345 not found',
      'error_during_execution',
      'session foo does not exist',
    ]) {
      expect(sessions.isStaleResumeError(msg), msg).toBe(true);
    }
    for (const msg of [
      'command failed with exit code 1',
      'Restart the environment from Settings to apply them.',
      'rate limit exceeded',
    ]) {
      expect(sessions.isStaleResumeError(msg), msg).toBe(false);
    }
  });
});
