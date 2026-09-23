/**
 * The runner agent source, bundled as a raw string (webpack `asset/source`
 * via the `raw-runner` alias) from src/main/runner/runner.js — real
 * JavaScript with real tooling, no template-literal escaping.
 * environments.ts writes it to a temp file and docker-cp's it to
 * /opt/puck/runner.js on every environment start.
 */

import runnerSource from 'raw-runner';

export const RUNNER_SOURCE: string = runnerSource;
