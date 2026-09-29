import type { ModuleOptions } from 'webpack';

export const rules: Required<ModuleOptions>['rules'] = [
  // The environment daemon ships as a raw string (built by
  // scripts/build-daemon.mjs; the app sends it to runners) — import it as
  // source, don't bundle it.
  {
    test: /daemon[/\\]puckd\.js$/,
    type: 'asset/source',
  },
  // `?raw` imports are the file's text (the starter Puck home, src/main/home-starter.ts).
  {
    resourceQuery: /raw/,
    type: 'asset/source',
  },
  // Add support for native node modules
  {
    // We're specifying native_modules in the test because the asset relocator loader generates a
    // "fake" .node file which is really a cjs file.
    test: /native_modules[/\\].+\.node$/,
    use: 'node-loader',
  },
  {
    test: /[/\\]node_modules[/\\].+\.(m?js|node)$/,
    parser: { amd: false },
    use: {
      loader: '@vercel/webpack-asset-relocator-loader',
      options: {
        outputAssetBase: 'native_modules',
      },
    },
  },
  {
    test: /\.tsx?$/,
    exclude: /(node_modules|\.webpack)/,
    use: {
      loader: 'ts-loader',
      options: {
        transpileOnly: true,
      },
    },
  },
];
