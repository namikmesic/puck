import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../../src/harness/daemon-protocol';
import { openDaemonLink } from '../../src/puck-runner/daemon-link';

// The runner's short daemon link says hello with PROTOCOL_VERSION and opens
// once more with protocol 1 when the daemon predates it (12.3).

interface FakeChild {
  child: ChildProcessWithoutNullStreams;
  hellos: Record<string, unknown>[];
}

/** A `docker exec … attach` child whose daemon answers hello with `answer`. */
function fakeChild(answer: (hello: Record<string, unknown>) => Record<string, unknown>): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, kill: () => child.emit('close', 0) }) as unknown as ChildProcessWithoutNullStreams;
  const hellos: Record<string, unknown>[] = [];
  let buf = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (d: string) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const frame = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      buf = buf.slice(nl + 1);
      if (frame.t === 'hello') {
        hellos.push(frame);
        stdout.write(JSON.stringify(answer(frame)) + '\n');
      } else if (frame.t === 'cmd') stdout.write(JSON.stringify({ t: 'res', id: frame.id, ok: true, result: { protocol: hellos.at(-1)?.protocol } }) + '\n');
    }
  });
  return { child, hellos };
}

const welcome = (protocol: number) => ({ t: 'welcome', protocol, daemon: { version: 'v', build: 'b' }, envId: 'env_x', head: 0, replay: 'resync' });

describe('the runner’s daemon link', () => {
  it('speaks protocol 2 to a new daemon', async () => {
    const children: FakeChild[] = [];
    const link = await openDaemonLink(() => {
      const c = fakeChild((h) => welcome(h.protocol as number));
      children.push(c);
      return c.child;
    }, 'env_x', { app: 'puck-runner', build: 't' });
    expect(children).toHaveLength(1);
    expect(children[0]?.hellos[0]).toMatchObject({ protocol: PROTOCOL_VERSION, since: null });
    await expect(link.cmd('github.nudge', { repo: 'octo/app', kind: 'pull' })).resolves.toEqual({ protocol: 2 });
    link.close();
  });

  it('opens once more with protocol 1 when an old daemon refuses protocol 2, and its ops work', async () => {
    const children: FakeChild[] = [];
    const link = await openDaemonLink(() => {
      const c = fakeChild((h) => (h.protocol === 2 ? { t: 'error', code: 'protocol-mismatch', message: 'This daemon speaks protocol 1 (and 0); the client sent 2.' } : welcome(1)));
      children.push(c);
      return c.child;
    }, 'env_x', { app: 'puck-runner', build: 't' });
    expect(children.map((c) => c.hellos[0]?.protocol)).toEqual([2, 1]);
    await expect(link.cmd('github.put', { grants: [] })).resolves.toEqual({ protocol: 1 });
    link.close();
  });

  it('gives up on a daemon that refuses both', async () => {
    await expect(
      openDaemonLink(() => fakeChild(() => ({ t: 'error', code: 'protocol-mismatch', message: 'no' })).child, 'env_x', { app: 'puck-runner', build: 't' }),
    ).rejects.toMatchObject({ code: 'protocol-mismatch' });
  });
});
