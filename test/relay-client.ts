/**
 * The app's side of the relay, as the tests need it (the desktop app's own
 * client comes later): one `/v1/app/connect` socket, channels opened to a
 * runner with the end-to-end handshake verified against the runner's
 * listed key, and two speakers on top of a channel:
 *
 * - `ControlClient`: the runner control protocol (cmd / res / event lines);
 * - `DaemonClient`: the daemon protocol through an attach channel.
 *
 * Both unit tests (an in-process runner) and the Docker suite (a real
 * runner process and real containers) use it.
 */

import WebSocket from 'ws';
import { startAppHandshake } from '../src/channel/e2e';
import { ChannelStream } from '../src/channel/stream';
import { decodeData, type ChannelKind } from '../src/channel/wire';
import type { DaemonEvent, DaemonFrame } from '../src/harness/daemon-protocol';
import type { ControlEvent, ControlRunnerFrame } from '../src/harness/runner-protocol';

export class AppChannel {
  private readonly lineWaiters: (() => void)[] = [];
  private buf = '';
  readonly lines: string[] = [];
  closed: string | null = null;
  stream!: ChannelStream;

  constructor(
    readonly relay: RelayApp,
    readonly ch: number,
  ) {}

  onBytes(data: Buffer): void {
    this.buf += data.toString('utf8');
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.lines.push(line);
    }
    this.wake();
  }

  wake(): void {
    for (const w of this.lineWaiters.splice(0)) w();
  }

  write(text: string | Buffer): void {
    this.stream.write(typeof text === 'string' ? Buffer.from(text, 'utf8') : text);
  }

  /** Waits for a line matching `pred` (lines stay in `lines`). */
  async until<T>(pick: (lines: string[]) => T | undefined, what: string, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const got = pick(this.lines);
      if (got !== undefined) return got;
      if (this.closed) throw new Error(`channel closed (${this.closed}) while waiting for ${what}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last lines: ${this.lines.slice(-5).join(' | ').slice(0, 1500)}`);
      await new Promise<void>((r) => {
        this.lineWaiters.push(r);
        setTimeout(r, 100);
      });
    }
  }

  close(reason = 'app-closed'): void {
    if (this.closed) return;
    this.closed = reason;
    this.stream.close();
    this.relay.send({ type: 'close', ch: this.ch, reason });
    this.relay.forget(this.ch);
  }
}

export class RelayApp {
  readonly ws: WebSocket;
  private readonly channels = new Map<number, AppChannel>();
  private readonly accepts = new Map<number, (f: Record<string, unknown>) => void>();
  private nextCh = 1;
  readonly events: Record<string, unknown>[] = [];

  private constructor(url: string, token: string) {
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const f = decodeData(data as Buffer);
        if (f) this.channels.get(f.ch)?.stream.receive(f);
        return;
      }
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      const ch = typeof frame.ch === 'number' ? frame.ch : -1;
      if (frame.type === 'accept' || (frame.type === 'close' && this.accepts.has(ch))) {
        this.accepts.get(ch)?.(frame);
        this.accepts.delete(ch);
      } else if (frame.type === 'window') {
        this.channels.get(ch)?.stream.credit(Number(frame.credit));
      } else if (frame.type === 'close') {
        const c = this.channels.get(ch);
        if (c) {
          c.closed = String(frame.reason);
          c.stream.close();
          this.channels.delete(ch);
          c.wake();
        }
      } else if (frame.type === 'event') {
        this.events.push(frame.event as Record<string, unknown>);
      }
    });
  }

  static async connect(baseUrl: string, accessToken: string): Promise<RelayApp> {
    const app = new RelayApp(baseUrl.replace(/^http/, 'ws') + '/v1/app/connect', accessToken);
    await new Promise<void>((resolve, reject) => {
      app.ws.once('open', () => resolve());
      app.ws.once('error', reject);
      app.ws.once('unexpected-response', (_q, res) => reject(new Error(`app socket refused: ${res.statusCode}`)));
    });
    return app;
  }

  send(frame: object): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  forget(ch: number): void {
    this.channels.delete(ch);
  }

  /**
   * Opens a channel and verifies the runner's signed handshake; rejects with
   * the close reason. The channel is installed in the same tick the `accept`
   * arrives: the runner's first data frame can follow in the same socket
   * read, before any awaiting code would run.
   */
  open(runnerId: string, runnerPublicKey: string, kind: ChannelKind, envId: string | null = null): Promise<AppChannel> {
    const ch = this.nextCh++;
    const hs = startAppHandshake();
    const channel = new AppChannel(this, ch);
    return new Promise<AppChannel>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.accepts.delete(ch);
        reject(new Error('no answer to open'));
      }, 30_000);
      this.accepts.set(ch, (frame) => {
        clearTimeout(timer);
        if (frame.type === 'close') return reject(new Error(`channel refused: ${String(frame.reason)}`));
        let cipher;
        try {
          cipher = hs.finish({ appCh: ch, kind, envId }, frame.e2e as { runnerEphemeralPub: string; sig: string }, runnerPublicKey);
        } catch (err) {
          return reject(err);
        }
        channel.stream = new ChannelStream({
          ch,
          cipher,
          transport: {
            data: (buf) => {
              if (this.ws.readyState === WebSocket.OPEN) this.ws.send(buf);
            },
            window: (credit) => this.send({ type: 'window', ch, credit }),
          },
          onData: (plaintext, done) => {
            channel.onBytes(plaintext);
            done();
          },
          onError: (reason) => channel.close(reason),
        });
        this.channels.set(ch, channel);
        resolve(channel);
      });
      this.send({ type: 'open', ch, runnerId, kind, ...(envId ? { envId } : {}), e2e: { appEphemeralPub: hs.appEphemeralPub } });
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** The runner control protocol over a control channel. */
export class ControlClient {
  private n = 0;
  constructor(readonly channel: AppChannel) {}

