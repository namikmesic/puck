/**
 * The dev-only fixture harness: its seeded world covers every place of
 * the three columns and the chat states worth a screenshot, and its ticket
 * commands follow the daemon's ticket table.
 */

import { describe, expect, it } from 'vitest';
import { nextTicket, type TicketState, type TicketTrigger } from '../../src/harness/item-transitions';
import type { DaemonEventPayload, PuckBridge } from '../../src/harness/bridge';
import type { WorkItem } from '../../src/harness/daemon-protocol';
import { statusV1 } from '../../src/harness/workflow';
import { buildWorld, ENV_ID, ORCH } from '../../src/renderer/fixture/data';
import { fixtureBridge, fixtureScenario } from '../../src/renderer/fixture';

const COMMANDS = ['assign', 'unassign', 'cancel', 'accept', 'retry', 'delete'] as const;

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
  it('seeds every place, a failed ticket, a question for you and a mixed-routing ticket, several repositories and a multi-day chat', () => {
    const { snapshot, transcripts } = buildWorld('full', new Date(2026, 8, 29, 15, 0).getTime());
    expect(new Set(snapshot.items.map((i) => i.status))).toEqual(new Set(['todo', 'in-progress', 'done']));
    expect(new Set(snapshot.items.map((i) => statusV1(i)))).toEqual(new Set(['backlog', 'queued', 'running', 'needs-input', 'review', 'done', 'failed', 'cancelled']));
    expect(new Set(snapshot.items.map((i) => i.outcome).filter(Boolean))).toEqual(new Set(['merged', 'accepted', 'failed', 'cancelled']));
    expect(snapshot.items.some((i) => i.userAsks > 0 && i.needsInput?.routedTo === 'orchestrator')).toBe(true);
    expect(snapshot.decisions).toEqual([]);
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
        const state: TicketState = { status: it.status, outcome: it.outcome };
        let expected: TicketState | 'removed' | Error;
        if (command === 'assign' || command === 'unassign') {
          expected = it.status === 'todo' ? state : new Error('only a ticket in Todo is assigned');
        } else {
          try {
            expected = nextTicket(state, command as TicketTrigger, !!it.sessionId);
          } catch (err) {
            expected = err instanceof Error ? err : new Error(String(err));
          }
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
        expect({ status: updated.status, outcome: updated.outcome }, `${command} from ${it.status}`).toEqual(expected);
      }
    }
  });

  it('streams item changes back like the daemon', async () => {
    const bridge = fixtureBridge('full');
    const seen: DaemonEventPayload[] = [];
    bridge.onDaemonEvent((e) => seen.push(e));
    await bridge.daemon(ENV_ID, 'item.assign', { itemId: 'itm_09', agent: 'implementer' });
    const ev = seen.at(-1);
    expect(ev && 'ev' in ev && ev.ev.kind === 'item.upsert' && statusV1(ev.ev.item)).toBe('queued');
    await expect(bridge.daemon(ENV_ID, 'item.delete', { itemId: 'itm_03' })).rejects.toThrow('Cannot delete a ticket that is in progress.');
    await expect(bridge.githubRepos()).rejects.toThrow('not available in the fixture harness');
    expect(fixtureScenario('#fixture=empty')).toBe('empty');
    expect(fixtureScenario('#fixture=nonsense')).toBe('full');
  });
});
