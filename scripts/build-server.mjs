/**
 * Builds the Puck server into one file, `.webpack/server/puck-server.js`,
 * that runs on plain Node 22 with no node_modules: `ws` is bundled, SQLite
 * is Node's built-in `node:sqlite`, and every `node:` import stays external.
 * ws's optional native helpers (bufferutil, utf-8-validate) stay external
 * too; ws loads them in a try/catch and falls back to JavaScript.
 *
 * Writes `puck-server.meta.json` beside it ({ version, sha256 }) and fails
 * if the bundle still requires anything that is not a Node built-in.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.webpack', 'server');
const OPTIONAL = ['bufferutil', 'utf-8-validate'];

const config = {
  mode: 'production',
  target: 'node22',
  context: root,
  entry: './src/server/main.ts',
  output: { path: outDir, filename: 'puck-server.js', library: { type: 'commonjs2' } },
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

const stats = await new Promise((resolve, reject) => {
  webpack(config, (err, result) => (err ? reject(err) : resolve(result)));
});
if (stats.hasErrors()) {
  console.error(stats.toString({ all: false, errors: true }));
  process.exit(1);
}

const bundlePath = join(outDir, 'puck-server.js');
const bundle = readFileSync(bundlePath, 'utf8');
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'node:sqlite']);
const foreign = [...bundle.matchAll(/require\("([^"]+)"\)/g)]
  .map((m) => m[1])
  .filter((name) => !builtins.has(name) && !OPTIONAL.includes(name));
if (foreign.length) {
  console.error(`The server bundle requires modules outside Node: ${[...new Set(foreign)].join(', ')}`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const sha256 = createHash('sha256').update(bundle).digest('hex');
writeFileSync(join(outDir, 'puck-server.meta.json'), JSON.stringify({ version, sha256 }, null, 2) + '\n');
console.log(`puck-server ${version} → ${bundlePath} (${(bundle.length / 1024).toFixed(0)} KiB, sha256 ${sha256.slice(0, 12)})`);
