#!/usr/bin/env node
/**
 * Runs an Electron Forge build command and refuses to exit zero without a
 * fresh app artifact under out/.
 *
 * Forge itself has exited 0 with nothing packaged: on an unsupported Node
 * major it dies while "Finalizing package" and never reaches its own hooks.
 * So the check runs here, after the Forge process has ended, and the Node
 * major is verified up front against .nvmrc.
 *
 * Release mechanics live here too, after Forge exits: the signing notice
 * (ad hoc unless the RELEASE.md variables are set), the darwin/arm64 target,
 * the bundle checks (signature, minimum macOS, icon), and for `make` the
 * artifact name check plus a SHA-256 checksum file beside the ZIP.
 *
 *   node scripts/forge.mjs package [forge args]
 *   node scripts/forge.mjs make [forge args]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findAppArtifacts, findMakeArtifacts, nodeMajorMismatch } from './build-checks.mjs';
import {
  checksumLine,
  describeSignature,
  expectedZipName,
  MIN_MACOS,
  sha256File,
  signingPlan,
  withReleaseTarget,
} from './release.mjs';

const COMMANDS = ['package', 'make'];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...forgeArgs] = process.argv.slice(2);

function say(message) {
  console.log(`[puck build] ${message}`);
}

function fail(message) {
  console.error(`\n[puck build] ${message}`);
  process.exit(1);
}

/** Runs a macOS tool and returns its combined output (codesign reports on stderr). */
function tool(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

if (!COMMANDS.includes(command)) {
  fail(`usage: node scripts/forge.mjs <${COMMANDS.join('|')}> [forge args]`);
}

const mismatch = nodeMajorMismatch(readFileSync(join(root, '.nvmrc'), 'utf8'), process.version);
if (mismatch) fail(mismatch);

const plan = signingPlan(process.env);
if (!plan.ok) fail(plan.error);
say(plan.notice);

const { productName, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outDir = join(root, 'out');
// Whole seconds: some filesystems store mtimes at one-second resolution.
const since = Math.floor(Date.now() / 1000) * 1000;

const forge = spawnSync(
  join(root, 'node_modules', '.bin', 'electron-forge'),
  [command, ...withReleaseTarget(forgeArgs)],
  { cwd: root, stdio: 'inherit' },
);
if (forge.error) fail(`could not start electron-forge: ${forge.error.message}`);
if (forge.status !== 0) process.exit(forge.status ?? 1);

const apps = findAppArtifacts(outDir, productName, since);
if (apps.length === 0) {
  fail(`electron-forge ${command} exited 0 but wrote no fresh ${productName} app bundle under ${outDir}`);
}
for (const app of apps) {
  say(`app artifact: ${app}`);
  if (app.endsWith('.app')) checkBundle(app);
}

if (command === 'make') {
  const made = findMakeArtifacts(outDir, since);
  if (made.length === 0) {
    fail(`electron-forge make exited 0 but wrote no fresh distributable under ${join(outDir, 'make')}`);
  }
  for (const zip of made.filter((f) => f.endsWith('.zip'))) {
    // Forge writes out/make/zip/<platform>/<arch>/<name>.zip.
    const arch = basename(dirname(zip));
    const platform = basename(dirname(dirname(zip)));
    const expected = expectedZipName(productName, platform, arch, version);
    if (basename(zip) !== expected) {
      fail(`distributable is named ${basename(zip)}, expected ${expected} (version and arch must be in the name)`);
    }
    const checksum = `${zip}.sha256`;
    writeFileSync(checksum, checksumLine(sha256File(zip), basename(zip)));
    say(`distributable: ${zip}`);
    say(`checksum: ${checksum} (verify with: shasum -a 256 -c ${basename(checksum)})`);
  }
}

/**
 * Bundle checks on macOS: the signature matches what the environment asked
 * for, the minimum macOS matches the documented one, and the release icon
 * is in place. Each is a release requirement that would otherwise slip
 * through a green build.
 */
function checkBundle(app) {
  if (process.platform !== 'darwin') {
    say('bundle checks skipped: codesign and plutil need macOS');
    return;
  }
  const signature = describeSignature(tool('codesign', ['-dvv', app]).out);
  if (plan.signed && signature.adhoc) {
    fail('signing was requested but the bundle is ad hoc signed; see the codesign output above');
  }
  if (!plan.signed && !signature.adhoc && signature.authority) {
    fail(`the bundle is signed by "${signature.authority}" although no identity was set`);
  }
  say(
    signature.adhoc
      ? 'signature: ad hoc (not notarized)'
      : `signature: ${signature.authority ?? 'unknown authority'}${signature.teamId ? ` (team ${signature.teamId})` : ''}`,
  );
  if (plan.notarized) {
    const stapled = tool('xcrun', ['stapler', 'validate', app]);
    if (stapled.code !== 0) fail(`notarization was requested but no ticket is stapled:\n${stapled.out.trim()}`);
    say('notarization: ticket stapled');
  }

  const plist = join(app, 'Contents', 'Info.plist');
  const minimum = tool('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', plist]).out.trim();
  if (minimum !== MIN_MACOS) {
    fail(`bundle LSMinimumSystemVersion is ${minimum || 'unset'}, but MIN_MACOS in scripts/release.mjs says ${MIN_MACOS}; update the constant and the docs together`);
  }
  say(`minimum macOS: ${minimum}`);

  // Packager keeps Electron's icon file name and replaces its content, so
  // the check compares bytes with the release icon, not names.
  const iconFile = tool('plutil', ['-extract', 'CFBundleIconFile', 'raw', '-o', '-', plist]).out.trim();
  const iconPath = join(app, 'Contents', 'Resources', iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`);
  const releaseIcon = join(root, 'assets', 'icon', 'puck.icns');
  if (!iconFile || !existsSync(iconPath)) {
    fail(`release icon missing: CFBundleIconFile=${iconFile || 'unset'}, expected ${iconPath}`);
  }
  if (sha256File(iconPath) !== sha256File(releaseIcon)) {
    fail(`bundle icon ${iconPath} is not the release icon ${releaseIcon}; check packagerConfig.icon in forge.config.ts`);
  }
  say(`icon: ${basename(iconPath)} (matches assets/icon/puck.icns)`);
}
