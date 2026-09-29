/**
 * How an environment's state reads on screen: its status dot and word, the
 * "stage · elapsed" line while the app or the daemon works on it, and the
 * composer gate. Built from what the app knows (`InstanceInfo`: the index,
 * the op in flight, the attach) and, for the environment on screen, the
 * daemon's own state. Pure functions plus a one-second ticker; no DOM
 * lookups.
 */

import type { InstanceInfo } from '../harness/bridge';
import type { InstanceState, ProvisionStage } from '../harness/daemon-protocol';
import { formatElapsed } from '../harness/lifecycle';
import type { InstanceStage } from '../harness/runner-protocol';
import { el } from './dom';

/** on: ready (emerald). busy: working (gold pulse). bad: failed (red). off: stopped or unreachable (gray). */
export type Tone = 'on' | 'busy' | 'bad' | 'off';

const RUNNER_STAGES: Record<InstanceStage, string> = {
  'checking-image': 'checking the image',
  'pulling-image': 'pulling the image',
  'building-image': 'building the image',
  'creating-volumes': 'creating volumes',
  'creating-container': 'creating the container',
  'copying-files': 'copying files in',
  'starting-container': 'starting the container',
  'stopping-container': 'stopping the container',
  'removing-container': 'removing the container',
  'removing-volumes': 'removing volumes',
  'removing-image': 'removing the image',
  'staging-daemon': 'staging the daemon',
};

const PROVISION_STAGES: Record<ProvisionStage, string> = {
  'checking-runtime': 'checking the runtime',
  'creating-user': 'creating the puck user',
  'installing-clis': 'installing harness CLIs',
  'installing-sdks': 'installing harness SDKs',
  'verifying-packages': 'verifying packages',
  'configuring-git': 'configuring git',
  'syncing-repos': 'syncing repositories',
  'writing-credentials': 'writing credentials',
};

const OP_WORDS: Record<NonNullable<InstanceInfo['op']>['kind'], string> = {
  starting: 'starting',
  stopping: 'stopping',
  resuming: 'starting',
  rebuilding: 'rebuilding',
  deleting: 'deleting',
};

export function runnerStageLabel(stage: InstanceStage | null): string {
  return stage ? RUNNER_STAGES[stage] ?? stage : '';
}

export function provisionStageLabel(stage: ProvisionStage | undefined): string {
  return stage ? PROVISION_STAGES[stage] ?? stage : '';
}

/** The daemon state that applies: the live one for the environment on screen, else the last known. */
function daemonOf(info: InstanceInfo, live?: InstanceState | null): InstanceState | null {
  return live ?? info.daemon;
}

/** The status word next to an environment's dot. */
export function statusWord(info: InstanceInfo, live?: InstanceState | null): string {
  if (info.status === 'lost') return 'runner removed';
  if (info.status === 'orphaned') return 'kept on a removed runner';
  if (info.op && !info.op.error) return OP_WORDS[info.op.kind];
  if (info.op?.error) return `${OP_WORDS[info.op.kind]} failed`;
  if (info.attach === 'unreachable') return 'unreachable';
  const daemon = daemonOf(info, live);
  if (!daemon) return info.current ? 'connecting' : 'not open';
  return daemon.status;
}

export function toneOf(info: InstanceInfo, live?: InstanceState | null): Tone {
  if (info.status !== 'active') return 'off';
  if (info.op) return info.op.error ? 'bad' : 'busy';
  if (info.attach === 'unreachable' || info.attach === 'detached') return 'off';
  const daemon = daemonOf(info, live);
  switch (daemon?.status) {
    case 'ready':
      return 'on';
    case 'provisioning':
    case 'stopping':
      return 'busy';
    case 'failed':
    case 'degraded':
      return 'bad';
    default:
      return info.attach === 'connecting' || info.attach === 'reconnecting' ? 'busy' : 'off';
  }
}

