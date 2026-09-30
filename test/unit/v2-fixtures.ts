/** Shared fixtures for the environment window's renderer tests. */

import { vi } from 'vitest';
import type { DaemonEventPayload, InstanceEvent, InstanceInfo, PuckBridge, RunnerEvent } from '../../src/harness/bridge';
import type { DaemonEvent, ItemStatus, ItemStatusV1, SessionSummary, Snapshot, WorkItem, WorkItemV1 } from '../../src/harness/daemon-protocol';
import { upgradeV1Item } from '../../src/harness/workflow';

export const ENV = 'env_01J8Z3X0000000000000000000';
export const ENV2 = 'env_01J8Z3X0000000000000000001';
export const ORCH = 'ses_orch';
export const WORKER = 'ses_worker';

export function instance(over: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id: ENV,
    name: 'example',
    runnerId: 'rnr_ok',
    runnerName: 'build-box',
    local: false,
    status: 'active',
    repos: ['octo/web'],
    current: true,
    attach: 'attached',
    attachDetail: '',
    daemon: { status: 'ready' },
    op: null,
    lastSeq: null,
    ...over,
  };
}

export function session(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: ORCH,
    kind: 'orchestrator',
    agent: 'lead',
    harness: 'claude-code',
    cwd: '/workspace',
    status: 'idle',
    turns: 0,
    lastTurnTokens: 0,
    costUsd: 0,
    createdAt: 1,
    lastActiveAt: 1,
    queued: 0,
    ...over,
  };
}

/**
 * A ticket for the renderer's tests. `status` may name protocol 1's place
 * (`backlog`, `queued`, `running`, `needs-input`, `review`, `done`,
 * `failed`, `cancelled`), with `pr`, `source` and `pendingAsk` as protocol
 * 1 had them: the ticket is built with the app's own mapping
 * (`upgradeV1Item`), so each place is the ticket the three-state model
 * gives. Any protocol-2 field in `over` then wins.
 */
export type ItemOver = Partial<Omit<WorkItem, 'status'>> &
  Partial<Pick<WorkItemV1, 'pr' | 'source' | 'pendingAsk'>> & { status?: ItemStatusV1 | ItemStatus };

export function item(over: ItemOver = {}): WorkItem {
  const number = over.number ?? 1;
  const { status, pr, source, pendingAsk, ...v2 } = over;
  const place: ItemStatusV1 = status === 'todo' ? (over.agent ? 'queued' : 'backlog') : status === 'in-progress' ? 'running' : (status ?? 'backlog');
  const started = place !== 'backlog' && !(place === 'queued' && !over.sessionId) && place !== 'cancelled';
  const v1: WorkItemV1 = {
    id: `itm_${number}`,
    number,
    title: `Item ${number}`,
    body: '',
    status: place,
    agent: over.agent !== undefined ? over.agent : place === 'backlog' ? null : 'implementer',
    repo: null,
    createdBy: 'user',
    createdAt: 1_000 + number,
    updatedAt: 1_000 + number,
    attempts: 0,
    sessionId: over.sessionId !== undefined ? over.sessionId : started ? `ses_w${number}` : null,
    branch: null,
    worktree: null,
    base: null,
    result: null,
    pr: pr ?? null,
    source: source ?? null,
    lastError: null,
    cancelReason: null,
    acceptNote: null,
    pendingAsk: pendingAsk ?? null,
  };
  for (const key of ['title', 'body', 'repo', 'createdBy', 'createdAt', 'updatedAt', 'attempts', 'branch', 'worktree', 'base', 'lastError', 'cancelReason', 'acceptNote'] as const) {
    if (key in over) (v1 as unknown as Record<string, unknown>)[key] = over[key];
  }
  if (over.result) v1.result = over.result;
  if (v1.createdBy === ('pipeline' as string)) v1.createdBy = 'user';
  const up = upgradeV1Item(v1);
  return { ...up, ...v2, createdBy: over.createdBy ?? up.createdBy, status: up.status };
}

export function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    envId: ENV,
    name: 'example',
    daemon: { version: '0.0.1', build: 'test', protocol: 2 },
    head: 10,
    instance: { status: 'ready', pin: { kind: 'tag', name: 'v1.0.0', sha: 'a1b2c3d4e5f6' }, sha: 'a1b2c3d4e5f6' },
    github: { state: 'ok' },
    sessions: [session()],
    orchestratorSessionId: ORCH,
    items: [],
    order: [],
    capacity: { agents: { implementer: { running: 0, max: 2 } }, workers: { running: 0, max: 4 }, paused: false },
    inflight: [],
    asks: [],
    decisions: [],
    ...over,
  };
}

/** A bridge whose push channels the test drives. */
export function fakeBridge(over: Partial<PuckBridge> = {}) {
  let instanceCb: ((e: InstanceEvent) => void) | null = null;
  let daemonCb: ((e: DaemonEventPayload) => void) | null = null;
  let runnerCb: ((e: RunnerEvent) => void) | null = null;
  const bridge = {
    instanceList: vi.fn(async () => [] as InstanceInfo[]),
    instanceOpen: vi.fn(async () => undefined),
    daemon: vi.fn(async () => {
      throw new Error('not scripted');
    }),
    onInstanceEvent: (cb: (e: InstanceEvent) => void) => {
      instanceCb = cb;
    },
    onDaemonEvent: (cb: (e: DaemonEventPayload) => void) => {
      daemonCb = cb;
    },
    onRunnerEvent: (cb: (e: RunnerEvent) => void) => {
      runnerCb = cb;
    },
    openExternal: vi.fn(async () => undefined),
    ...over,
  } as unknown as PuckBridge;
  return {
    bridge,
    instanceEvent: (e: InstanceEvent) => instanceCb?.(e),
    daemonEvent: (seq: number, ev: DaemonEvent, envId = ENV) => daemonCb?.({ envId, seq, at: Date.now(), ev }),
    daemonSnapshot: (s: Snapshot, envId = ENV) => daemonCb?.({ envId, snapshot: s }),
    daemonWelcome: (daemon: Snapshot['daemon'], head: number, envId = ENV) => daemonCb?.({ envId, welcome: { daemon, head } }),
    runnerEvent: (e: RunnerEvent) => runnerCb?.(e),
  };
}

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
