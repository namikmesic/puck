import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The environment daemon's Docker suite: the real bundle (built with the
 * scripted fake harness) in real containers. Opt-in (`npm run test:docker`)
 * because it needs a Docker engine; CI runs it on Linux.
 */
export default defineConfig({
  resolve: {
    // The golden scenario drives main-process modules; the Docker suite never boots Electron.
    alias: { electron: path.resolve(__dirname, 'test/mocks/electron.ts') },
  },
  test: {
    include: ['test/docker/**/*.test.ts'],
    globalSetup: ['test/docker/setup.ts'],
    // One engine, shared images: run the files one after another.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 600_000,
  },
});
