/**
 * The app's daemon client against a scripted channel: the handshake,
 * `events` versus `resync` (live events held until the snapshot lands),
 * duplicates skipped by seq, unknown kinds advancing the cursor, the idle
 * timeout and backoff, commands failing on a drop, and a protocol mismatch
 * stopping for good.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonEvent, Snapshot } from '../../src/harness/daemon-protocol';
import { DaemonClient, type AttachState } from '../../src/main/instances/daemon-client';
import { BaseChannel, type ByteChannel } from '../../src/main/runners/channel';
import { createInstanceStore } from '../../src/renderer/instance-store';
import { ENV, snap } from './v2-fixtures';

class ScriptedChannel extends BaseChannel {
  readonly sent: Record<string, unknown>[] = [];
  onFrame: (f: Record<string, unknown>) => void = () => undefined;
  protected send(data: Uint8Array): boolean {
    for (const line of Buffer.from(data).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const f = JSON.parse(line) as Record<string, unknown>;
      this.sent.push(f);
      queueMicrotask(() => this.onFrame(f));
    }
    return true;
  }
  protected teardown(): void {
    /* nothing to release */
  }
  frame(f: unknown): void {
    this.deliver(Buffer.from(JSON.stringify(f) + '\n'), () => undefined);
  }
  drop(reason = 'daemon-closed'): void {
    this.ended(reason, false);
  }
}

const running: DaemonClient[] = [];
afterEach(() => {
  for (const c of running.splice(0)) c.stop();
});

