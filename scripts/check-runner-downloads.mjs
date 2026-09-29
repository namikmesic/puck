#!/usr/bin/env node
/**
 * Checks what a running Puck server offers as runner downloads. CI runs it
 * against both server images; Node built-ins only.
 *
 *   node scripts/check-runner-downloads.mjs [server url]          (default http://localhost:8765)
 *   node scripts/check-runner-downloads.mjs --none [server url]
 *
 * By default (a development server): `GET /v1/runner/releases` lists
 * linux-x64, linux-arm64 and macos-arm64 for the package.json version, and
 * each asset's `url` downloads a file whose sha256 matches both the listing
 * and the `<url>.sha256` line. The listing's URLs come from the server's
 * PUCK_SERVER_URL, so the server must be reachable at that URL from here.
 *
 * With --none (a production server): the listing has no assets, and the
 * version's tarball and checksum answer 404.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXPECTED = ['linux-arm64', 'linux-x64', 'macos-arm64'];

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res;
}

export async function checkRunnerDownloads(server, version) {
  const releases = await (await get(`${server}/v1/runner/releases`)).json();
  if (releases.latest !== version) throw new Error(`latest is ${JSON.stringify(releases.latest)}, not ${version}`);
  const targets = releases.assets.map((a) => `${a.os}-${a.arch}`).sort();
  if (targets.join() !== EXPECTED.join()) throw new Error(`assets are [${targets.join(', ')}], not [${EXPECTED.join(', ')}]`);
  for (const asset of releases.assets) {
    if (asset.version !== version) throw new Error(`${asset.file} is version ${asset.version}, not ${version}`);
    const body = Buffer.from(await (await get(asset.url)).arrayBuffer());
    const sum = createHash('sha256').update(body).digest('hex');
    if (sum !== asset.sha256) throw new Error(`${asset.url} has sha256 ${sum}, but the listing says ${asset.sha256}`);
    if (body.length !== asset.size) throw new Error(`${asset.url} is ${body.length} bytes, but the listing says ${asset.size}`);
    const line = await (await get(`${asset.url}.sha256`)).text();
    if (line !== `${sum}  ${asset.file}\n`) throw new Error(`${asset.url}.sha256 reads ${JSON.stringify(line)}`);
    console.log(`${asset.file}  ${(body.length / 1024 / 1024).toFixed(1)} MiB  sha256 ${sum}  ok`);
  }
}

export async function checkNoRunnerDownloads(server, version) {
  const releases = await (await get(`${server}/v1/runner/releases`)).json();
  if (releases.latest !== null || releases.assets.length) {
    throw new Error(`the server offers runners: latest ${JSON.stringify(releases.latest)}, ${releases.assets.length} assets`);
  }
  for (const target of EXPECTED) {
    for (const file of [`puck-runner-${target}-${version}.tar.gz`, `puck-runner-${target}-${version}.tar.gz.sha256`]) {
      const res = await fetch(`${server}/runner/${version}/${file}`);
      if (res.status !== 404) throw new Error(`GET /runner/${version}/${file}: ${res.status}, not 404`);
    }
  }
  console.log('no runner downloads offered  ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const none = args.includes('--none');
  const server = (args.find((a) => a !== '--none') ?? 'http://localhost:8765').replace(/\/+$/, '');
  const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  (none ? checkNoRunnerDownloads : checkRunnerDownloads)(server, version).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