/** Status chip: dot plus word, toned. */
export function statusChip(info: InstanceInfo, live?: InstanceState | null): HTMLElement {
  const tone = toneOf(info, live);
  const wrap = el('span', `status tone-${tone}${tone === 'on' ? ' on' : ''}`);
  wrap.appendChild(el('span', 'dot'));
  wrap.appendChild(document.createTextNode(statusWord(info, live)));
  return wrap;
}

/**
 * What is happening right now, for the status chip and the start flow:
 * the app's op ("pulling the image · 12s"), else the daemon provisioning
 * ("installing harness CLIs · npm …"). Empty when settled.
 */
export function progressLine(info: InstanceInfo, now: number, live?: InstanceState | null): string {
  if (info.op) {
    const label = runnerStageLabel(info.op.stage) || OP_WORDS[info.op.kind];
    if (info.op.error) return `${OP_WORDS[info.op.kind]} failed: ${info.op.error}`;
    return `${label} · ${formatElapsed(now - info.op.startedAt)}`;
  }
  const daemon = daemonOf(info, live);
  if (daemon?.status === 'provisioning') {
    return [provisionStageLabel(daemon.stage) || 'provisioning', daemon.detail].filter(Boolean).join(' · ');
  }
  if (daemon?.status === 'failed' || daemon?.status === 'degraded') return daemon.error || daemon.detail || daemon.status;
  return '';
}

/** Whether a ticker should keep the elapsed time moving. */
export function isWorking(info: InstanceInfo | undefined): boolean {
  return !!info?.op && !info.op.error;
}

/** "v1.4.0 (a1b2c3d)" */
export function pinText(pin: { kind: string; name: string; sha: string } | null | undefined): string {
  if (!pin) return '';
  const short = pin.sha.slice(0, 7);
  return pin.kind === 'commit' ? short : `${pin.name} (${short})`;
}

export interface ComposerGate {
  ready: boolean;
  placeholder: string;
  /** Why sending is blocked; empty when ready. */
  reason: string;
}

/** The orchestrator composer: open only while the environment is attached and ready. */
export function composerGate(info: InstanceInfo | undefined, live: InstanceState | null, agent: string | null): ComposerGate {
  const blocked = (reason: string): ComposerGate => ({ ready: false, placeholder: reason, reason });
  if (!info) return blocked('Start an environment to talk to its orchestrator.');
  if (info.status !== 'active') return blocked('Its runner was removed from Puck.');
  if (info.op && !info.op.error) return blocked(`The environment is ${OP_WORDS[info.op.kind]}…`);
  if (info.attach === 'unreachable') return blocked(`Can't reach ${info.runnerName}.`);
  if (info.attach === 'incompatible') return blocked(info.attachDetail || "This environment's daemon needs a newer Puck.");
  if (info.attach === 'detached') return blocked(`Not connected to ${info.name || 'this environment'}.`);
  if (info.attach !== 'attached') return blocked('Connecting…');
  if (!live) return blocked('Loading…');
  if (live.status === 'provisioning') return blocked(`The environment is ${provisionStageLabel(live.stage) || 'provisioning'}…`);
  if (live.status === 'stopping') return blocked('The environment is stopping.');
  if (live.status === 'failed') return blocked(`The environment failed: ${live.error ?? 'unknown error'}`);
  return { ready: true, placeholder: agent ? `Message ${agent}` : 'Message the orchestrator', reason: '' };
}

/** Runs `onTick` once a second while `busy()` holds; `sync()` after state changes. */
export function createTicker(opts: { busy(): boolean; onTick(now: number): void; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval }) {
  const setI = opts.setInterval ?? setInterval;
  const clearI = opts.clearInterval ?? clearInterval;
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    sync(): void {
      if (opts.busy() && !timer) timer = setI(() => opts.onTick(Date.now()), 1000);
      else if (!opts.busy() && timer) {
        clearI(timer);
        timer = null;
      }
    },
    running: (): boolean => timer !== null,
    dispose(): void {
      if (timer) clearI(timer);
      timer = null;
    },
  };
}
