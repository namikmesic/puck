/**
 * The daemon's harness adapter registry, keyed by harness id. Every pure
 * harness descriptor (src/harness/providers) must have an adapter here; a
 * unit test derives the check from the descriptor list, so a new harness
 * without an adapter fails the suite.
 *
 * SDKs are not bundled: they load at runtime from /opt/puck/node_modules,
 * where provisioning installs the exact pinned versions.
 */

import { CODEX_AS_PUCK, claudeSpawner } from './spawn';
import { createClaudeAdapter, type ClaudeSdk } from './claude';
import { createCodexAdapter, type CodexSdk } from './codex';
import { testAdapters } from './test-adapters';
import type { HarnessAdapter } from './types';
import type { Logger } from '../log';

/** Native dynamic import, left alone by webpack, resolved next to the bundle. */
function loadExternal<T>(name: string): Promise<T> {
  return import(/* webpackIgnore: true */ name) as Promise<T>;
}

export interface AdapterDeps {
  log: Logger;
  daemonVersion: string;
  /** The orchestrator's in-process tools (none until orchestration lands). */
  orchestratorTools(): unknown[];
}

export function createAdapters(deps: AdapterDeps): Record<string, HarnessAdapter> {
  if (testAdapters) return testAdapters(deps.log);
  return {
    'claude-code': createClaudeAdapter({
      loadSdk: () => loadExternal<ClaudeSdk>('@anthropic-ai/claude-agent-sdk'),
      spawner: claudeSpawner(deps.log),
      orchestratorTools: deps.orchestratorTools,
      daemonVersion: deps.daemonVersion,
    }),
    codex: createCodexAdapter({
      loadSdk: () => loadExternal<CodexSdk>('@openai/codex-sdk'),
      codexPath: CODEX_AS_PUCK,
    }),
  };
}
