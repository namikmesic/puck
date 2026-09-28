/**
 * Test-only adapters hook. The shipped daemon has none: this stub is what
 * every normal build compiles. The Docker suite's build swaps in
 * ./fake.ts (see webpack.daemon.config.ts), which maps every harness id to
 * a scripted fake that needs no account and no network.
 */

import type { HarnessAdapter } from './types';
import type { Logger } from '../log';

export const testAdapters: ((log: Logger) => Record<string, HarnessAdapter>) | null = null;
