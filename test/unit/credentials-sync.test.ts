/**
 * Harness credentials on attach: rotated files inside are adopted, fresher
 * or missing ones go in, signed-out harnesses are removed when marked, and
 * nothing is sent for a harness the environment does not use.
 */

import { describe, expect, it, vi } from 'vitest';
import { syncOnAttach, type SyncHarness } from '../../src/main/instances/credentials-sync';

function harness(id: string, opts: { signedIn?: boolean; ours?: number; theirs?: number } = {}): SyncHarness & { adopted: string[] } {
  const adopted: string[] = [];
  const signedIn = opts.signedIn ?? true;
  return {
    id,
    adopted,
    signedIn: () => signedIn,
    fresh: async () =>
      signedIn
        ? {
            content: JSON.stringify({ at: opts.ours ?? 10 }),
            supersedes: (json: string) => (JSON.parse(json) as { at: number }).at < (opts.ours ?? 10),
            current: () => true,
          }
        : null,
    adoptIfNewer: (json: string) => void adopted.push(json),
  };
}

describe('credentials sync on attach', () => {
  it('adopts what the CLI rotated, and pushes only fresher or missing files', async () => {
    const claude = harness('claude-code', { ours: 10 });
    const codex = harness('codex', { ours: 10 });
    const put = vi.fn(async () => ({}));
    const get = vi.fn(async () => ({ harness: [{ id: 'claude-code', content: JSON.stringify({ at: 20 }) }] }));
    const out = await syncOnAttach({ harnesses: [claude, codex], get, put }, ['claude-code', 'codex'], []);
    expect(claude.adopted).toEqual([JSON.stringify({ at: 20 })]);
    // Claude's copy inside is fresher: not overwritten. Codex has none inside: pushed.
    expect(put).toHaveBeenCalledWith({ harness: [{ id: 'codex', content: JSON.stringify({ at: 10 }) }] });
    expect(out).toEqual({ pushed: ['codex'], removed: [] });
  });

  it('overwrites an older copy and leaves unused harnesses alone', async () => {
    const claude = harness('claude-code', { ours: 30 });
    const codex = harness('codex');
    const put = vi.fn(async () => ({}));
    const get = async () => ({ harness: [{ id: 'claude-code', content: JSON.stringify({ at: 20 }) }] });
    await syncOnAttach({ harnesses: [claude, codex], get, put }, ['claude-code'], []);
    expect(put).toHaveBeenCalledWith({ harness: [{ id: 'claude-code', content: JSON.stringify({ at: 30 }) }] });
  });

  it('removes a harness the user signed out of while detached, and sends nothing when nothing changed', async () => {
    const claude = harness('claude-code', { signedIn: false });
    const put = vi.fn(async () => ({}));
    const get = async () => ({ harness: [{ id: 'claude-code', content: '{}' }] });
    const out = await syncOnAttach({ harnesses: [claude], get, put }, ['claude-code'], ['claude-code']);
    expect(put).toHaveBeenCalledWith({ harness: [{ id: 'claude-code', content: null }] });
    expect(out.removed).toEqual(['claude-code']);
    // A signed-out account never adopts a container copy.
    expect(claude.adopted).toEqual([]);

    const again = vi.fn(async () => ({}));
    await syncOnAttach({ harnesses: [claude], get: async () => ({ harness: [] }), put: again }, ['claude-code'], ['claude-code']);
    expect(again).not.toHaveBeenCalled();
  });
});
