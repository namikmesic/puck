import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { acceptRunnerHandshake, MAX_PLAINTEXT_BYTES, startAppHandshake } from '../../src/channel/e2e';
import { ChannelStream } from '../../src/channel/stream';
import { decodeData, WINDOW_BYTES } from '../../src/channel/wire';

// One channel end to end without a server: an app stream and a runner
// stream joined by a wire that applies the server's credit arithmetic
// (a sender past its window, or credit nobody owed, is a violation).

function pair() {
  const key = generateKeyPairSync('ed25519');
  const jwk = key.publicKey.export({ format: 'jwk' });
  const binding = { appCh: 7, kind: 'attach' as const, envId: 'env_X' };
  const app = startAppHandshake();
  const runner = acceptRunnerHandshake(binding, app.appEphemeralPub, key.privateKey);
  const appCipher = app.finish(binding, runner.reply, String(jwk.x));

  const inFlight = { toRunner: 0, toApp: 0 };
  const violations: string[] = [];
  const received = { app: [] as Buffer[], runner: [] as Buffer[] };
  const hold = { runner: false };
  const drains = { app: 0 };
  const heldDone: (() => void)[] = [];
  const queue: (() => void)[] = [];
  const flush = async () => {
    for (let i = 0; i < 10_000 && queue.length; i++) {
      (queue.shift() as () => void)();
      await Promise.resolve();
    }
    await new Promise((r) => setImmediate(r));
    while (queue.length) {
      (queue.shift() as () => void)();
      await new Promise((r) => setImmediate(r));
    }
  };

  const appStream: ChannelStream = new ChannelStream({
    ch: 7,
    cipher: appCipher,
    transport: {
      data: (frame) => {
        const f = decodeData(frame);
        if (!f) return violations.push('bad frame');
        if (inFlight.toRunner + f.payload.length > WINDOW_BYTES) violations.push('app overran');
        inFlight.toRunner += f.payload.length;
        queue.push(() => runnerStream.receive(f));
      },
      window: (credit) => {
        if (credit > inFlight.toApp) violations.push('app over-credited');
        inFlight.toApp -= credit;
        queue.push(() => runnerStream.credit(credit));
      },
    },
    onData: (p, done) => {
      received.app.push(p);
      done();
    },
    onDrain: () => drains.app++,
    onError: (reason) => violations.push(`app: ${reason}`),
  });
  const runnerStream: ChannelStream = new ChannelStream({
    ch: 3,
    cipher: runner.cipher,
    transport: {
      data: (frame) => {
        const f = decodeData(frame);
        if (!f) return violations.push('bad frame');
        if (inFlight.toApp + f.payload.length > WINDOW_BYTES) violations.push('runner overran');
        inFlight.toApp += f.payload.length;
        queue.push(() => appStream.receive(f));
      },
      window: (credit) => {
        if (credit > inFlight.toRunner) violations.push('runner over-credited');
        inFlight.toRunner -= credit;
        queue.push(() => appStream.credit(credit));
      },
    },
    onData: (p, done) => {
      received.runner.push(p);
      if (hold.runner) heldDone.push(done);
      else done();
    },
    onError: (reason) => violations.push(`runner: ${reason}`),
  });
  return { appStream, runnerStream, received, violations, inFlight, flush, hold, heldDone, drains };
}

describe('channel stream', () => {
  it('splits large writes into frames and delivers them in order', async () => {
    const p = pair();
    const big = Buffer.alloc(MAX_PLAINTEXT_BYTES * 2 + 100, 7);
    expect(p.appStream.write(big)).toBe(true);
    p.appStream.write(Buffer.from('tail'));
    await p.flush();
    expect(p.received.runner.map((b) => b.length)).toEqual([MAX_PLAINTEXT_BYTES, MAX_PLAINTEXT_BYTES, 100, 4]);
    expect(Buffer.concat(p.received.runner).subarray(0, big.length).equals(big)).toBe(true);
    expect(p.violations).toEqual([]);
    expect(p.inFlight).toEqual({ toRunner: 0, toApp: 0 });
  });

  it('holds frames past the window until the reader consumes, then drains', async () => {
    const p = pair();
    p.hold.runner = true;
    const chunk = Buffer.alloc(MAX_PLAINTEXT_BYTES, 1);
    let accepted = true;
    for (let i = 0; i < 8; i++) accepted = p.appStream.write(chunk) && accepted;
    expect(accepted).toBe(false);
    await p.flush();
    // Only one window of ciphertext went out; nothing overran it.
    expect(p.received.runner.length).toBe(Math.floor(WINDOW_BYTES / (MAX_PLAINTEXT_BYTES + 16)));
    expect(p.appStream.pending).toBeGreaterThan(0);
    expect(p.drains.app).toBe(0);
    // The reader catches up: credit flows back and the rest is delivered.
    p.hold.runner = false;
    for (const done of p.heldDone.splice(0)) done();
    await p.flush();
    for (let i = 0; i < 5 && p.received.runner.length < 8; i++) {
      for (const done of p.heldDone.splice(0)) done();
      await p.flush();
    }
    expect(p.received.runner.length).toBe(8);
    expect(p.drains.app).toBe(1);
    expect(p.violations).toEqual([]);
  });

  it('fails the channel on a forged or replayed frame and on credit nobody owed', async () => {
    const p = pair();
    p.appStream.write(Buffer.from('one'));
    await p.flush();
    p.runnerStream.receive({ ch: 3, seq: 0n, payload: Buffer.alloc(40, 1) });
    expect(p.violations).toEqual(['runner: bad-frame']);
    expect(p.runnerStream.isClosed).toBe(true);

    const q = pair();
    q.appStream.credit(1);
    expect(q.violations).toEqual(['app: flow-control']);
  });
});
