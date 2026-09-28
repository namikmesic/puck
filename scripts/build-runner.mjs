#!/usr/bin/env node
/**
 * Builds puck-runner into one file, `.webpack/runner/puck-runner.js`, that
 * runs on the tarball's bundled Node 22 with no node_modules: `ws` is
 * bundled, and every `node:` import stays external. ws's optional native
 * helpers (bufferutil, utf-8-validate) stay external too; ws loads them in
 * a try/catch and falls back to JavaScript.
 *
 * Writes `puck-runner.meta.json` beside it ({ version, sha256 }) and fails
 * if the bundle still requires anything that is not a Node built-in.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RUNNER_OUT = join(root, '.webpack', 'runner');
const OPTIONAL = ['bufferutil', 'utf-8-validate'];

export async function buildRunner() {
  const config = {
    mode: 'production',
    target: 'node22',
    context: root,
    entry: './src/puck-runner/main.ts',
    output: { path: RUNNER_OUT, filename: 'puck-runner.js', clean: true },
    // The real __filename at runtime: the runner finds its directory from it.
    node: { __filename: false, __dirname: false },
    devtool: false,
    resolve: { extensions: ['.ts', '.js', '.json'] },
    module: {
      rules: [{ test: /\.ts$/, exclude: /node_modules/, use: { loader: 'ts-loader', options: { transpileOnly: true } } }],
    },
    externals: [
      ({ request }, callback) => {
        if (request && (request.startsWith('node:') || OPTIONAL.includes(request))) return callback(null, `commonjs ${request}`);
        callback();
      },
    ],
    optimization: { minimize: false, splitChunks: false },
    plugins: [new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 })],
    performance: { hints: false },
  };

  const stats = await new Promise((ok, fail) => {
    webpack(config, (err, result) => (err ? fail(err) : ok(result)));
  });
  if (stats.hasErrors()) {
    throw new Error(stats.toString({ all: false, errors: true }));
  }

  const bundlePath = join(RUNNER_OUT, 'puck-runner.js');
  const bundle = readFileSync(bundlePath, 'utf8');
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  const foreign = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]).filter((name) => !builtins.has(name) && !OPTIONAL.includes(name));
  if (foreign.length) throw new Error(`The runner bundle requires modules outside Node: ${[...new Set(foreign)].join(', ')}`);

  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const sha256 = createHash('sha256').update(bundle).digest('hex');
  writeFileSync(join(RUNNER_OUT, 'puck-runner.meta.json'), JSON.stringify({ version, sha256 }, null, 2) + '\n');
  console.log(`puck-runner ${version} → ${bundlePath} (${(bundle.length / 1024).toFixed(0)} KiB, sha256 ${sha256.slice(0, 12)})`);
  return { bundlePath, version, sha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildRunner().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
