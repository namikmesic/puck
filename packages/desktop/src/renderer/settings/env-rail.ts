/**
 * The one environment op rail (Select / Stop / Restart / Rebuild / Start /
 * Delete) — used by both the envs list cards and the env detail header, so
 * adding an operation is one edit. Ops run one at a time per host; whatever
 * `EnvironmentInfo[]` the bridge mutation returns flows to `onSettled`, so
 * callers can render it instead of re-probing docker with a second envList.
 */

import type { EnvironmentInfo, HarnessStatus, PuckBridge } from '../../harness/bridge';
import { armDelete } from '../dom';
import { button, errText } from '../util';

export interface EnvRailContext {
  bridge: PuckBridge;
  applyStatus(status: HarnessStatus): void;
  /** Where op errors land (the page's .form-msg slot). */
  message(text: string): void;
  /** Runs after every op; receives the mutation's returned list when it has one. */
  onSettled(latest?: EnvironmentInfo[]): Promise<void>;
  /** List cards live inside a clickable card — rail clicks must not open it. */
  stopPropagation?: boolean;
  /** Site-specific delete (clear local ids, navigate away). */
  onDelete(env: EnvironmentInfo): Promise<EnvironmentInfo[] | void>;
}

export function envOpRail(host: HTMLElement, env: EnvironmentInfo, ctx: EnvRailContext): void {
  const runOp = async (
    btn: HTMLButtonElement,
    fn: () => Promise<EnvironmentInfo[] | void>,
  ): Promise<void> => {
    host.querySelectorAll('button').forEach((b) => (b.disabled = true)); // one op at a time
    btn.textContent = '…';
    ctx.message('');
    let latest: EnvironmentInfo[] | undefined;
    try {
      latest = (await fn()) ?? undefined;
    } catch (err) {
      ctx.message(errText(err));
    }
    await ctx.onSettled(latest);
  };
  const action = (label: string, fn: () => Promise<EnvironmentInfo[] | void>): void => {
    const btn = button('btn-ghost', label);
    btn.addEventListener('click', (e) => {
      if (ctx.stopPropagation) e.stopPropagation();
      void runOp(btn, fn);
    });
    host.appendChild(btn);
  };

  if (!env.active) {
    action('Select', async () => {
      ctx.applyStatus(await ctx.bridge.envSelect(env.id));
    });
  }
  if (env.status === 'running') {
    action('Stop', () => ctx.bridge.envStop(env.id));
    action('Restart', () => ctx.bridge.envRestart(env.id));
    action('Rebuild', () => ctx.bridge.envRebuild(env.id));
  } else {
    action('Start', () => ctx.bridge.envStart(env.id));
    action('Rebuild', () => ctx.bridge.envRebuild(env.id));
    const del = button('btn-ghost danger', 'Delete');
    // armDelete stops propagation itself, so the clickable list card stays shut.
    armDelete(del, () => runOp(del, () => ctx.onDelete(env)));
    host.appendChild(del);
  }
}
