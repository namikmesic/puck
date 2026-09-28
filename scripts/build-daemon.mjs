#!/usr/bin/env node
/**
 * Builds the environment daemon (puckd) with webpack's Node API and checks
 * the result:
 *
 *   .webpack/daemon/puckd.js         the bundle the app embeds and copies into containers
 *   .webpack/daemon/puckd.meta.json  { version, build }: the app version and the bundle's sha256
 *
 * The check fails the build when the bundle `require`s anything but Node
 * built-ins, or when one of the runtime-loaded packages (the harness SDKs,
 * zod, the MCP SDK) was bundled instead of left as a native import().
 *
 *   node scripts/build-daemon.mjs            the shipped daemon
 *   node scripts/build-daemon.mjs --test     the Docker suite's build (fake adapters) in .webpack/daemon-test/
 */

import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';
import { daemonConfig } from '../webpack.daemon.config.ts';

/** Loaded at runtime from /opt/puck/node_modules, never bundled. */
export const RUNTIME_PACKAGES = [
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex-sdk',
  'zod',
  '@modelcontextprotocol/sdk',
];

/** Marker string of the test-only fake adapter; the shipped bundle must not contain it. */
export const FAKE_MARKER = 'PUCK_FAKE_ADAPTER';

/** Bare `require("x")` specifiers in a bundle that are not Node built-ins. */
export function foreignRequires(source) {
  const builtins = new Set(builtinModules);
  const found = new Set();
  for (const m of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    const name = m[1].replace(/^node:/, '');
    if (!builtins.has(name) && !builtins.has(name.split('/')[0])) found.add(m[1]);
  }
  return [...found];
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const test = process.argv.includes('--test');
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const config = daemonConfig({ root, appVersion: version, testAdapters: test });

  const stats = await new Promise((resolve, reject) => {
    webpack(config, (err, result) => (err ? reject(err) : resolve(result)));
  });
  if (stats.hasErrors()) {
    console.error(stats.toString({ colors: false, all: false, errors: true }));
    throw new Error('daemon build failed');
  }

  const out = path.join(config.output.path, 'puckd.js');
  const bundle = fs.readFileSync(out);
  const source = bundle.toString('utf8');
  const problems = [];
  const foreign = foreignRequires(source);
  if (foreign.length) problems.push(`the bundle requires non-builtin modules: ${foreign.join(', ')}`);
  for (const pkg of RUNTIME_PACKAGES) {
    if (source.includes(`node_modules/${pkg}/`)) problems.push(`${pkg} was bundled; it must load at runtime`);
  }
  if (!test && source.includes(FAKE_MARKER)) problems.push('the fake test adapter leaked into the shipped bundle');
  if (test && !source.includes(FAKE_MARKER)) problems.push('the test build is missing the fake adapter');
  if (!/import\(\s*\/\* webpackIgnore: true \*\/\s*name\s*\)/.test(source) && !/\bimport\(name\)/.test(source)) {
    problems.push('the runtime SDK import is no longer a native import()');
  }
  if (problems.length) throw new Error(`daemon bundle check failed:\n  - ${problems.join('\n  - ')}`);

  const meta = { version, build: sha256(bundle) };
  fs.writeFileSync(path.join(config.output.path, 'puckd.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  console.log(`puckd ${test ? '(test build) ' : ''}${version} ${meta.build.slice(0, 12)} → ${path.relative(root, out)} (${bundle.length} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
