/**
 * notices.json: orchestrator notices not yet delivered. A notice is taken
 * off this list when a turn that carries it starts, and recorded in the
 * orchestrator's transcript as a `notice` entry.
 */

import * as path from 'node:path';
import type { Notice } from '../../harness/transcript';
import { JsonStore } from './store';

export interface NoticesFile {
  pending: Notice[];
}

export function noticesStore(stateDir: string): JsonStore<NoticesFile> {
  return new JsonStore(
    path.join(stateDir, 'notices.json'),
    () => ({ pending: [] }),
    (raw) => ({ pending: Array.isArray((raw as NoticesFile)?.pending) ? (raw as NoticesFile).pending : [] }),
  );
}
