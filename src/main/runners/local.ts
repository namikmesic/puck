/**
 * Channels to This Mac's runner over its local unix socket: one connection
 * per channel, opened with the `LocalOpen` line of the runner protocol. The
 * socket is 0600 inside the runner's directory in Puck's data folder, so
 * file permissions authenticate; nothing is relayed or encrypted, and
 * This Mac stays reachable while the Puck server is down.
 *
 * Backpressure is the socket's own: `write` returns false while the kernel
 * buffer is full, and a slow consumer pauses reading until it called `done`.
 */

import * as net from 'node:net';
import { LOCAL_OPEN_MAX_BYTES, type LocalAnswer, type LocalOpen } from '../../harness/runner-protocol';
import { BaseChannel, ChannelOpenError, openErrorFor, type ByteChannel, type ChannelKind, type RunnerTransport } from './channel';

const OPEN_TIMEOUT_MS = 15_000;

class LocalChannel extends BaseChannel {
  private inFlight = 0;
  constructor(private readonly sock: net.Socket) {
    super();
    sock.on('drain', () => this.drained());
    sock.on('close', () => this.ended('runner-closed', false));
    sock.on('error', () => undefined);
  }
  protected send(data: Uint8Array): boolean {
    return this.sock.write(data);
  }
  protected teardown(): void {
    this.sock.destroy();
  }
  /** Delivers a chunk and pauses the socket until the consumer took it. */
  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.inFlight++;
    this.sock.pause();
    let settled = false;
    this.deliver(chunk, () => {
      if (settled) return;
      settled = true;
      if (--this.inFlight === 0 && !this.sock.destroyed) this.sock.resume();
    });
  }
}

/** Opens one channel on `socketPath`. */
export function openLocalChannel(socketPath: string, kind: ChannelKind, envId?: string): Promise<ByteChannel> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = Buffer.alloc(0);
    let settled = false;
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(openErrorFor('timeout')), OPEN_TIMEOUT_MS);
    sock.once('error', (err: NodeJS.ErrnoException) => {
      const down = err.code === 'ENOENT' || err.code === 'ECONNREFUSED';
      fail(new ChannelOpenError(down ? 'runner-offline' : 'local-error', down ? 'The runner on this Mac is not running.' : err.message));
    });
    sock.once('close', () => fail(new ChannelOpenError('runner-closed', 'The runner on this Mac closed the connection.')));
    sock.on('connect', () => {
      const open: LocalOpen = kind === 'attach' ? { t: 'open', kind, envId: envId ?? '' } : { t: 'open', kind: 'control' };
      sock.write(JSON.stringify(open) + '\n');
    });
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (buf.length > LOCAL_OPEN_MAX_BYTES) fail(new ChannelOpenError('bad-answer', 'The runner on this Mac answered garbage.'));
        return;
      }
      sock.off('data', onData);
      let answer: LocalAnswer;
      try {
        answer = JSON.parse(buf.subarray(0, nl).toString('utf8')) as LocalAnswer;
      } catch {
        return fail(new ChannelOpenError('bad-answer', 'The runner on this Mac answered garbage.'));
      }
      if (answer.t !== 'accept') return fail(openErrorFor(answer.t === 'close' ? String(answer.reason) : 'bad-answer'));
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners('close');
      sock.removeAllListeners('error');
      const channel = new LocalChannel(sock);
      // Bytes that followed the answer in the same read belong to the channel.
      const rest = buf.subarray(nl + 1);
      sock.on('data', (c: Buffer) => channel.push(c));
      if (rest.length) channel.push(Buffer.from(rest));
      resolve(channel);
    };
    sock.on('data', onData);
  });
}

export function localTransport(socketPath: string): RunnerTransport {
  return { kind: 'local', open: (kind, envId) => openLocalChannel(socketPath, kind, envId) };
}
