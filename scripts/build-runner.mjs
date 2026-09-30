#!/usr/bin/env node
/**
 * Builds puck-runner into one file, `.webpack/runner/puck-runner.cjs`, that
 * runs on the tarball's bundled Node 22 with no node_modules: `ws` is
 * bundled, SQLite is Node's built-in `node:sqlite`, and every `node:`
 * import stays external. ws's optional native helpers (bufferutil,
 * utf-8-validate) stay external too; ws loads them in a try/catch and
 * falls back to JavaScript.
 *
 * The trust mode is explicit and compiled in: `--mode development` (the
 * repository's own builds and the development server image) or `--mode
 * production` (release packaging). A missing or unknown mode fails; there
 * is no default. The runner reports it in `version --json`.
 *
 * Writes `puck-runner.meta.json` beside it ({ version, trustMode, sha256 })
 * and fails if the bundle still requires anything that is not a Node
 * built-in.
 *
 *   node scripts/build-runner.mjs --mode development|production
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import webpack from 'webpack';
import { readVersionProbe, RUNNER_TRUST_MODES } from '../src/harness/runner-releases.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RUNNER_OUT = join(root, '.webpack', 'runner');
const OPTIONAL = ['bufferutil', 'utf-8-validate'];

/** The mode, or an error naming the choices: never a default. */
export function runnerTrustMode(mode) {
  if (RUNNER_TRUST_MODES.includes(mode)) return mode;
  const choices = RUNNER_TRUST_MODES.map((m) => `--mode ${m}`).join(' or ');
  throw new Error(mode === undefined ? `Pick the runner's trust mode: ${choices}.` : `Unknown runner trust mode ${JSON.stringify(mode)}; use ${choices}.`);
}

export async function buildRunner({ mode } = {}) {
  const trustMode = runnerTrustMode(mode);
  const config = {
    mode: 'production',
    target: 'node22',
    context: root,
    entry: './src/puck-runner/main.ts',
    output: { path: RUNNER_OUT, filename: 'puck-runner.cjs', clean: true },
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
    plugins: [
      new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
      // Read by src/puck-runner/trust-mode.ts.
      new webpack.DefinePlugin({ __PUCK_RUNNER_TRUST_MODE__: JSON.stringify(trustMode) }),
    ],
    performance: { hints: false },
  };

  const stats = await new Promise((ok, fail) => {
    webpack(config, (err, result) => (err ? fail(err) : ok(result)));
  });
  if (stats.hasErrors()) {
    throw new Error(stats.toString({ all: false, errors: true }));
  }

  const bundlePath = join(RUNNER_OUT, 'puck-runner.cjs');
  const bundle = readFileSync(bundlePath, 'utf8');
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'node:sqlite']);
  const foreign = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]).filter((name) => !builtins.has(name) && !OPTIONAL.includes(name));
  if (foreign.length) throw new Error(`The runner bundle requires modules outside Node: ${[...new Set(foreign)].join(', ')}`);

  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const sha256 = createHash('sha256').update(bundle).digest('hex');
  writeFileSync(join(RUNNER_OUT, 'puck-runner.meta.json'), JSON.stringify({ version, trustMode, sha256 }, null, 2) + '\n');
  console.log(`puck-runner ${version} (${trustMode}) → ${bundlePath} (${(bundle.length / 1024).toFixed(0)} KiB, sha256 ${sha256.slice(0, 12)})`);
  return { bundlePath, version, trustMode, sha256 };
}

/**
 * Parses a build script's command line and refuses any option given more
 * than once, in either spelling (`--mode x`, `--mode=x`). parseArgs keeps
 * the last value, and npm appends forwarded arguments after a script's own,
 * so `npm run package:runner:release -- --mode development` would otherwise
 * silently build development trust.
 */
export function parseScriptArgs(args, options) {
  const { values, tokens } = parseArgs({ args, options, strict: true, tokens: true });
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`--${token.name} is given more than once; pass it once.`);
    seen.add(token.name);
  }
  return values;
}

/** Runs a built bundle's `version --json` on this Node and reads it (stdout only; Node warnings go to stderr). */
export function probeRunner(bundlePath) {
  const out = execFileSync(process.execPath, [bundlePath, 'version', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  return readVersionProbe(out);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => buildRunner({ mode: parseScriptArgs(process.argv.slice(2), { mode: { type: 'string' } }).mode }))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
