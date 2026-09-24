/**
 * Pure release helpers shared by scripts/forge.mjs (the build wrapper) and
 * forge.config.ts (the Forge config, loaded through jiti). Exercised by
 * test/unit/release.test.ts. Plain ES module with no compile step.
 *
 * Release 0.0.1 targets one platform and architecture (macOS on Apple
 * silicon) and ships as a local ZIP with a SHA-256 checksum beside it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The one release target: macOS on Apple silicon. */
export const RELEASE_TARGET = { platform: 'darwin', arch: 'arm64' };

/**
 * Minimum macOS the packaged app runs on. Electron 43 sets this in its own
 * Info.plist and the wrapper checks the packaged bundle against it, so the
 * documented number cannot drift from the binary.
 */
export const MIN_MACOS = '12.0';

/**
 * Environment variables that switch on Developer ID signing and
 * notarization. All are optional; none is ever read from a file in the
 * repository. RELEASE.md documents what each one holds.
 */
export const SIGNING_ENV = {
  identity: 'PUCK_SIGN_IDENTITY',
  appleId: 'PUCK_NOTARIZE_APPLE_ID',
  appleIdPassword: 'PUCK_NOTARIZE_APPLE_PASSWORD',
  teamId: 'PUCK_NOTARIZE_TEAM_ID',
  apiKey: 'PUCK_NOTARIZE_API_KEY',
  apiKeyId: 'PUCK_NOTARIZE_API_KEY_ID',
  apiIssuer: 'PUCK_NOTARIZE_API_ISSUER',
};

const PASSWORD_SET = ['appleId', 'appleIdPassword', 'teamId'];
const API_KEY_SET = ['apiKey', 'apiKeyId', 'apiIssuer'];

/**
 * Decides, from the environment alone, whether the build is signed and
 * notarized, and with which Electron Packager options.
 *
 * - Nothing set: ad hoc signed, not notarized (the default for 0.0.1 until
 *   the credentials exist), with a notice that says so.
 * - Identity only: signed with the Developer ID, not notarized.
 * - Identity plus one complete credential set: signed and notarized. The
 *   set is either Apple ID + app-specific password + team id, or an App
 *   Store Connect API key (.p8 path) + key id + issuer id.
 * - Anything partial, both sets at once, or credentials without an
 *   identity: an error naming the variables, so a release build never
 *   silently ships less than intended.
 *
 * @param {Record<string, string | undefined>} env usually `process.env`
 * @returns {{ ok: true, signed: boolean, notarized: boolean, notice: string,
 *             packager: { osxSign?: object, osxNotarize?: object } }
 *         | { ok: false, error: string }}
 */
export function signingPlan(env) {
  const value = (key) => {
    const raw = env[SIGNING_ENV[key]];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  };
  const identity = value('identity');
  const given = (set) => set.filter((key) => value(key) !== undefined);
  const passwordGiven = given(PASSWORD_SET);
  const apiKeyGiven = given(API_KEY_SET);
  const anyNotarize = passwordGiven.length + apiKeyGiven.length > 0;

  if (!identity) {
    if (anyNotarize) {
      return {
        ok: false,
        error: `notarization needs a signing identity: set ${SIGNING_ENV.identity} or unset the ${SIGNING_ENV.appleId.replace(/APPLE_ID$/, '')}* variables.`,
      };
    }
    return {
      ok: true,
      signed: false,
      notarized: false,
      packager: {},
      notice: `signing: ad hoc, not notarized. Gatekeeper will block this build on other Macs until it is opened from System Settings. Set ${SIGNING_ENV.identity} and the notarization variables from RELEASE.md to sign and notarize.`,
    };
  }

  // continueOnError:false makes a failed codesign fail the build; Packager's
  // default is to warn and ship the unsigned app anyway.
  const osxSign = { identity, continueOnError: false };

  if (passwordGiven.length && apiKeyGiven.length) {
    return {
      ok: false,
      error: `set one notarization credential set, not both: ${PASSWORD_SET.map((k) => SIGNING_ENV[k]).join(', ')} or ${API_KEY_SET.map((k) => SIGNING_ENV[k]).join(', ')}.`,
    };
  }
  for (const set of [PASSWORD_SET, API_KEY_SET]) {
    const have = given(set);
    if (have.length && have.length < set.length) {
      const missing = set.filter((k) => !have.includes(k)).map((k) => SIGNING_ENV[k]);
      return { ok: false, error: `incomplete notarization credentials: missing ${missing.join(', ')}.` };
    }
  }

  if (passwordGiven.length === PASSWORD_SET.length) {
    return {
      ok: true,
      signed: true,
      notarized: true,
      packager: {
        osxSign,
        osxNotarize: {
          appleId: value('appleId'),
          appleIdPassword: value('appleIdPassword'),
          teamId: value('teamId'),
        },
      },
      notice: `signing: Developer ID "${identity}", notarizing with the Apple ID ${value('appleId')} (team ${value('teamId')}).`,
    };
  }
  if (apiKeyGiven.length === API_KEY_SET.length) {
    return {
      ok: true,
      signed: true,
      notarized: true,
      packager: {
        osxSign,
        osxNotarize: {
          appleApiKey: value('apiKey'),
          appleApiKeyId: value('apiKeyId'),
          appleApiIssuer: value('apiIssuer'),
        },
      },
      notice: `signing: Developer ID "${identity}", notarizing with App Store Connect API key ${value('apiKeyId')}.`,
    };
  }
  return {
    ok: true,
    signed: true,
    notarized: false,
    packager: { osxSign },
    notice: `signing: Developer ID "${identity}", not notarized. Set the notarization variables from RELEASE.md to notarize.`,
  };
}

/**
 * Forces the release target unless the caller already chose one, so a
 * build on another host still produces the darwin/arm64 artifact.
 *
 * @param {string[]} forgeArgs arguments forwarded to electron-forge
 * @returns {string[]}
 */
export function withReleaseTarget(forgeArgs) {
  const has = (flag) => forgeArgs.some((a) => a === flag || a.startsWith(`${flag}=`));
  const out = [...forgeArgs];
  if (!has('--platform')) out.push('--platform', RELEASE_TARGET.platform);
  if (!has('--arch')) out.push('--arch', RELEASE_TARGET.arch);
  return out;
}

/**
 * The distributable name Forge's ZIP maker writes for a target:
 * `<productName>-<platform>-<arch>-<version>.zip`. Version and architecture
 * are both in the name, so two builds never collide.
 */
export function expectedZipName(productName, platform, arch, version) {
  return `${productName}-${platform}-${arch}-${version}.zip`;
}

/** Hex SHA-256 of a file. */
export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * One line in the format `shasum -a 256 -c` verifies: hex digest, two
 * spaces, the bare file name.
 */
export function checksumLine(hex, fileName) {
  return `${hex}  ${fileName}\n`;
}

/**
 * Reads the signature state from `codesign -dvv` output (which codesign
 * prints on stderr). An ad hoc signature has `Signature=adhoc` and no
 * Authority lines; a Developer ID signature lists the leaf authority first.
 *
 * @param {string} output
 * @returns {{ adhoc: boolean, authority: string | null, teamId: string | null }}
 */
export function describeSignature(output) {
  const lines = output.split('\n').map((l) => l.trim());
  const adhoc = lines.includes('Signature=adhoc');
  const authority = lines.find((l) => l.startsWith('Authority='))?.slice('Authority='.length) ?? null;
  const team = lines.find((l) => l.startsWith('TeamIdentifier='))?.slice('TeamIdentifier='.length);
  return { adhoc, authority, teamId: team && team !== 'not set' ? team : null };
}
