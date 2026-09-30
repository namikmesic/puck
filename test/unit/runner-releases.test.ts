import { describe, expect, it } from 'vitest';
import {
  checkSha256Sums,
  formatRunnerRelease,
  formatSha256Sums,
  formatVersionProbe,
  isReleaseVersion,
  isRunnerTrustMode,
  readRunnerRelease,
  readSha256Sums,
  readVersionProbe,
  RUNNER_TARGETS,
  runnerPackageFile,
  RunnerReleaseError,
  selectRunnerAsset,
  type RunnerReleaseErrorCode,
  type RunnerReleaseManifest,
} from '../../src/harness/runner-releases';

// The pure half of the signed runner-release format: shape checks that run
// only after a signature verified (test/unit/runner-release-verify.test.ts).

const VERSION = '1.2.3';

function manifest(overrides: Record<string, unknown> = {}): RunnerReleaseManifest {
  return {
    schemaVersion: 1,
    product: 'puck-runner',
    publisher: 'namikmesic/puck',
    version: VERSION,
    sourceCommit: 'a'.repeat(40),
    runnerProtocol: 1,
    signingKeyId: 'b'.repeat(64),
    sha256sumsSha256: 'c'.repeat(64),
    assets: RUNNER_TARGETS.map((t, i) => ({ os: t.os, arch: t.arch, file: runnerPackageFile(t, VERSION), sha256: String(i + 1).repeat(64), size: 1000 + i })),
    ...overrides,
  } as RunnerReleaseManifest;
}

const text = (value: unknown): string => JSON.stringify(value);
const withAsset = (i: number, change: Record<string, unknown>) => {
  const m = manifest();
  return { ...m, assets: m.assets.map((a, j) => (j === i ? { ...a, ...change } : a)) };
};

function failure(fn: () => unknown): { code: RunnerReleaseErrorCode; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof RunnerReleaseError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('expected a RunnerReleaseError');
}

