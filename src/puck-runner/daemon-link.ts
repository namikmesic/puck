/**
 * The runner's own short connection to one environment's daemon, for the
 * GitHub token pump: `docker exec -i puck-<envId> node /opt/puck/puckd.js
 * attach`, `hello` without a cursor (no replay), a few commands, close. The
 * daemon accepts several connections at once, so this never disturbs an
 * app's attach channel. Access to `docker exec` on this host is what
 * authenticates it, exactly as for the relay.
 *
 * The link's timer starts at open and is not reset on welcome. Close the
 * link before any slow work of your own; the token pump does that before
 * it asks the server to mint.
 */

import {
  PROTOCOL_VERSION,
  type DaemonFrame,
  type Op,
  type OpArgs,
  type OpResult,
} from '../harness/daemon-protocol';
import { instanceNames } from '../harness/runner-protocol';
import type { DockerSpawner } from './docker/client';

export const LINK_TIMEOUT_MS = 30_000;

export class DaemonLinkError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonLinkError';
  }
}

export interface DaemonLink {
  cmd<O extends Op>(op: O, args: OpArgs<O>): Promise<OpResult<O>>;
  close(): void;
}

export function attachArgs(envId: string): string[] {
  return ['exec', '-i', instanceNames(envId).container, 'node', '/opt/puck/puckd.js', 'attach'];
}

/** Opens a link and completes the handshake, or rejects (daemon not up yet, container gone). */
export function openDaemonLink(spawner: DockerSpawner, envId: string, client: { app: string; build: string }): Promise<DaemonLink> {
  const child = spawner(attachArgs(envId));
  const pending = new Map<string, { resolve(v: unknown): void; reject(e: Error): void }>();
  let buf = '';
  let stderr = '';
  let n = 0;
  let welcomed: ((ok: boolean, err?: Error) => void) | null = null;
  let closed = false;

  const fail = (err: Error): void => {
    if (closed) return;
    closed = true;
    welcomed?.(false, err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    child.kill();
  };
  const timer = setTimeout(() => fail(new DaemonLinkError('timeout', 'The environment daemon did not answer in time.')), LINK_TIMEOUT_MS);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let frame: DaemonFrame;
      try {
        frame = JSON.parse(line) as DaemonFrame;
      } catch {
        fail(new DaemonLinkError('bad-frame', 'The environment daemon sent an unreadable frame.'));
        return;
      }
      if (frame.t === 'welcome') welcomed?.(true);
      else if (frame.t === 'error') fail(new DaemonLinkError(frame.code, frame.message));
      else if (frame.t === 'res') {
        const p = pending.get(frame.id);
        pending.delete(frame.id);
        if (!p) continue;
        if (frame.ok) p.resolve(frame.result);
        else p.reject(new DaemonLinkError(frame.error.code, frame.error.message));
      }
    }
  });
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
  child.stdin.on('error', () => undefined);
  child.on('error', (err) => fail(new DaemonLinkError('spawn', err.message)));
  child.on('close', (code) => {
    clearTimeout(timer);
    fail(new DaemonLinkError('closed', `The daemon connection closed (exit ${String(code)}${stderr ? `: ${stderr.trim().slice(-300)}` : ''}).`));
  });

  const link: DaemonLink = {
    cmd<O extends Op>(op: O, args: OpArgs<O>): Promise<OpResult<O>> {
      if (closed) return Promise.reject(new DaemonLinkError('closed', 'The daemon connection is closed.'));
      const id = `r${++n}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        child.stdin.write(JSON.stringify({ t: 'cmd', id, op, args }) + '\n');
      });
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
    },
  };

  return new Promise((resolve, reject) => {
    welcomed = (ok, err) => {
      welcomed = null;
      if (ok) resolve(link);
      else reject(err);
    };
    child.stdin.write(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, client, since: null }) + '\n');
  });
}
