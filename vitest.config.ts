import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Unit tests never boot Electron; the mock covers the small surface
      // the main-process modules touch (paths, safeStorage, windows).
      electron: path.resolve(__dirname, 'test/mocks/electron.ts'),
      // The daemon bundle is a build output; unit tests get a small stand-in.
      'raw-daemon-meta': path.resolve(__dirname, 'test/mocks/raw-daemon-meta.ts'),
      'raw-daemon': path.resolve(__dirname, 'test/mocks/raw-daemon.ts'),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    // The Docker suite needs a Docker engine: npm run test:docker (vitest.docker.config.ts).
    exclude: ['test/docker/**', 'node_modules/**'],
  },
});
