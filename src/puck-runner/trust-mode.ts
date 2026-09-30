/**
 * The trust mode scripts/build-runner.mjs compiles into the bundle
 * (`--mode development|production`, src/harness/runner-releases.ts). There
 * is no default: a build without a mode fails there, and code that reads
 * the mode outside such a build throws instead of guessing.
 */

import { isRunnerTrustMode, type RunnerTrustMode } from '../harness/runner-releases';

// Replaced by webpack's DefinePlugin in scripts/build-runner.mjs.
declare const __PUCK_RUNNER_TRUST_MODE__: string | undefined;

export function runnerTrustMode(): RunnerTrustMode {
  const mode = typeof __PUCK_RUNNER_TRUST_MODE__ === 'string' ? __PUCK_RUNNER_TRUST_MODE__ : undefined;
  if (!isRunnerTrustMode(mode)) throw new Error('This puck-runner was built without a trust mode; build it with scripts/build-runner.mjs --mode development|production.');
  return mode;
}
