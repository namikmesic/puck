/**
 * The transport seam between the app and a runner: one `ByteChannel` per
 * logical stream (a `control` channel, or an `attach` channel to one
 * environment's daemon), whatever carries it.
 *
 * - Through the Puck server's relay (server/connection.ts), end-to-end
 *   encrypted with the runner's key (src/channel).
 * - To This Mac's runner over its local unix socket (local.ts), where file
 *   permissions authenticate and nothing leaves the machine.
 *
 * Flow control is the consumer's `done`: a chunk counts against the
 * sender's window until the consumer took it, so a slow reader holds the
 * runner back instead of growing a buffer here. `write` returns false while
 * the peer has no room; `onDrain` says when to continue.
 *
 * `lines` turns a channel into NDJSON frames, which both the runner control
 * protocol and the daemon protocol use.
 */

import { StringDecoder } from 'node:string_decoder';

export interface ByteChannel {
  /** Queues bytes; false means wait for `onDrain` before writing more. */
  write(data: Uint8Array): boolean;
  /** Closes the channel; `onClose` fires with `reason`. Idempotent. */
  close(reason?: string): void;
  /** Receives every chunk in order; call `done` once it was consumed. Chunks that arrived earlier are delivered at once. */
  onData(cb: (chunk: Buffer, done: () => void) => void): void;
  onDrain(cb: () => void): void;
  /** Fires once, when either end closed the channel. */
  onClose(cb: (reason: string) => void): void;
  readonly closedReason: string | null;
}

export type ChannelKind = 'control' | 'attach';

/** Opens channels to one runner. */
export interface RunnerTransport {
  readonly kind: 'relay' | 'local';
  open(kind: ChannelKind, envId?: string): Promise<ByteChannel>;
}

/** Why a channel could not open, in words for the user. */
export class ChannelOpenError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelOpenError';
  }
}

const REASONS: Record<string, string> = {
  'runner-offline': 'The runner is offline.',
  'not-found': 'The environment has no container on its runner.',
  'not-running': 'The environment is stopped.',
  'docker-unavailable': 'Docker is not responding on the runner.',
  'not-owner': 'That runner is not yours.',
  'instance-not-found': 'The Puck server does not know this environment on that runner.',
  'too-many-channels': 'Too many channels are open to the Puck server.',
  timeout: 'The runner did not answer.',
};

export function openErrorFor(reason: string): ChannelOpenError {
  return new ChannelOpenError(reason, REASONS[reason] ?? `The runner refused the channel (${reason}).`);
}

/**
 * The shared half of every channel: buffering until a consumer attaches,
 * and exactly one close notification. Transports supply `send` and
 * `teardown` and call `deliver`, `drained` and `ended`.
 */
export abstract class BaseChannel implements ByteChannel {
  private dataCb: ((chunk: Buffer, done: () => void) => void) | null = null;
  private drainCb: (() => void) | null = null;
  private closeCbs: ((reason: string) => void)[] = [];
  private early: { chunk: Buffer; done: () => void }[] = [];
  closedReason: string | null = null;

  protected abstract send(data: Uint8Array): boolean;
  /** Releases the transport; `tell` is false when the peer closed first. */
  protected abstract teardown(reason: string, tell: boolean): void;

  write(data: Uint8Array): boolean {
    if (this.closedReason !== null) return false;
    return this.send(data);
  }

  close(reason = 'app-closed'): void {
    if (this.closedReason !== null) return;
    this.ended(reason, true);
  }

  onData(cb: (chunk: Buffer, done: () => void) => void): void {
    this.dataCb = cb;
    for (const e of this.early.splice(0)) cb(e.chunk, e.done);
  }

  onDrain(cb: () => void): void {
    this.drainCb = cb;
  }

  onClose(cb: (reason: string) => void): void {
    if (this.closedReason !== null) cb(this.closedReason);
    else this.closeCbs.push(cb);
  }

  protected deliver(chunk: Buffer, done: () => void): void {
    if (this.closedReason !== null) return;
    if (this.dataCb) this.dataCb(chunk, done);
    else this.early.push({ chunk, done });
  }

  protected drained(): void {
    this.drainCb?.();
  }

  /** The channel ended; `tell` asks the transport to tell the peer. */
  protected ended(reason: string, tell: boolean): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    this.early = [];
    this.teardown(reason, tell);
    for (const cb of this.closeCbs.splice(0)) cb(reason);
  }
}

/**
 * NDJSON over a channel: `onLine` gets each complete line. A line longer
 * than `maxBytes` closes the channel with `frame-too-large`.
 */
export function lines(channel: ByteChannel, maxBytes: number, onLine: (line: string) => void): { send(frame: unknown): boolean } {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  channel.onData((chunk, done) => {
    buf += decoder.write(chunk);
    done();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
      if (channel.closedReason !== null) return;
    }
    if (buf.length > maxBytes) channel.close('frame-too-large');
  });
  return { send: (frame) => channel.write(Buffer.from(JSON.stringify(frame) + '\n', 'utf8')) };
}