  frames(): ControlRunnerFrame[] {
    return this.channel.lines.map((l) => JSON.parse(l) as ControlRunnerFrame);
  }

  events(): ControlEvent[] {
    return this.frames().flatMap((f) => (f.t === 'event' ? [f.ev] : []));
  }

  welcome(): Promise<Extract<ControlRunnerFrame, { t: 'welcome' }>> {
    return this.channel.until(
      () => this.frames().find((f): f is Extract<ControlRunnerFrame, { t: 'welcome' }> => f.t === 'welcome'),
      'welcome',
    );
  }

  /** Sends one command; resolves with the result or rejects with `code: message`. */
  async cmd<R = unknown>(op: string, args: unknown = {}, ms = 180_000): Promise<R> {
    const id = `a${++this.n}`;
    this.channel.write(JSON.stringify({ t: 'cmd', id, op, args }) + '\n');
    const res = await this.channel.until(
      () => this.frames().find((f): f is Extract<ControlRunnerFrame, { t: 'res' }> => f.t === 'res' && f.id === id),
      `result of ${op}`,
      ms,
    );
    if (!res.ok) throw new Error(`${op} failed: ${res.error.code}: ${res.error.message}`);
    return res.result as R;
  }
}

type EventFrame = Extract<DaemonFrame, { t: 'event' }>;

/** The daemon protocol over an attach channel. */
export class DaemonClient {
  private n = 0;
  constructor(readonly channel: AppChannel) {}

  frames(): DaemonFrame[] {
    return this.channel.lines.map((l) => JSON.parse(l) as DaemonFrame);
  }

  events(): EventFrame[] {
    return this.frames().filter((f): f is EventFrame => f.t === 'event');
  }

  hello(since: number | null): Promise<Extract<DaemonFrame, { t: 'welcome' }>> {
    this.channel.write(JSON.stringify({ t: 'hello', protocol: 1, client: { app: 'relay-test', build: 'test' }, since }) + '\n');
    return this.channel.until(() => this.frames().find((f): f is Extract<DaemonFrame, { t: 'welcome' }> => f.t === 'welcome'), 'welcome');
  }

  async cmd<R = unknown>(op: string, args: unknown = {}): Promise<R> {
    const id = `d${++this.n}`;
    this.channel.write(JSON.stringify({ t: 'cmd', id, op, args }) + '\n');
    const res = await this.channel.until(
      () => this.frames().find((f): f is Extract<DaemonFrame, { t: 'res' }> => f.t === 'res' && f.id === id),
      `result of ${op}`,
    );
    if (!res.ok) throw new Error(`${op} failed: ${res.error.code}: ${res.error.message}`);
    return res.result as R;
  }

  untilEvent<K extends DaemonEvent['kind']>(kind: K, pred: (ev: Extract<DaemonEvent, { kind: K }>) => boolean = () => true, ms = 120_000): Promise<EventFrame> {
    return this.channel.until(
      () => this.events().find((f) => f.ev.kind === kind && pred(f.ev as Extract<DaemonEvent, { kind: K }>)),
      `event ${kind}`,
      ms,
    );
  }
}
