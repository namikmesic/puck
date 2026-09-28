import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CommandRunner, RunOptions, RunResult } from '../../src/daemon/exec';
import { daemonPaths, type DaemonPaths } from '../../src/daemon/paths';

export interface RecordedCommand {
  argv: string[];
  opts: RunOptions;
}

/**
 * A CommandRunner that records every command and answers from `respond`
 * (default: success with empty output).
 */
export function fakeRunner(respond: (argv: string[], opts: RunOptions) => Partial<RunResult> | undefined = () => undefined) {
  const calls: RecordedCommand[] = [];
  const run: CommandRunner = async (argv, opts = {}) => {
    calls.push({ argv, opts });
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...respond(argv, opts) };
  };
  return { run, calls };
}

/** A daemon filesystem layout under a fresh temporary root. */
export function tempRoot(prefix = 'puckd-'): { root: string; paths: DaemonPaths; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, paths: daemonPaths(root), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A resolved definition as the app delivers it. */
export function exampleDefinition(over: Record<string, unknown> = {}): Record<string, unknown> {
  const lead = { harness: 'claude-code', model: 'auto', effort: 'high', instructions: 'Lead the work.' };
  return {
    name: 'example',
    repos: [{ github: 'octo/app', dir: 'app', branch: 'main' }],
    orchestrator: { agent: 'lead', autoWake: true, maxAutoTurnsPerHour: 30 },
    agents: [
      { agent: 'implementer', maxParallel: 2, instructions: 'Stay in scope.' },
      { agent: 'reviewer', maxParallel: 1 },
    ],
    agentDefinitions: {
      lead,
      implementer: { harness: 'claude-code', instructions: 'Implement.' },
      reviewer: { harness: 'codex', instructions: 'Review.' },
    },
    git: { userName: 'Puck Agent', userEmail: 'puck-agent@users.noreply.github.com' },
    env: { NODE_ENV: 'development' },
    secrets: ['NPM_TOKEN'],
    ...over,
  };
}

/** The value, or a failed test when it is missing. */
export function defined<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}
