import * as path from 'node:path';
import type { ForgeConfig, ForgePackagerOptions } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';
import { signingPlan } from './scripts/release.mjs';

// Developer ID signing and notarization switch on through the environment
// variables documented in RELEASE.md (never through a file in the repo).
// With none of them set the build is ad hoc signed and not notarized, and
// scripts/forge.mjs says so on the console. A misconfigured set is reported
// there too, before Forge starts; the config itself just falls back.
const signing = signingPlan(process.env);
const signingOptions: Pick<ForgePackagerOptions, 'osxSign' | 'osxNotarize'> = signing.ok
  ? (signing.packager as Pick<ForgePackagerOptions, 'osxSign' | 'osxNotarize'>)
  : {};

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Puck',
    appBundleId: 'com.namikmesic.puck',
    appCategoryType: 'public.app-category.developer-tools',
    // Packager appends the platform extension (.icns on macOS). The source
    // and the render script live next to it: assets/icon/puck.svg,
    // scripts/make-icon.sh.
    icon: path.resolve(__dirname, 'assets', 'icon', 'puck'),
    ...signingOptions,
  },
  rebuildConfig: {},
  // macOS-first: ship only what we actually build.
  makers: [new MakerZIP({}, ['darwin'])],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      // Dev-server CSP: webpack needs eval sourcemaps + ws; packaged builds
      // get the strict policy from src/index.ts instead.
      devContentSecurityPolicy:
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data:; connect-src 'self' ws:",
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/index.html',
            js: './src/renderer.ts',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
            },
          },
        ],
      },
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
