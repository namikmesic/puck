/**
 * The dev-only fixture harness: its seeded world covers every item state
 * and the chat states worth a screenshot, and its item commands follow the
 * daemon's state machine.
 */

import { describe, expect, it } from 'vitest';
import { nextStatus, type ItemTrigger } from '../../src/harness/item-transitions';
import type { DaemonEventPayload, PuckBridge } from '../../src/harness/bridge';
import type { ItemStatus, WorkItem } from '../../src/harness/daemon-protocol';
import { buildWorld, ENV_ID, ORCH } from '../../src/renderer/fixture/data';
import { fixtureBridge, fixtureScenario } from '../../src/renderer/fixture';

const COMMANDS = ['assign', 'unassign', 'cancel', 'accept', 'retry', 'delete'] as const satisfies readonly ItemTrigger[];

async function runCommand(bridge: PuckBridge, itemId: string, command: (typeof COMMANDS)[number]): Promise<unknown> {
  switch (command) {
    case 'assign':
      return bridge.daemon(ENV_ID, 'item.assign', { itemId, agent: 'implementer' });
    case 'unassign':
      return bridge.daemon(ENV_ID, 'item.assign', { itemId, agent: null });
    case 'cancel':
      return bridge.daemon(ENV_ID, 'item.cancel', { itemId });
    case 'accept':
      return bridge.daemon(ENV_ID, 'item.accept', { itemId });
    case 'retry':
      return bridge.daemon(ENV_ID, 'item.retry', { itemId });
    case 'delete':
      return bridge.daemon(ENV_ID, 'item.delete', { itemId });
  }
}

describe('fixture harness', () => {
  it('seeds every item state, several repositories and a multi-day chat', () => {
    const { snapshot, transcripts } = buildWorld('full', new Date(2026, 8, 29, 15, 0).getTime());
    expect(new Set(snapshot.items.map((i) => i.status))).toEqual(new Set(['backlog', 'queued', 'running', 'needs-input', 'review', 'done', 'failed', 'cancelled']));
    expect(new Set(snapshot.items.map((i) => i.repo).filter(Boolean))).toEqual(new Set(['web', 'api']));
    expect(snapshot.repos).toHaveLength(2);
    const log = transcripts.get(ORCH) ?? [];
    const days = new Set(log.map((e) => new Date(e.ts).toDateString()));
    expect(days.size).toBeGreaterThanOrEqual(3);
    const events = log.flatMap((e) => (e.kind === 'turn' ? e.events : []));
    expect(events.some((e) => e.kind === 'tool-start')).toBe(true);
    expect(events.some((e) => e.kind === 'ask' && e.answers)).toBe(true);
    expect(snapshot.asks.some((a) => a.sessionId === ORCH)).toBe(true);
    expect(log.some((e) => e.kind === 'notice')).toBe(true);
    expect(buildWorld('empty').snapshot.items).toEqual([]);
  });

  it('moves items only along the daemon’s transitions', async () => {
    const items = buildWorld('full', new Date(2026, 8, 29, 15, 0).getTime()).snapshot.items;
    for (const it of items) {
      for (const command of COMMANDS) {
        const bridge = fixtureBridge('full');
        let expected: ItemStatus | 'removed' | Error;
        try {
          expected = nextStatus(it.status, command);
        } catch (err) {
          expected = err instanceof Error ? err : new Error(String(err));
        }
        if (expected instanceof Error) {
          await expect(runCommand(bridge, it.id, command), `${command} from ${it.status}`).rejects.toThrow(expected.message);
          continue;
        }
        if (expected === 'removed') {
          await runCommand(bridge, it.id, command);
          const after = await bridge.daemon(ENV_ID, 'snapshot.get', {});
          expect(after.items.some((item) => item.id === it.id), `${command} from ${it.status}`).toBe(false);
          continue;
        }
        const updated = (await runCommand(bridge, it.id, command)) as WorkItem;
        expect(updated.status, `${command} from ${it.status}`).toBe(expected);
      }
    }
  });

  it('streams item changes back like the daemon', async () => {
    const bridge = fixtureBridge('full');
    const seen: DaemonEventPayload[] = [];
    bridge.onDaemonEvent((e) => seen.push(e));
    await bridge.daemon(ENV_ID, 'item.assign', { itemId: 'itm_09', agent: 'implementer' });
    const ev = seen.at(-1);
    expect(ev && 'ev' in ev && ev.ev.kind === 'item.upsert' && ev.ev.item.status).toBe('queued');
    await expect(bridge.daemon(ENV_ID, 'item.delete', { itemId: 'itm_03' })).rejects.toThrow('Cannot delete an item that is running.');
    await expect(bridge.githubRepos()).rejects.toThrow('not available in the fixture harness');
    expect(fixtureScenario('#fixture=empty')).toBe('empty');
    expect(fixtureScenario('#fixture=nonsense')).toBe('full');
  });
});
