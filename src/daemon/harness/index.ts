/**
 * The daemon's harness adapter registry, keyed by harness id. Every pure
 * harness descriptor (src/harness/providers) needs an adapter registered
 * from `createAdapters`.
 *
 * SDKs are not bundled: they load at runtime from /opt/puck/node_modules,
 * where provisioning installs the exact pinned versions.
 */

import { CODEX_AS_PUCK, claudeSpawner } from './spawn';
import { createClaudeAdapter, type ClaudeSdk } from './claude';
import { createCodexAdapter, type CodexSdk } from './codex';
import { testAdapters } from './test-adapters';
import type { HarnessAdapter, OrchestratorTool } from './types';
import type { Logger } from '../log';

/** Native dynamic import, left alone by webpack, resolved next to the bundle. */
function loadExternal<T>(name: string): Promise<T> {
  return import(/* webpackIgnore: true */ name) as Promise<T>;
}

export interface AdapterDeps {
  log: Logger;
  daemonVersion: string;
  /** The orchestrator's in-process tools. */
  orchestratorTools(): OrchestratorTool[];
}

export function createAdapters(deps: AdapterDeps): Record<string, HarnessAdapter> {
  if (testAdapters) return testAdapters(deps.log, deps.orchestratorTools, () => realAdapters(deps));
  return realAdapters(deps);
}

function realAdapters(deps: AdapterDeps): Record<string, HarnessAdapter> {
  return {
    'claude-code': createClaudeAdapter({
      loadSdk: () => loadExternal<ClaudeSdk>('@anthropic-ai/claude-agent-sdk'),
      loadZod: () => loadExternal<unknown>('zod'),
      spawner: claudeSpawner(deps.log),
      orchestratorTools: deps.orchestratorTools,
      // Tool handlers run here, in the root daemon, while the CLI runs as puck.
      onToolCall: (name, ok) => deps.log.info('tool.call', { tool: name, ok, uid: process.getuid?.() ?? null }),
      daemonVersion: deps.daemonVersion,
    }),
    codex: createCodexAdapter({
      loadSdk: () => loadExternal<CodexSdk>('@openai/codex-sdk'),
      codexPath: CODEX_AS_PUCK,
    }),
  };
}
