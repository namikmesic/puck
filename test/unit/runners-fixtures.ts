/** Runner rows and the Runners provider info, for the renderer tests. */

import type { EnvironmentProviderInfo, RunnerRow, RunnersState } from '../../src/harness/bridge';

export const RID = 'rnr_01J8Z3X0000000000000000001';
export const LOCAL_ID = 'rnr_01J8Z3X0000000000000000002';

export function runnerRow(over: Partial<RunnerRow> = {}): RunnerRow {
  return {
    id: RID,
    name: 'build-box',
    labels: ['linux', 'x64', 'gpu'],
    os: 'linux',
    arch: 'x64',
    version: '0.1.0',
    fingerprint: 'SHA256:q1w2e3',
    status: 'idle',
    running: 0,
    maxEnvironments: null,
    docker: { ok: true, version: '27.3.1', problem: null, ncpu: 16, memTotal: 62.8 * 1024 ** 3 },
    createdAt: 1,
    lastSeenAt: Date.now(),
    local: false,
    environments: [],
    keyChanged: false,
    ...over,
  };
}

export function runnersState(over: Partial<RunnersState> = {}): RunnersState {
  return {
    signedIn: true,
    login: 'octocat',
    server: 'http://localhost:8765',
    connection: 'connected',
    runners: [runnerRow()],
    local: { supported: true, unsupported: null, installed: false, runnerId: null, busy: null, detail: '', error: null },
    ...over,
  };
}

export function runnersInfo(over: Partial<RunnersState> = {}): EnvironmentProviderInfo {
  return {
    kind: 'environment',
    id: 'runner',
    label: 'Runners',
    status: { state: 'connected', detail: '1 runner, 1 online' },
    runners: runnersState(over),
  };
}
