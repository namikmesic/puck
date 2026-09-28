import * as path from 'node:path';
import webpack, { type Configuration } from 'webpack';

/**
 * The environment daemon (puckd) as one CommonJS file for Node:
 * .webpack/daemon/puckd.js. The harness SDKs are NOT bundled; the daemon
 * loads them at runtime from /opt/puck/node_modules with a native dynamic
 * import that webpack leaves alone (`webpackIgnore`), so their versions are
 * the pinned ones provisioning installed. scripts/build-daemon.mjs runs this
 * config and checks the output.
 */
export interface DaemonBuildOptions {
  /** The repository root. */
  root: string;
  appVersion: string;
  /** Compile the scripted fake adapters in (Docker suite builds only). */
  testAdapters?: boolean;
  outDir?: string;
}

export function daemonConfig(opts: DaemonBuildOptions): Configuration {
  const at = (...p: string[]): string => path.join(opts.root, ...p);
  return {
    mode: 'production',
    target: 'node',
    entry: at('src', 'daemon', 'main.ts'),
    output: {
      path: opts.outDir ?? at('.webpack', opts.testAdapters ? 'daemon-test' : 'daemon'),
      filename: 'puckd.js',
      clean: true,
    },
    // The real __filename at runtime: `version` hashes the running bundle.
    node: { __filename: false, __dirname: false },
    externalsPresets: { node: true },
    devtool: false,
    optimization: {
      splitChunks: false,
      // Readable stack traces in the daemon log beat a few kilobytes.
      minimize: false,
    },
    resolve: { extensions: ['.ts', '.js'] },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: {
            loader: 'ts-loader',
            options: {
              transpileOnly: true,
              // Keep `import()` native: CommonJS output would turn it into
              // require(), which webpack would then try to bundle.
              compilerOptions: { module: 'es2020', sourceMap: false },
            },
          },
        },
      ],
    },
    plugins: [
      new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
      new webpack.DefinePlugin({ __PUCK_APP_VERSION__: JSON.stringify(opts.appVersion) }),
      ...(opts.testAdapters
        ? [new webpack.NormalModuleReplacementPlugin(/[/\\]test-adapters$/, at('src', 'daemon', 'harness', 'fake.ts'))]
        : []),
    ],
  };
}
