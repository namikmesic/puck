/**
 * The dev-only fixture harness: its seeded world covers every item state
 * and the chat states worth a screenshot, its item commands follow the
 * daemon's state machine, and the renderer only reaches it outside a
 * production build.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRANSITIONS } from '../../src/daemon/items';
import type { DaemonEventPayload } from '../../src/harness/bridge';
import { buildWorld, ENV_ID, FIXTURE_MOVES, ORCH } from '../../src/renderer/fixture/data';
import { fixtureBridge, fixtureScenario } from '../../src/renderer/fixture';

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

  it('moves items only along the daemon’s transitions', () => {
    for (const [trigger, move] of Object.entries(FIXTURE_MOVES)) {
      for (const from of move.from) {
        expect(TRANSITIONS.some((t) => t.trigger === trigger && t.from.includes(from) && t.to === move.to), `${trigger} from ${from}`).toBe(true);
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

  it('is reachable only outside a production build', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer.ts'), 'utf8');
    const at = src.indexOf("import('./renderer/fixture')");
    const guard = src.lastIndexOf("if (process.env.NODE_ENV !== 'production'", at);
    expect(at).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(0);
    expect(src.slice(guard, at)).not.toContain('}');
    expect(src.match(/renderer\/fixture/g)).toHaveLength(2);
  });
});
