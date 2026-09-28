/**
 * Harness credentials between the app and an attached environment, over
 * the daemon protocol (the attach channel), never a docker command:
 *
 * - On every attach: `credentials.get`, and each file the CLIs rotated
 *   inside is adopted when strictly fresher than the app's (a signed-out
 *   account adopts nothing). Then the app's own copies go in with
 *   `credentials.put` wherever they are fresher or missing, and harnesses the
 *   user signed out of while the environment was detached are removed
 *   (`content: null`).
 * - On login: the fresh file goes to the attached environment.
 * - On logout: the file is removed from the attached environment, and every
 *   other environment is marked to lose it on its next attach.
 *
 * Only the harnesses an environment's agents use are touched.
 */

import type { OpArgs, OpResult } from '../../harness/daemon-protocol';

export interface SyncHarness {
  id: string;
  signedIn(): boolean;
  fresh(): Promise<{ content: string; supersedes(containerJson: string): boolean; current(): boolean } | null>;
  adoptIfNewer(containerJson: string): void;
}

export interface SyncDeps {
  harnesses: SyncHarness[];
  get(): Promise<OpResult<'credentials.get'>>;
  put(args: OpArgs<'credentials.put'>): Promise<unknown>;
}

/** The attach-time exchange; `used` are the environment's harnesses, `remove` those to drop. */
export async function syncOnAttach(deps: SyncDeps, used: string[], remove: string[]): Promise<{ pushed: string[]; removed: string[] }> {
  const { harness: theirs } = await deps.get();
  const inside = new Map(theirs.map((h) => [h.id, h.content]));
  const wanted = new Set([...used, ...inside.keys()]);
  const puts: { id: string; content: string | null }[] = [];
  const removed: string[] = [];
  for (const h of deps.harnesses) {
    if (!wanted.has(h.id) && !remove.includes(h.id)) continue;
    const container = inside.get(h.id);
    if (!h.signedIn()) {
      if (remove.includes(h.id) && container !== undefined) {
        puts.push({ id: h.id, content: null });
        removed.push(h.id);
      }
      continue;
    }
    if (container !== undefined) h.adoptIfNewer(container);
    if (!wanted.has(h.id)) continue;
    const fresh = await h.fresh();
    if (!fresh || !fresh.current()) continue;
    if (container === undefined || fresh.supersedes(container)) puts.push({ id: h.id, content: fresh.content });
  }
  if (puts.length) await deps.put({ harness: puts });
  return { pushed: puts.filter((p) => p.content !== null).map((p) => p.id), removed };
}

/** After a login: push the fresh file for `id` into the attached environment, if it uses it. */
export async function pushOne(deps: SyncDeps, h: SyncHarness): Promise<boolean> {
  const fresh = await h.fresh();
  if (!fresh || !fresh.current()) return false;
  await deps.put({ harness: [{ id: h.id, content: fresh.content }] });
  return true;
}
