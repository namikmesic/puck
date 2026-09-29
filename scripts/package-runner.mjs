#!/usr/bin/env node
/**
 * Packages puck-runner for each platform it supports, with its own Node
 * runtime, so a runner host needs nothing but Docker:
 *
 *   out/puck-runner/<version>/puck-runner-<os>-<arch>-<version>.tar.gz
 *   out/puck-runner/<version>/puck-runner-<os>-<arch>-<version>.tar.gz.sha256
 *   out/puck-runner/<version>/SHA256SUMS
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
 * and modes and the commit time as mtime, so a rebuild of the same commit
 * gives the same bytes.
 *
 *   node scripts/package-runner.mjs [--targets linux-x64,linux-arm64,macos-arm64] [--out <dir>]
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tarGz } from '../src/puck-runner/tar.ts';
import { buildRunner } from './build-runner.mjs';

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
async function nodeBinary(target) {
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

function commitTime() {
  if (process.env.SOURCE_DATE_EPOCH) return Number(process.env.SOURCE_DATE_EPOCH);
  try {
    return Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root }).toString().trim());
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

export async function packageRunner({ targets = Object.keys(TARGETS), outDir = path.join(root, 'out', 'puck-runner') } = {}) {
  const { bundlePath, version } = await buildRunner();
  const bundle = fs.readFileSync(bundlePath);
  const mtime = commitTime();
  const sh = (name) => fs.readFileSync(path.join(root, 'src', 'puck-runner', 'sh', name));
  const dest = path.join(outDir, version);
  fs.mkdirSync(dest, { recursive: true });
  const sums = [];
  const files = [];
  for (const key of targets) {
    const target = TARGETS[key];
    if (!target) throw new Error(`Unknown target ${key}; known: ${Object.keys(TARGETS).join(', ')}`);
    const { node, license } = await nodeBinary(target);
    const entry = (name, body, mode) => ({ name, type: 'file', mode, body, mtime });
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
    const file = `puck-runner-${target.os}-${target.arch}-${version}.tar.gz`;
    const sum = sha256(archive);
    fs.writeFileSync(path.join(dest, file), archive);
    fs.writeFileSync(path.join(dest, `${file}.sha256`), `${sum}  ${file}\n`);
    sums.push(`${sum}  ${file}`);
    files.push(path.join(dest, file));
    console.log(`${file}  ${(archive.length / 1024 / 1024).toFixed(1)} MiB  sha256 ${sum}`);
  }
  fs.writeFileSync(path.join(dest, 'SHA256SUMS'), sums.join('\n') + '\n');
  return { version, dir: dest, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const targets = arg('--targets')?.split(',').filter(Boolean);
  const out = arg('--out');
  packageRunner({ ...(targets ? { targets } : {}), ...(out ? { outDir: path.resolve(out) } : {}) }).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
