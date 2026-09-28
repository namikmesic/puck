/**
 * The whole path through a real Puck server (fake GitHub, fake clock): a
 * scripted app signs in, a scripted runner registers with a registration
 * token and its own key, both connect, and they exchange end-to-end
 * encrypted channel data through the relay, flow control included. A tap on
 * every frame the server transmits proves it only ever relayed ciphertext.
 */

import type { KeyObject } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { acceptRunnerHandshake, MAX_PLAINTEXT_BYTES, startAppHandshake, type ChannelCipher } from '../../src/channel/e2e';
import { decodeData, encodeData, WINDOW_BYTES } from '../../src/channel/wire';
import {
  assertion,
  call,
  connectApp,
  runnerKeyPair,
  signIn,
  Socket,
  startServer,
  wsUrl,
  type Harness,
  type SignedIn,
} from './server-fakes';

const MARKER = 'PLAINTEXT-MARKER-7f3a';

let h: Harness;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.close();
});

/** A runner as config.sh + run.sh will behave: register, exchange, connect, answer channels. */
class ScriptedRunner {
  runnerId = '';
  accessToken = '';
  sock!: Socket;
  private key!: KeyObject;
  publicKey = '';
  private channels = new Map<number, { cipher: ChannelCipher; kind: string; envId: string | null }>();
  received: string[] = [];

  constructor(private h: Harness) {}

  async register(registrationToken: string): Promise<void> {
    const { privateKey, publicKey } = runnerKeyPair();
    this.key = privateKey;
    this.publicKey = publicKey;
    const res = await call(this.h, 'POST', '/v1/runners/register', {
      body: {
        registrationToken,
        name: 'build-box',
        labels: ['gpu'],
        os: 'linux',
        arch: 'x64',
        publicKey,
        runnerVersion: '0.1.0',
        docker: { version: '27.3.1', ncpu: 16, memTotal: 67_000_000_000 },
      },
    });
    expect(res.status).toBe(201);
    this.runnerId = String(res.body.runnerId);
  }

  async connect(): Promise<void> {
    const tok = await call(this.h, 'POST', '/v1/runners/token', {
      body: { assertion: assertion(this.runnerId, this.key, 'http://puck.test/v1/runners/token', this.h.clock.now()) },
    });
    expect(tok.status).toBe(200);
    this.accessToken = String(tok.body.accessToken);
    this.sock = new Socket(wsUrl(this.h, '/v1/runners/connect'), this.accessToken);
    await this.sock.opened();
    this.status([]);
    this.sock.ws.on('message', (data, isBinary) => {
      if (isBinary) this.onData(data as Buffer);
      else this.onControl(JSON.parse(String(data)));
    });
  }

  status(instances: { envId: string; state: string }[]): void {
    this.sock.send({
      type: 'status',
      version: '0.1.0',
      docker: { ok: true, version: '27.3.1', ncpu: 16, memTotal: 67_000_000_000 },
      maxEnvironments: null,
      instances,
    });
  }

  private onControl(frame: Record<string, unknown>): void {
    if (frame.type !== 'open') return;
    const e2e = frame.e2e as { appEphemeralPub: string };
    const binding = { appCh: Number(frame.appCh), kind: frame.kind as 'control' | 'attach', envId: (frame.envId as string | null) ?? null };
    const { reply, cipher } = acceptRunnerHandshake(binding, e2e.appEphemeralPub, this.key);
    this.channels.set(Number(frame.ch), { cipher, kind: binding.kind, envId: binding.envId });
    this.sock.send({ type: 'accept', ch: frame.ch, e2e: reply });
  }

  /** Decrypts, returns credit, and answers each message with an acknowledgement. */
  private onData(raw: Buffer): void {
    const frame = decodeData(raw);
    const ch = frame && this.channels.get(frame.ch);
    if (!frame || !ch) return;
    const text = ch.cipher.open(frame.seq, frame.payload).toString('utf8');
    this.sock.send({ type: 'window', ch: frame.ch, credit: frame.payload.length });
    this.received.push(text);
    if (text.startsWith('bulk:')) return;
    const answer = ch.cipher.seal(Buffer.from(`ack ${ch.kind} ${ch.envId}: ${text}`));
    this.sock.sendBinary(encodeData(frame.ch, answer.seq, answer.ciphertext));
  }

  async githubTokens(envId: string) {
    return call(this.h, 'POST', `/v1/runners/instances/${envId}/github-token`, { token: this.accessToken });
  }
}

/** The app's side of one channel: handshake, credit-respecting sends, decrypting receives. */
class AppChannel {
  private cipher!: ChannelCipher;
  private credit = WINDOW_BYTES;
  private creditWaiters: (() => void)[] = [];

  constructor(
    private sock: Socket,
    readonly ch: number,
  ) {}

