/**
 * The environment switcher's menu: every environment (name, runner, status
 * dot) to switch to, "Start environment…", and the operations on the
 * current one: Stop, Start, Rebuild and Delete (Delete arms on first
 * click, never a dialog). An environment whose runner was removed offers
 * Forget instead, and one the app is already working on offers nothing
 * until that settles. Context in, elements built here.
 */

import type { InstanceInfo, PuckBridge } from '../harness/bridge';
import { armDelete, el } from './dom';
import { statusWord, toneOf } from './instance-progress';
import { button, errText } from './util';

export type InstanceOp = 'stop' | 'start' | 'rebuild' | 'delete' | 'forget';

/** The operations an environment offers right now. */
export function instanceOps(info: InstanceInfo): InstanceOp[] {
  if (info.status !== 'active') return ['forget'];
  if (info.op && !info.op.error) return [];
  return ['stop', 'start', 'rebuild', 'delete'];
}

const LABEL: Record<InstanceOp, string> = { stop: 'Stop', start: 'Start', rebuild: 'Rebuild', delete: 'Delete', forget: 'Forget' };
const HINT: Record<InstanceOp, string> = {
  stop: 'Stop the container; work waits until it starts again',
  start: 'Start the container again',
  rebuild: 'Recreate the container from the definition at its pin; work is kept',
  delete: 'Delete the container, its volumes and all its work',
  forget: 'Remove it from your list; nothing is deleted on the machine',
};

export async function runInstanceOp(bridge: PuckBridge, envId: string, op: InstanceOp): Promise<void> {
  switch (op) {
    case 'stop':
      return bridge.instanceStop(envId);
    case 'start':
      return bridge.instanceResume(envId);
    case 'rebuild':
      return bridge.instanceRebuild(envId);
    case 'delete':
      return bridge.instanceDelete(envId);
    case 'forget':
      return bridge.instanceForget(envId);
  }
}

export interface InstanceMenuContext {
  bridge: PuckBridge;
  instances: InstanceInfo[];
  currentId: string | null;
  open(envId: string): void;
  start(): void;
  say(text: string): void;
  /** The menu should close (an item was picked or an op started). */
  close(): void;
}

export function renderInstanceMenu(host: HTMLElement, ctx: InstanceMenuContext): void {
  host.textContent = '';
  const list = el('div', 'tb-menu-list');
  list.setAttribute('role', 'menu');
  if (!ctx.instances.length) list.appendChild(el('p', 'tb-menu-empty', 'No environments yet.'));
  for (const info of ctx.instances) {
    const row = button(`tb-menu-env${info.id === ctx.currentId ? ' current' : ''}`);
    row.setAttribute('role', 'menuitem');
    row.dataset.env = info.id;
    row.append(
      el('span', `tb-dot tone-${toneOf(info)}`),
      el('span', 'tb-menu-name', info.name || info.id),
      el('span', 'tb-menu-where', `${info.runnerName} · ${statusWord(info)}`),
    );
    row.addEventListener('click', () => {
      ctx.close();
      if (info.id !== ctx.currentId) ctx.open(info.id);
    });
    list.appendChild(row);
  }
  host.appendChild(list);

  const start = button('tb-menu-start', 'Start environment…');
  start.setAttribute('role', 'menuitem');
  start.addEventListener('click', () => {
    ctx.close();
    ctx.start();
  });
  host.appendChild(start);

  const current = ctx.instances.find((i) => i.id === ctx.currentId);
  if (!current) return;
  const ops = instanceOps(current);
  const rail = el('div', 'tb-menu-ops');
  rail.appendChild(el('span', 'tb-menu-label', current.name || 'This environment'));
  if (!ops.length) rail.appendChild(el('span', 'tb-menu-note', 'Working on it…'));
  for (const op of ops) {
    const b = button(op === 'delete' ? 'btn-ghost danger' : 'btn-ghost', LABEL[op]);
    b.dataset.op = op;
    b.title = HINT[op];
    const run = async (): Promise<void> => {
      ctx.close();
      ctx.say('');
      try {
        await runInstanceOp(ctx.bridge, current.id, op);
      } catch (err) {
        ctx.say(errText(err));
      }
    };
    if (op === 'delete' || op === 'forget') armDelete(b, run);
    else b.addEventListener('click', () => void run());
    rail.appendChild(b);
  }
  host.appendChild(rail);
}
