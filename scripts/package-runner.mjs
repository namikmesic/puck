#!/usr/bin/env node
/**
 * Packages puck-runner for each platform it supports, with its own Node
 * runtime, so a runner host needs nothing but Docker:
 *
 *   out/puck-runner/<version>/puck-runner-<os>-<arch>-<version>.tar.gz
 *   out/puck-runner/<version>/puck-runner-<os>-<arch>-<version>.tar.gz.sha256
 *   out/puck-runner/<version>/SHA256SUMS
 *   out/puck-runner/<version>/runner-release.json         (production only)
 *
 * for linux-x64, linux-arm64 and macos-arm64 (macOS is `macos` in runner
 * names, as the Puck server lists releases). That directory layout is what
 * the server's PUCK_RUNNER_DOWNLOADS serves. A tarball unpacks into the
 * current directory:
 *
 *   config.sh  run.sh  svc.sh  VERSION  README.md  LICENSE
 *   bin/node  bin/node.LICENSE  bin/puck-runner.cjs
 *
 * The Node runtime is the pinned release below, downloaded once into
 * .cache/runner-node/ and checked against the pinned sha256 before use.
 * Archives are written by the runner's own ustar writer with fixed owners
 * and modes and the commit time (or SOURCE_DATE_EPOCH) as mtime, so a
 * rebuild of the same commit gives the same bytes.
 *
 * The trust mode is explicit and compiled into the runner
 * (scripts/build-runner.mjs), and each run checks the built bundle's own
 * `version --json` against it. `--mode development` is `npm run
 * package:runner` and the development server image. `--mode production` is
 * the release packaging, `npm run package:runner:release`: all three
 * targets from a clean checkout, plus runner-release.json
 * (src/harness/runner-releases.ts) written from the archives' final bytes.
 * The manifest names the key that will sign it: the one key committed in
 * RELEASE_KEYS (src/runner-release/trust.ts), or `--signing-key-id`, which
 * production packaging needs while no key or several are committed.
 * Signing is a separate, explicit step (scripts/runner-release.mjs sign).
 * Every run removes a manifest or signature left by an earlier one; it
 * would not describe the new archives.
 *
 *   node scripts/package-runner.mjs --mode development|production
 *     [--targets linux-x64,linux-arm64,macos-arm64] [--out <dir>] [--signing-key-id <id>]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  formatSha256Sums,
  RELEASE_KEY_ID_RE,
  RUNNER_RELEASE_MANIFEST,
  RUNNER_RELEASE_SUMS,
  RUNNER_TARGETS,
  runnerPackageFile,
  SIGNATURE_SUFFIX,
  targetName,
} from '../src/harness/runner-releases.ts';
import { tarGz } from '../src/puck-runner/tar.ts';
import { buildRunner, probeRunner, runnerTrustMode } from './build-runner.mjs';
import { RELEASE_KEYS, loadReleaseKeys, writeReleaseManifest } from './runner-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The bundled runtime. Bump the version and all three sums together (from nodejs.org SHASUMS256.txt). */
export const NODE_VERSION = '22.23.3';
export const TARGETS = {
  'linux-x64': { os: 'linux', arch: 'x64', node: 'linux-x64', sha256: '1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af' },
  'linux-arm64': { os: 'linux', arch: 'arm64', node: 'linux-arm64', sha256: '5ced2d48d1d7198739b7f86804de0171aefb6823b684b12341d3321afc3cb0b2' },
  'macos-arm64': { os: 'macos', arch: 'arm64', node: 'darwin-arm64', sha256: '23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53' },
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function nodeArchive(target) {
  const name = `node-v${NODE_VERSION}-${target.node}.tar.gz`;
  const cacheDir = path.join(root, '.cache', 'runner-node');
  const file = path.join(cacheDir, name);
  if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== target.sha256) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}`;
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    const actual = sha256(body);
    if (actual !== target.sha256) throw new Error(`${name} has sha256 ${actual}, not the pinned ${target.sha256}`);
    fs.writeFileSync(file, body);
  }
  return { file, dir: `node-v${NODE_VERSION}-${target.node}` };
}

/** bin/node and Node's LICENSE out of the official archive (system tar; members named explicitly). */
export async function nodeBinary(target) {
  const { file, dir } = await nodeArchive(target);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-runner-node-'));
  try {
    execFileSync('tar', ['-xzf', file, '-C', tmp, `${dir}/bin/node`, `${dir}/LICENSE`]);
    return {
      node: fs.readFileSync(path.join(tmp, dir, 'bin', 'node')),
      license: fs.readFileSync(path.join(tmp, dir, 'LICENSE')),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function commitTime() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined) {
    if (!/^\d+$/.test(epoch)) throw new Error(`SOURCE_DATE_EPOCH must be whole seconds since the epoch, not ${JSON.stringify(epoch)}.`);
    return Number(epoch);
  }
  try {
    return Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root }).toString().trim());
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

/** The checked-out commit, for a production manifest; refuses a checkout with uncommitted changes to tracked files. */
export function sourceCommit() {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  let commit;
  let changes;
  try {
    commit = git('rev-parse', 'HEAD');
    changes = git('status', '--porcelain', '--untracked-files=no');
  } catch {
    throw new Error('Production packages come from a git checkout; this is not one.');
  }
  if (changes) throw new Error(`Production packages come from a clean checkout; commit or discard these changes first:\n${changes}`);
  return commit;
}

/** The key id a production manifest names: `--signing-key-id`, or the one committed release key. */
export function signingKeyIdFor(requested, keys) {
  const committed = loadReleaseKeys(keys).map((k) => k.id);
  if (requested !== undefined) {
    if (!RELEASE_KEY_ID_RE.test(requested)) throw new Error(`--signing-key-id must be a release key id (64 lowercase hex digits), not ${JSON.stringify(requested)}.`);
    if (committed.length && !committed.includes(requested)) throw new Error(`Release key ${requested} is not committed in RELEASE_KEYS (src/runner-release/trust.ts).`);
    return requested;
  }
  if (committed.length === 1) return committed[0];
  throw new Error(
    committed.length
      ? `RELEASE_KEYS commits ${committed.length} keys; name the signing key with --signing-key-id.`
      : 'No release key is committed in RELEASE_KEYS (src/runner-release/trust.ts). Commit the public key of the key that will sign, or name its id with --signing-key-id.',
  );
}

/** The requested targets in the canonical order; production takes all three or refuses. */
function selectTargets(targets, mode) {
  const all = RUNNER_TARGETS.map(targetName);
  for (const key of targets) if (!all.includes(key)) throw new Error(`Unknown target ${key}; known: ${all.join(', ')}`);
  const selected = all.filter((key) => targets.includes(key));
  if (mode === 'production' && selected.length !== all.length) {
    throw new Error(`A production release carries all three targets (${all.join(', ')}); drop --targets.`);
  }
  return selected;
}

/**
 * Builds the runner in `mode` and packages it (see the header). The
 * options after `outDir` are seams for tests.
 */
export async function packageRunner({
  mode,
  targets = RUNNER_TARGETS.map(targetName),
  outDir = path.join(root, 'out', 'puck-runner'),
  signingKeyId,
  build = buildRunner,
  runtime = nodeBinary,
  commit = sourceCommit,
  keys = RELEASE_KEYS,
} = {}) {
  const trustMode = runnerTrustMode(mode);
  const selected = selectTargets(targets, trustMode);
  const release = trustMode === 'production' ? { signingKeyId: signingKeyIdFor(signingKeyId, keys), sourceCommit: commit() } : null;
  const { bundlePath, version } = await build({ mode: trustMode });
  const probe = probeRunner(bundlePath);
  if (probe.trustMode !== trustMode || probe.version !== version) {
    throw new Error(`The built runner reports ${probe.version} (${probe.trustMode}), not ${version} (${trustMode}).`);
  }
  const bundle = fs.readFileSync(bundlePath);
  const mtime = commitTime();
  const sh = (name) => fs.readFileSync(path.join(root, 'src', 'puck-runner', 'sh', name));
  const dest = path.join(outDir, version);
  fs.mkdirSync(dest, { recursive: true });
  for (const stale of [RUNNER_RELEASE_MANIFEST, RUNNER_RELEASE_MANIFEST + SIGNATURE_SUFFIX, RUNNER_RELEASE_SUMS + SIGNATURE_SUFFIX]) {
    fs.rmSync(path.join(dest, stale), { force: true });
  }
  const sums = [];
  const files = [];
  for (const key of selected) {
    const target = TARGETS[key];
    const { node, license } = await runtime(target);
    const entry = (name, body, fileMode) => ({ name, type: 'file', mode: fileMode, body, mtime });
    const archive = tarGz([
      entry('config.sh', sh('config.sh'), 0o755),
      entry('run.sh', sh('run.sh'), 0o755),
      entry('svc.sh', sh('svc.sh'), 0o755),
      entry('VERSION', `${version}\n`, 0o644),
      entry('README.md', fs.readFileSync(path.join(root, 'src', 'puck-runner', 'README.md')), 0o644),
      entry('LICENSE', fs.readFileSync(path.join(root, 'LICENSE')), 0o644),
      { name: 'bin/', type: 'dir', mode: 0o755, mtime },
      entry('bin/node', node, 0o755),
      entry('bin/node.LICENSE', license, 0o644),
      entry('bin/puck-runner.cjs', bundle, 0o644),
    ]);
    const file = runnerPackageFile(target, version);
    const sum = sha256(archive);
    fs.writeFileSync(path.join(dest, file), archive);
    fs.writeFileSync(path.join(dest, `${file}.sha256`), formatSha256Sums([{ file, sha256: sum }]));
    sums.push({ file, sha256: sum });
    files.push(path.join(dest, file));
    console.log(`${file}  ${(archive.length / 1024 / 1024).toFixed(1)} MiB  sha256 ${sum}`);
  }
  fs.writeFileSync(path.join(dest, RUNNER_RELEASE_SUMS), formatSha256Sums(sums));
  const manifest = release && writeReleaseManifest(dest, { version, runnerProtocol: probe.runnerProtocol, ...release });
  if (manifest) console.log(`${RUNNER_RELEASE_MANIFEST}  for signing key ${manifest.signingKeyId}; sign it with npm run runner-release -- sign ${dest}`);
  return { version, trustMode, dir: dest, files, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => {
      const { values } = parseArgs({
        options: { mode: { type: 'string' }, targets: { type: 'string' }, out: { type: 'string' }, 'signing-key-id': { type: 'string' } },
        strict: true,
      });
      return packageRunner({
        mode: values.mode,
        ...(values.targets ? { targets: values.targets.split(',').filter(Boolean) } : {}),
        ...(values.out ? { outDir: path.resolve(values.out) } : {}),
        signingKeyId: values['signing-key-id'],
      });
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