  async open(runnerId: string, runnerPublicKey: string, kind: 'control' | 'attach', envId: string | null): Promise<void> {
    const hs = startAppHandshake();
    this.sock.send({ type: 'open', ch: this.ch, runnerId, kind, ...(envId ? { envId } : {}), e2e: { appEphemeralPub: hs.appEphemeralPub } });
    const accept = await this.sock.next('accept');
    expect(accept.ch).toBe(this.ch);
    this.cipher = hs.finish({ appCh: this.ch, kind, envId }, accept.e2e as { runnerEphemeralPub: string; sig: string }, runnerPublicKey);
    this.sock.ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const f = JSON.parse(String(data));
      if (f.type === 'window' && f.ch === this.ch) {
        this.credit += f.credit;
        for (const w of this.creditWaiters.splice(0)) w();
      }
    });
  }

  async send(text: string | Buffer): Promise<void> {
    const sealed = this.cipher.seal(typeof text === 'string' ? Buffer.from(text) : text);
    while (this.credit < sealed.ciphertext.length) await new Promise<void>((r) => this.creditWaiters.push(r));
    this.credit -= sealed.ciphertext.length;
    this.sock.sendBinary(encodeData(this.ch, sealed.seq, sealed.ciphertext));
  }

  async receive(): Promise<string> {
    const frame = decodeData(await this.sock.nextBinary()) as { ch: number; seq: bigint; payload: Buffer };
    expect(frame.ch).toBe(this.ch);
    const text = this.cipher.open(frame.seq, frame.payload).toString('utf8');
    this.sock.send({ type: 'window', ch: this.ch, credit: frame.payload.length });
    return text;
  }
}

/** Records every frame the server's own sockets transmit. */
function tapServerFrames(): Buffer[] {
  const seen: Buffer[] = [];
  const original = WebSocket.prototype.send;
  vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, data: unknown, ...rest: unknown[]) {
    if ((this as unknown as { _isServer: boolean })._isServer) seen.push(Buffer.from(data as Buffer | string));
    return (original as (...a: unknown[]) => void).call(this, data, ...rest);
  });
  return seen;
}

describe('Puck server integration', () => {
  it('a scripted runner and app register, connect and exchange encrypted channel data through the relay', async () => {
    h = await startServer();
    const serverFrames = tapServerFrames();
    h.github.addUser('namik');
    h.github.addRepo('namik/web', { pushers: ['namik'], installationId: 7 });

    // The app signs in with GitHub's web flow and asks for a registration token.
    const session: SignedIn = await signIn(h, 'namik');
    const events = await connectApp(h, session.accessToken);
    const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: session.accessToken });

    // The runner registers with it, exchanges a signed assertion, connects and reports status.
    const runner = new ScriptedRunner(h);
    await runner.register(String(reg.body.token));
    const registered = await events.next('event');
    expect(registered.event).toMatchObject({ type: 'runner.upsert', runner: { id: runner.runnerId, status: 'offline' } });
    await runner.connect();
    const online = await events.next('event');
    expect(online.event).toMatchObject({ type: 'runner.upsert', runner: { id: runner.runnerId, status: 'idle', labels: ['linux', 'x64', 'gpu'] } });

    // The app lists runners (with the key it will verify) and records an environment on this one.
    const listed = (await call(h, 'GET', '/v1/runners', { token: session.accessToken })).body.runners as { id: string; publicKey: string }[];
    expect(listed[0].publicKey).toBe(runner.publicKey);
    const created = await call(h, 'POST', '/v1/instances', {
      token: session.accessToken,
      body: { runnerId: runner.runnerId, definition: 'web', repos: ['namik/web'] },
    });
    expect(created.status).toBe(201);
    const envId = String(created.body.envId);
    runner.status([{ envId, state: 'running' }]);
    const upserts = [await events.next('event'), await events.next('event')].map((e) => e.event as { type: string; runner?: { status: string } });
    expect(upserts).toContainEqual(expect.objectContaining({ type: 'runner.upsert', runner: expect.objectContaining({ status: 'active' }) }));

    // The runner pumps GitHub tokens for the environment it hosts.
    const tokens = await runner.githubTokens(envId);
    expect(tokens.status).toBe(200);
    expect((tokens.body.grants as { repos: string[] }[])[0].repos).toEqual(['namik/web']);

    // Control and attach channels, each end-to-end encrypted.
    const control = new AppChannel(events, 1);
    await control.open(runner.runnerId, listed[0].publicKey, 'control', null);
    await control.send(`runner.info ${MARKER}`);
    expect(await control.receive()).toBe(`ack control null: runner.info ${MARKER}`);

    const attach = new AppChannel(events, 2);
    await attach.open(runner.runnerId, listed[0].publicKey, 'attach', envId);
    await attach.send(`hello puckd ${MARKER}`);
    expect(await attach.receive()).toBe(`ack attach ${envId}: hello puckd ${MARKER}`);

    // One MiB through a 256 KiB window: the sender waits for credit and nothing is lost.
    const chunk = Buffer.alloc(MAX_PLAINTEXT_BYTES, 0x61);
    chunk.write(`bulk:${MARKER}`);
    for (let i = 0; i < 17; i++) await attach.send(chunk);
    await vi.waitFor(() => expect(runner.received.filter((t) => t.startsWith('bulk:'))).toHaveLength(17), { timeout: 5000 });
    expect(h.server.relay.inFlight(session.userId, 2)?.toRunner).toBeLessThanOrEqual(WINDOW_BYTES);

    // The relay never saw plaintext: not in anything it sent, logged or audited.
    const everything = Buffer.concat(serverFrames);
    expect(everything.includes(Buffer.from(MARKER))).toBe(false);
    expect(serverFrames.length).toBeGreaterThan(20);
    expect(h.logs.join('\n')).not.toContain(MARKER);
    expect(JSON.stringify(await h.server.ctx.store.listAudit(session.userId, 500))).not.toContain(MARKER);
    expect(h.logs.join('\n')).not.toContain(String(tokens.body.grants && (tokens.body.grants as { token: string }[])[0].token));

    // Sign-out closes the app's socket; the runner is told its channels ended.
    await call(h, 'POST', '/v1/auth/logout', { token: session.accessToken });
    expect((await events.waitClosed()).code).toBe(4401);
    expect(await runner.sock.next('close')).toMatchObject({ reason: 'app-gone' });
    runner.sock.close();
  });
});