const until = async (ok: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

const welcome = (replay: 'events' | 'resync', head = 0, protocol = 1) => ({
  t: 'welcome',
  protocol,
  daemon: { version: 'v', build: 'b' },
  envId: 'env_x',
  head,
  replay,
});
const ev = (seq: number, ev: unknown) => ({ t: 'event', seq, at: 1, ev });
const status: DaemonEvent = { kind: 'instance.status', status: 'ready' };

function setup(since: number | null, opts: { idleMs?: number; open?: () => Promise<ByteChannel> } = {}) {
  const channels: ScriptedChannel[] = [];
  const cursor = { seq: since };
  const events: { seq: number; ev: DaemonEvent }[] = [];
  const snapshots: Snapshot[] = [];
  const states: [AttachState, string][] = [];
  const client = new DaemonClient({
    envId: 'env_x',
    open:
      opts.open ??
      (async () => {
        const c = new ScriptedChannel();
        channels.push(c);
        return c;
      }),
    since: () => cursor.seq,
    saveSeq: (s) => (cursor.seq = s),
    onEvent: (seq, _at, e) => events.push({ seq, ev: e }),
    onSnapshot: (s) => snapshots.push(s),
    onState: (s, d) => states.push([s, d]),
    client: { app: 'puck', build: 't' },
    timing: { pingMs: 10, idleMs: opts.idleMs ?? 10_000, backoffMs: [5, 10] },
  });
  running.push(client);
  return { client, channels, cursor, events, snapshots, states };
}

describe('daemon client', () => {
  it.each(['events', 'resync'] as const)('finishes a daemon update on restart with %s reattachment', async (replay) => {
    const store = createInstanceStore({ requestResync: () => undefined });
    store.reset(ENV);
    store.applySnapshot(snap(), ENV);
    const channels: ScriptedChannel[] = [];
    const snapshots: Snapshot[] = [];
    const welcomes: unknown[] = [];
    const updated = { version: '0.1.0+new', build: 'new', protocol: 1 };
    const client = new DaemonClient({
      envId: ENV,
      open: async () => {
        const c = new ScriptedChannel();
        channels.push(c);
        c.onFrame = (f) => {
          if (f.op === 'snapshot.get') c.frame({ t: 'res', id: f.id, ok: true, result: snap({ head: 13, daemon: updated }) });
        };
        return c;
      },
      since: () => store.cursor(),
      saveSeq: () => undefined,
      onEvent: (seq, _at, event) => store.applyEvent(seq, event, ENV),
      onSnapshot: (s) => { snapshots.push(s); store.applySnapshot(s, ENV); },
      onWelcome: (daemon, head) => {
        welcomes.push(daemon);
        store.applyWelcome(daemon, head, ENV);
      },
      onState: () => undefined,
      client: { app: 'puck', build: 't' },
      timing: { backoffMs: [5], pingMs: 10_000 },
    });
    running.push(client);
    client.start();
    await until(() => channels.length === 1);
    channels[0].frame({ ...welcome('events', 10), daemon: snap().daemon });
    channels[0].frame(ev(11, { kind: 'daemon.upgrading', mode: 'now' }));
    expect(store.state()?.upgrading).toBe('now');
    channels[0].drop(); // Upgrade restarts the process; the app retains its projection.
    await until(() => channels.length === 2);
    expect(channels[1].sent[0]).toMatchObject({ t: 'hello', since: 11 });
    channels[1].frame({ ...welcome(replay, 13), daemon: updated });
    if (replay === 'events') {
      channels[1].frame(ev(12, { kind: 'instance.status', status: 'starting' }));
      channels[1].frame(ev(13, status));
    } else await until(() => snapshots.length === 1);
    expect(welcomes.at(-1)).toMatchObject(updated);
    expect(snapshots).toHaveLength(replay === 'resync' ? 1 : 0);
    expect(store.state()?.instance.status).toBe('ready');
    expect(store.state()?.upgrading).toBeNull();
    expect(store.state()?.daemon).toEqual(updated);
  });

  it('says hello with its cursor in the same tick the channel opens, then replays later events once', async () => {
    const { client, channels, cursor, events } = setup(5);
    client.start();
    await until(() => channels.length === 1 && channels[0].sent.length > 0);
    const c = channels[0];
    expect(c.sent[0]).toEqual({ t: 'hello', protocol: 2, client: { app: 'puck', build: 't' }, since: 5 });
    c.frame(welcome('events', 8));
    c.frame(ev(5, status)); // overlap: already applied
    c.frame(ev(6, status));
    c.frame(ev(7, { kind: 'from-the-future', x: 1 })); // unknown: skipped, cursor still moves
    c.frame(ev(8, status));
    c.frame(ev(8, status)); // duplicate
    expect(client.attachState).toBe('attached');
    expect(events.map((e) => e.seq)).toEqual([6, 8]);
    expect(cursor.seq).toBe(8);
  });

  it('on resync reads the snapshot and holds live events until it lands', async () => {
    const { client, channels, cursor, events, snapshots } = setup(null);
    client.start();
    await until(() => channels.length === 1);
    const c = channels[0];
    c.onFrame = (f) => {
      if (f.op === 'snapshot.get') {
        c.frame(ev(11, status)); // arrives before the snapshot answer
        c.frame({ t: 'res', id: f.id, ok: true, result: { head: 10, instance: { status: 'ready' } } });
      }
    };
    c.frame(welcome('resync', 10));
    await until(() => snapshots.length === 1 && events.length === 1);
    expect(snapshots[0].head).toBe(10);
    expect(events.map((e) => e.seq)).toEqual([11]);
    expect(cursor.seq).toBe(11);
  });

  it('commands round-trip, and fail with not-ready when the connection drops', async () => {
    const { client, channels } = setup(0);
    await expect(client.cmd('chat.send', { text: 'x' })).rejects.toThrow(/not attached/);
    client.start();
    await until(() => channels.length === 1);
    const c = channels[0];
    c.frame(welcome('events'));
    c.onFrame = (f) => {
      if (f.op === 'chat.send') c.frame({ t: 'res', id: f.id, ok: true, result: { queued: true } });
      if (f.op === 'item.accept') c.frame({ t: 'res', id: f.id, ok: false, error: { code: 'invalid-state', message: 'not in review' } });
    };
    expect(await client.cmd('chat.send', { text: 'hi' })).toEqual({ queued: true });
    await expect(client.cmd('item.accept', { itemId: 'i' })).rejects.toMatchObject({ code: 'invalid-state' });
    c.onFrame = () => undefined;
    const pending = client.cmd('chat.send', { text: 'lost' });
    c.drop();
    await expect(pending).rejects.toMatchObject({ code: 'not-ready' });
  });

  it('reconnects with backoff after a drop, resuming from the cursor', async () => {
    const { client, channels, states } = setup(3);
    client.start();
    await until(() => channels.length === 1);
    channels[0].frame(welcome('events'));
    channels[0].frame(ev(4, status));
    channels[0].drop();
    await until(() => channels.length === 2 && channels[1].sent.length > 0);
    expect(channels[1].sent[0]).toMatchObject({ t: 'hello', since: 4 });
    expect(states.map((s) => s[0])).toContain('reconnecting');
  });

  it('pings, and closes a channel that stays silent past the idle limit', async () => {
    const { client, channels } = setup(0, { idleMs: 30 });
    client.start();
    await until(() => channels.length === 1);
    channels[0].frame(welcome('events'));
    await until(() => channels[0].sent.some((f) => f.t === 'ping'));
    await until(() => channels[0].closedReason === 'idle');
    await until(() => channels.length === 2);
  });

  it('reports unreachable while the runner cannot be reached, and keeps trying', async () => {
    let tries = 0;
    const { client, states } = setup(0, {
      open: async () => {
        tries++;
        throw new Error('The runner is offline.');
      },
    });
    client.start();
    await until(() => tries >= 3);
    expect(states.filter((s) => s[0] === 'unreachable')[0]).toEqual(['unreachable', 'The runner is offline.']);
  });

  it('stops for good on a protocol mismatch', async () => {
    const { client, channels, states } = setup(0);
    client.start();
    await until(() => channels.length === 1);
    channels[0].frame(welcome('events', 0, 3));
    expect(client.attachState).toBe('incompatible');
    expect(states.at(-1)?.[1]).toMatch(/update Puck/);
    await new Promise((r) => setTimeout(r, 40));
    expect(channels).toHaveLength(1);
  });

  it('detaching closes the channel and never reconnects', async () => {
    const { client, channels } = setup(0);
    client.start();
    await until(() => channels.length === 1);
    channels[0].frame(welcome('events'));
    client.stop();
    expect(channels[0].closedReason).toBe('detached');
    await new Promise((r) => setTimeout(r, 40));
    expect(channels).toHaveLength(1);
    expect(client.attachState).toBe('detached');
  });
});
