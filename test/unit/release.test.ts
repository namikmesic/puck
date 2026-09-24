import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checksumLine,
  describeSignature,
  expectedZipName,
  MIN_MACOS,
  RELEASE_TARGET,
  sha256File,
  SIGNING_ENV,
  signingPlan,
  withReleaseTarget,
} from '../../scripts/release.mjs';

const IDENTITY = 'Developer ID Application: Example Person (ABCDE12345)';
const PASSWORD_CREDS = {
  [SIGNING_ENV.appleId]: 'person@example.com',
  [SIGNING_ENV.appleIdPassword]: 'abcd-efgh-ijkl-mnop',
  [SIGNING_ENV.teamId]: 'ABCDE12345',
};
const API_KEY_CREDS = {
  [SIGNING_ENV.apiKey]: '/keys/AuthKey_T9GPZ92M7K.p8',
  [SIGNING_ENV.apiKeyId]: 'T9GPZ92M7K',
  [SIGNING_ENV.apiIssuer]: 'c055ca8c-e5a8-4836-b61d-aa5794eeb3f4',
};

describe('signingPlan', () => {
  it('is ad hoc and not notarized when nothing is set, and says so in one line', () => {
    const plan = signingPlan({});
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('unreachable');
    expect(plan.signed).toBe(false);
    expect(plan.notarized).toBe(false);
    expect(plan.packager).toEqual({});
    expect(plan.notice).toMatch(/ad hoc/);
    expect(plan.notice).toMatch(/not notarized/);
    expect(plan.notice).toContain(SIGNING_ENV.identity);
    expect(plan.notice.includes('\n')).toBe(false);
  });

  it('treats blank values as unset', () => {
    const plan = signingPlan({ [SIGNING_ENV.identity]: '  ', [SIGNING_ENV.teamId]: '' });
    expect(plan.ok && !plan.signed).toBe(true);
  });

  it('signs without notarizing when only the identity is set, and fails the build on a sign error', () => {
    const plan = signingPlan({ [SIGNING_ENV.identity]: IDENTITY });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.signed).toBe(true);
    expect(plan.notarized).toBe(false);
    expect(plan.packager).toEqual({ osxSign: { identity: IDENTITY, continueOnError: false } });
    expect(plan.notice).toMatch(/not notarized/);
  });

  it('notarizes with an Apple ID, app-specific password, and team id', () => {
    const plan = signingPlan({ [SIGNING_ENV.identity]: IDENTITY, ...PASSWORD_CREDS });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.notarized).toBe(true);
    expect(plan.packager.osxNotarize).toEqual({
      appleId: 'person@example.com',
      appleIdPassword: 'abcd-efgh-ijkl-mnop',
      teamId: 'ABCDE12345',
    });
    expect(plan.notice).not.toContain('abcd-efgh-ijkl-mnop'); // the password never prints
  });

  it('notarizes with an App Store Connect API key', () => {
    const plan = signingPlan({ [SIGNING_ENV.identity]: IDENTITY, ...API_KEY_CREDS });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.notarized).toBe(true);
    expect(plan.packager.osxNotarize).toEqual({
      appleApiKey: '/keys/AuthKey_T9GPZ92M7K.p8',
      appleApiKeyId: 'T9GPZ92M7K',
      appleApiIssuer: 'c055ca8c-e5a8-4836-b61d-aa5794eeb3f4',
    });
  });

  it('refuses notarization credentials without a signing identity', () => {
    const plan = signingPlan({ ...PASSWORD_CREDS });
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error('unreachable');
    expect(plan.error).toContain(SIGNING_ENV.identity);
  });

  it('names the missing variables of a partial credential set', () => {
    const plan = signingPlan({
      [SIGNING_ENV.identity]: IDENTITY,
      [SIGNING_ENV.appleId]: 'person@example.com',
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error('unreachable');
    expect(plan.error).toContain(SIGNING_ENV.appleIdPassword);
    expect(plan.error).toContain(SIGNING_ENV.teamId);
    expect(plan.error).not.toContain(SIGNING_ENV.appleId + ',');
  });

  it('refuses both credential sets at once', () => {
    const plan = signingPlan({ [SIGNING_ENV.identity]: IDENTITY, ...PASSWORD_CREDS, ...API_KEY_CREDS });
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error('unreachable');
    expect(plan.error).toMatch(/one notarization credential set/);
  });
});

describe('release target', () => {
  it('is macOS on Apple silicon', () => {
    expect(RELEASE_TARGET).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(MIN_MACOS).toBe('12.0');
  });

  it('adds the target to forge arguments unless the caller chose one', () => {
    expect(withReleaseTarget([])).toEqual(['--platform', 'darwin', '--arch', 'arm64']);
    expect(withReleaseTarget(['--arch', 'x64'])).toEqual(['--arch', 'x64', '--platform', 'darwin']);
    expect(withReleaseTarget(['--platform=mas'])).toEqual(['--platform=mas', '--arch', 'arm64']);
  });

  it('names the ZIP with product, platform, arch, and version', () => {
    expect(expectedZipName('Puck', 'darwin', 'arm64', '0.0.1')).toBe('Puck-darwin-arm64-0.0.1.zip');
  });
});

describe('checksum', () => {
  const dir = mkdtempSync(join(tmpdir(), 'puck-release-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('hashes a file with SHA-256 and writes the shasum -c line format', () => {
    const file = join(dir, 'Puck-darwin-arm64-0.0.1.zip');
    writeFileSync(file, 'abc');
    const hex = sha256File(file);
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(checksumLine(hex, 'Puck-darwin-arm64-0.0.1.zip')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  Puck-darwin-arm64-0.0.1.zip\n',
    );
  });
});

describe('describeSignature', () => {
  it('recognizes the ad hoc signature Electron ships with', () => {
    const output = [
      'Executable=/x/Puck.app/Contents/MacOS/Puck',
      'Identifier=com.namikmesic.puck',
      'Format=app bundle with Mach-O thin (arm64)',
      'CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded',
      'Signature=adhoc',
      'Info.plist=not bound',
      'TeamIdentifier=not set',
    ].join('\n');
    expect(describeSignature(output)).toEqual({ adhoc: true, authority: null, teamId: null });
  });

  it('reads the leaf authority and team of a Developer ID signature', () => {
    const output = [
      'Identifier=com.namikmesic.puck',
      'Signature size=8990',
      'Authority=Developer ID Application: Example Person (ABCDE12345)',
      'Authority=Developer ID Certification Authority',
      'Authority=Apple Root CA',
      'Timestamp=23 Sep 2026 at 12:00:00',
      'TeamIdentifier=ABCDE12345',
    ].join('\n');
    expect(describeSignature(output)).toEqual({
      adhoc: false,
      authority: 'Developer ID Application: Example Person (ABCDE12345)',
      teamId: 'ABCDE12345',
    });
  });
});
