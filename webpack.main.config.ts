import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Compiler, Configuration } from 'webpack';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

/** The environment daemon bundle the main process embeds (scripts/build-daemon.mjs). */
export const DAEMON_BUNDLE = path.resolve(__dirname, '.webpack/daemon/puckd.js');

/** Runs the daemon build; shared by the forge generateAssets hook and the plugin below. */
export function buildDaemon(): void {
  execFileSync(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.resolve(__dirname, 'scripts/build-daemon.mjs')],
    { stdio: 'inherit', cwd: __dirname },
  );
}

/**
 * Forge's webpack plugin empties .webpack/ after the generateAssets hook
 * has run, just before it compiles the main process. Rebuild the daemon
 * right before the first main compile when it is gone, so `raw-daemon`
 * always resolves to a fresh bundle.
 */
class DaemonBundlePlugin {
  apply(compiler: Compiler): void {
    let done = false;
    const ensure = (): void => {
      if (done) return;
      done = true;
      if (!fs.existsSync(DAEMON_BUNDLE)) buildDaemon();
    };
    compiler.hooks.beforeRun.tap('DaemonBundlePlugin', ensure);
    compiler.hooks.watchRun.tap('DaemonBundlePlugin', ensure);
  }
}

export const mainConfig: Configuration = {
  /**
   * This is the main entry point for your application, it's the first file
   * that runs in the main process.
   */
  entry: './src/index.ts',
  // Put your normal webpack config below here
  module: {
    rules,
  },
  plugins: [...plugins, new DaemonBundlePlugin()],
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
    alias: {
      // The environment daemon bundle, a raw string (asset/source rule), and its metadata.
      'raw-daemon': DAEMON_BUNDLE,
      'raw-daemon-meta': path.resolve(__dirname, '.webpack/daemon/puckd.meta.json'),
    },
  },
};
