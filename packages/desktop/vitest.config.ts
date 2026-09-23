import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Unit tests never boot Electron; the mock covers the small surface
      // the main-process modules touch (paths, safeStorage, windows).
      electron: path.resolve(__dirname, 'test/mocks/electron.ts'),
      // Webpack ships runner.js as a raw string (asset/source); vite's ?raw
      // import gives tests the same shape.
      'raw-runner': `${path.resolve(__dirname, 'src/main/runner/runner.js')}?raw`,
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
});
