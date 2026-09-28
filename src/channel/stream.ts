/**
 * One relay channel as a byte stream, for either end (the runner today, the
 * app later): encryption with the channel's cipher (e2e.ts), framing into
 * data frames of at most MAX_PLAINTEXT_BYTES, and the credit arithmetic of
 * wire.ts, which the Puck server enforces.
 *
 * Sending: `write` seals the bytes in order and queues the frames; a frame
 * goes out only while the peer's credit covers its ciphertext. `write`
 * returns false while frames wait for credit, and `onDrain` fires when the
 * queue empties, so a producer (a `docker exec`'s stdout) can pause.
 *
 * Receiving: `receive` opens a frame and hands the plaintext to `onData`
 * with a `done` callback. Credit for exactly that frame's ciphertext goes
 * back to the peer once `done` runs, batched per tick, so a slow consumer
 * (a child's stdin) holds the peer back instead of growing a buffer here.
 * A forged, repeated or reordered frame fails the channel.
 */

import { MAX_PLAINTEXT_BYTES, type ChannelCipher } from './e2e';
import { encodeData, WINDOW_BYTES, type DataFrame } from './wire';

export interface ChannelTransport {
  /** Sends one binary data frame on the relay socket. */
  data(frame: Buffer): void;
  /** Sends `window { ch, credit }`. */
  window(credit: number): void;
}

export interface ChannelStreamOptions {
  /** This end's number for the channel (the one on its own socket). */
  ch: number;
  cipher: ChannelCipher;
  transport: ChannelTransport;
  onData(plaintext: Buffer, done: () => void): void;
  /** The send queue emptied after `write` returned false. */
  onDrain?(): void;
  /** The channel failed (bad frame, credit violation); the owner closes it. */
  onError(reason: string): void;
  windowBytes?: number;
}

export class ChannelStream {
  private readonly queue: { frame: Buffer; cost: number }[] = [];
  private sendCredit: number;
  private owed = 0;
  private flushScheduled = false;
  private closed = false;
  private blocked = false;
  /** Received ciphertext bytes not yet credited back (handed to onData, `done` not yet called). */
  private held = 0;
  private readonly windowBytes: number;

  constructor(private readonly opts: ChannelStreamOptions) {
    this.windowBytes = opts.windowBytes ?? WINDOW_BYTES;
    this.sendCredit = this.windowBytes;
  }

  /** Queues bytes; false means the caller should wait for `onDrain`. */
  write(data: Uint8Array): boolean {
    if (this.closed) return false;
    for (let at = 0; at < data.length; at += MAX_PLAINTEXT_BYTES) {
      const { seq, ciphertext } = this.opts.cipher.seal(data.subarray(at, Math.min(at + MAX_PLAINTEXT_BYTES, data.length)));
      this.queue.push({ frame: encodeData(this.opts.ch, seq, ciphertext), cost: ciphertext.length });
    }
    this.pump();
    if (this.queue.length) this.blocked = true;
    return this.queue.length === 0;
  }

  /** Bytes sealed and waiting for credit. */
  get pending(): number {
    return this.queue.reduce((n, q) => n + q.cost, 0);
  }

  /** The peer returned credit (`window`). */
  credit(n: number): void {
    if (this.closed) return;
    if (!Number.isInteger(n) || n <= 0 || this.sendCredit + n > this.windowBytes) {
      return this.fail('flow-control');
    }
    this.sendCredit += n;
    this.pump();
  }

  /** A data frame for this channel arrived. */
  receive(frame: DataFrame): void {
    if (this.closed) return;
    const cost = frame.payload.length;
    if (this.held + cost > this.windowBytes) return this.fail('flow-control');
    let plaintext: Buffer;
    try {
      plaintext = this.opts.cipher.open(frame.seq, frame.payload);
    } catch {
      return this.fail('bad-frame');
    }
    this.held += cost;
    let settled = false;
    this.opts.onData(plaintext, () => {
      if (settled || this.closed) return;
      settled = true;
      this.held -= cost;
      this.owed += cost;
      this.scheduleCredit();
    });
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private pump(): void {
    while (this.queue.length && this.queue[0].cost <= this.sendCredit) {
      const next = this.queue.shift() as { frame: Buffer; cost: number };
      this.sendCredit -= next.cost;
      this.opts.transport.data(next.frame);
    }
    if (!this.queue.length && this.blocked) {
      this.blocked = false;
      this.opts.onDrain?.();
    }
  }

  private scheduleCredit(): void {
    // Return credit promptly once a quarter window is owed; otherwise batch per tick.
    if (this.owed >= this.windowBytes / 4) return this.flushCredit();
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flushCredit());
  }

  private flushCredit(): void {
    this.flushScheduled = false;
    if (this.closed || this.owed <= 0) return;
    const n = this.owed;
    this.owed = 0;
    this.opts.transport.window(n);
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.close();
    this.opts.onError(reason);
  }
}