describe('runner-release manifest', () => {
  it('reads what the packager formats, with a fixed key order and a final newline', () => {
    const m = manifest();
    const formatted = formatRunnerRelease(m);
    expect(readRunnerRelease(formatted)).toEqual(m);
    expect(formatted.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(formatted))).toEqual([
      'schemaVersion',
      'product',
      'publisher',
      'version',
      'sourceCommit',
      'runnerProtocol',
      'signingKeyId',
      'sha256sumsSha256',
      'assets',
    ]);
    expect(Object.keys(JSON.parse(formatted).assets[0])).toEqual(['os', 'arch', 'file', 'sha256', 'size']);
  });

  it('names the three supported packages exactly as the packager does', () => {
    expect(RUNNER_TARGETS.map((t) => runnerPackageFile(t, '0.1.0'))).toEqual([
      'puck-runner-linux-x64-0.1.0.tar.gz',
      'puck-runner-linux-arm64-0.1.0.tar.gz',
      'puck-runner-macos-arm64-0.1.0.tar.gz',
    ]);
  });

  it('refuses text that is not a JSON object', () => {
    for (const bad of ['', 'not json', '[]', 'null', '"x"', '{"schemaVersion":1,}']) {
      expect(failure(() => readRunnerRelease(bad)).code).toBe('malformed');
    }
  });

  it('refuses another schema, product or publisher', () => {
    expect(failure(() => readRunnerRelease(text(manifest({ schemaVersion: 2 })))).code).toBe('unsupported-schema');
    expect(failure(() => readRunnerRelease(text(manifest({ schemaVersion: '1' })))).code).toBe('unsupported-schema');
    expect(failure(() => readRunnerRelease(text(manifest({ product: 'puck-server' })))).code).toBe('wrong-product');
    expect(failure(() => readRunnerRelease(text(manifest({ publisher: 'someone/puck' })))).code).toBe('wrong-publisher');
    expect(failure(() => readRunnerRelease(text(manifest({ publisher: 'NamikMesic/puck' })))).code).toBe('wrong-publisher');
  });

  it('refuses unexpected and missing fields', () => {
    expect(failure(() => readRunnerRelease(text(manifest({ channel: 'beta' })))).message).toMatch(/unexpected field "channel"/);
    const partial: Record<string, unknown> = { ...manifest() };
    delete partial.sourceCommit;
    expect(failure(() => readRunnerRelease(text(partial))).message).toMatch(/lacks "sourceCommit"/);
    expect(failure(() => readRunnerRelease(text(withAsset(0, { url: 'https://example.com/x' })))).message).toMatch(/unexpected field "url"/);
  });

  it('takes only canonical numeric versions', () => {
    for (const good of ['0.0.0', '1.2.3', '10.20.30', `${Number.MAX_SAFE_INTEGER}.0.0`]) expect(isReleaseVersion(good)).toBe(true);
    for (const bad of ['1.2', '1.2.3.4', '01.2.3', '1.02.3', 'v1.2.3', '1.2.3-beta', '1.2.3+build', ' 1.2.3', '-1.2.3', '9007199254740992.0.0', 1, null]) {
      expect(isReleaseVersion(bad)).toBe(false);
    }
    const version = '1.2.3-rc1';
    const m = manifest({ version });
    expect(failure(() => readRunnerRelease(text({ ...m, assets: m.assets.map((a) => ({ ...a, file: a.file.replace(VERSION, version) })) }))).message).toMatch(/version/);
  });

  it('checks the commit, protocol, key id and sums digest formats', () => {
    for (const bad of [
      { sourceCommit: 'A'.repeat(40) },
      { sourceCommit: 'a'.repeat(39) },
      { runnerProtocol: 0 },
      { runnerProtocol: 1.5 },
      { runnerProtocol: '1' },
      { signingKeyId: 'B'.repeat(64) },
      { signingKeyId: 'b'.repeat(63) },
      { sha256sumsSha256: 'z'.repeat(64) },
    ]) {
      expect(failure(() => readRunnerRelease(text(manifest(bad)))).code).toBe('malformed');
    }
  });

  it('requires each of the three targets exactly once', () => {
    const m = manifest();
    expect(failure(() => readRunnerRelease(text({ ...m, assets: m.assets.slice(0, 2) })))).toEqual({
      code: 'missing-target',
      message: 'runner-release.json has no macos-arm64 package.',
    });
    expect(failure(() => readRunnerRelease(text({ ...m, assets: [] }))).code).toBe('missing-target');
    expect(failure(() => readRunnerRelease(text({ ...m, assets: [...m.assets, m.assets[1]] }))).message).toMatch(/linux-arm64 more than once/);
    expect(failure(() => readRunnerRelease(text({ ...m, assets: [m.assets[0], m.assets[0], m.assets[2]] }))).message).toMatch(/linux-x64 more than once/);
    expect(failure(() => readRunnerRelease(text({ ...m, assets: {} }))).code).toBe('malformed');
    const windows = { os: 'windows', arch: 'x64', file: 'puck-runner-windows-x64-1.2.3.tar.gz', sha256: 'd'.repeat(64), size: 1 };
    expect(failure(() => readRunnerRelease(text({ ...m, assets: [...m.assets, windows] }))).message).toMatch(/unsupported target "windows-x64"/);
    expect(failure(() => readRunnerRelease(text(withAsset(2, { arch: 'x64' })))).message).toMatch(/unsupported target "macos-x64"/);
  });

  it('requires each package file name to match its target and the version', () => {
    for (const file of ['puck-runner-linux-x64-1.2.4.tar.gz', 'puck-runner-linux-arm64-1.2.3.tar.gz', '../puck-runner-linux-x64-1.2.3.tar.gz', 'puck-runner-linux-x64-1.2.3.tgz']) {
      expect(failure(() => readRunnerRelease(text(withAsset(0, { file })))).message).toMatch(/The linux-x64 asset is/);
    }
  });

  it('requires a lowercase sha256 and a positive safe-integer size', () => {
    expect(failure(() => readRunnerRelease(text(withAsset(1, { sha256: 'A'.repeat(64) })))).message).toMatch(/sha256/);
    for (const size of [0, -1, 1.5, 2 ** 53, '100', null]) {
      expect(failure(() => readRunnerRelease(text(withAsset(1, { size })))).message).toMatch(/size must be a positive whole number/);
    }
    expect(readRunnerRelease(text(withAsset(1, { size: Number.MAX_SAFE_INTEGER }))).assets[1].size).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('selectRunnerAsset', () => {
  it('returns the selected platform of the selected version', () => {
    expect(selectRunnerAsset(manifest(), { version: VERSION, os: 'macos', arch: 'arm64' })).toEqual(manifest().assets[2]);
  });

  it('refuses a manifest of another version', () => {
    expect(failure(() => selectRunnerAsset(manifest(), { version: '1.2.4', os: 'linux', arch: 'x64' })).code).toBe('version-mismatch');
  });

  it('refuses a platform the release does not carry', () => {
    expect(failure(() => selectRunnerAsset(manifest(), { version: VERSION, os: 'macos', arch: 'x64' }))).toEqual({
      code: 'missing-target',
      message: 'Runner 1.2.3 has no package for macos-x64.',
    });
  });

  it('refuses a package whose file name does not match the selection', () => {
    const m = withAsset(0, { file: 'puck-runner-linux-x64-9.9.9.tar.gz' }) as RunnerReleaseManifest;
    expect(failure(() => selectRunnerAsset(m, { version: VERSION, os: 'linux', arch: 'x64' })).code).toBe('malformed');
  });
});

describe('SHA256SUMS', () => {
  const m = manifest({ sha256sumsSha256: 'e'.repeat(64) });
  const sums = formatSha256Sums(m.assets);

  it('formats and reads the sha256sum line format', () => {
    expect(sums.split('\n')[0]).toBe(`${'1'.repeat(64)}  puck-runner-linux-x64-1.2.3.tar.gz`);
    expect(readSha256Sums(sums)).toEqual(m.assets.map((a) => ({ file: a.file, sha256: a.sha256 })));
  });

  it('agrees with the manifest that names it', () => {
    expect(() => checkSha256Sums(m, sums, 'e'.repeat(64))).not.toThrow();
    const reordered = formatSha256Sums([m.assets[2], m.assets[0], m.assets[1]]);
    expect(() => checkSha256Sums(m, reordered, 'e'.repeat(64))).not.toThrow();
  });

  it('refuses a SHA256SUMS the manifest does not name', () => {
    expect(failure(() => checkSha256Sums(m, sums, 'f'.repeat(64))).code).toBe('sums-mismatch');
  });

  it('refuses sums that disagree with the manifest', () => {
    const digest = 'e'.repeat(64);
    expect(failure(() => checkSha256Sums(m, formatSha256Sums(m.assets.slice(0, 2)), digest)).message).toMatch(/lists 2 files/);
    expect(failure(() => checkSha256Sums(m, sums + `${'9'.repeat(64)}  extra.tar.gz\n`, digest)).message).toMatch(/lists 4 files/);
    const other = [{ ...m.assets[0], sha256: '9'.repeat(64) }, m.assets[1], m.assets[2]];
    expect(failure(() => checkSha256Sums(m, formatSha256Sums(other), digest)).message).toMatch(/disagree about puck-runner-linux-x64/);
    const renamed = [{ ...m.assets[0], file: 'puck-runner-linux-x64-1.2.4.tar.gz' }, m.assets[1], m.assets[2]];
    expect(failure(() => checkSha256Sums(m, formatSha256Sums(renamed), digest)).message).toMatch(/does not list puck-runner-linux-x64-1.2.3/);
  });

  it('reads only the exact line format', () => {
    for (const bad of [sums.slice(0, -1), sums.replace(/ {2}/, ' '), sums.replace(/\n/g, '\r\n'), `\n${sums}`, sums + sums, sums.replace('1'.repeat(64), '1'.repeat(63))]) {
      expect(failure(() => readSha256Sums(bad)).code).toBe('sums-mismatch');
    }
  });
});

describe('version probe', () => {
  it('reads what the runner prints', () => {
    const line = formatVersionProbe({ version: '0.1.0', trustMode: 'production', runnerProtocol: 1 });
    expect(line).toBe('{"version":"0.1.0","trustMode":"production","runnerProtocol":1}\n');
    expect(readVersionProbe(line)).toEqual({ version: '0.1.0', trustMode: 'production', runnerProtocol: 1 });
  });

  it('ignores fields added later but requires the three it knows', () => {
    expect(readVersionProbe('{"version":"0.1.0","trustMode":"development","runnerProtocol":2,"extra":true}').trustMode).toBe('development');
    for (const bad of ['0.1.0\n', '{"version":"0.1.0","trustMode":"staging","runnerProtocol":1}', '{"version":"0.1.0","trustMode":"production"}', '{"version":"v0.1.0","trustMode":"production","runnerProtocol":1}']) {
      expect(failure(() => readVersionProbe(bad)).code).toBe('malformed');
    }
  });

  it('knows exactly the development and production trust modes', () => {
    expect(isRunnerTrustMode('development')).toBe(true);
    expect(isRunnerTrustMode('production')).toBe(true);
    for (const bad of ['Production', 'dev', '', undefined]) expect(isRunnerTrustMode(bad)).toBe(false);
  });
});
