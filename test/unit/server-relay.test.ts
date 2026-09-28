import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeData, encodeData, MAX_CIPHERTEXT_BYTES, WINDOW_BYTES } from '../../src/channel/wire';
import { ACCESS_TTL_MS } from '../../src/server/auth';
import { hashSecret } from '../../src/server/ids';
import {
  call,
  connectApp,
  connectRunner,
  registerRunner,
  signIn,
  Socket,
  startServer,
  wsUrl,
  type Harness,
} from './server-fakes';

let h: Harness;
let sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets) s.close();
  sockets = [];
  await h?.close();
});

const pub = () => randomBytes(32).toString('base64url');

async function setup() {
  h = await startServer();
  h.github.addUser('namik');
  h.github.addRepo('namik/web', { pushers: ['namik'] });
  const s = await signIn(h, 'namik');
  const r = await registerRunner(h, s);
  const app = await connectApp(h, s.accessToken);
  const runner = await connectRunner(h, r.accessToken);
  sockets.push(runner, app);
  await app.next('event'); // runner.upsert from the hello
  return { s, r, runner, app };
}

/** Opens and accepts a channel; returns the runner-side number. */
async function openChannel(app: Socket, runner: Socket, runnerId: string, ch: number, extra: Record<string, unknown> = {}) {
  app.send({ type: 'open', ch, runnerId, kind: 'control', e2e: { appEphemeralPub: pub() }, ...extra });
  const open = await runner.next('open');
  runner.send({ type: 'accept', ch: open.ch, e2e: { runnerEphemeralPub: pub(), sig: 'c2ln' } });
  const accept = await app.next('accept');
  expect(accept.ch).toBe(ch);
  return { rch: Number(open.ch), open };
}

describe('channels', () => {
  it('routes an open to the runner with the app’s number, and data both ways readdressed', async () => {
    const { s, r, runner, app } = await setup();
    const { rch, open } = await openChannel(app, runner, r.runnerId, 42);
    expect(open).toMatchObject({ appCh: 42, kind: 'control', envId: null, userId: s.userId });

    app.sendBinary(encodeData(42, 0n, Buffer.from('up')));
    const up = decodeData(await runner.nextBinary());
    expect(up).toEqual({ ch: rch, seq: 0n, payload: Buffer.from('up') });
    runner.sendBinary(encodeData(rch, 5n, Buffer.from('down')));
    const down = decodeData(await app.nextBinary());
    expect(down).toEqual({ ch: 42, seq: 5n, payload: Buffer.from('down') });
  });

  it('keeps two apps on one runner apart', async () => {
    const { s, r, runner, app } = await setup();
    const app2 = await connectApp(h, s.accessToken);
    sockets.push(app2);
    const a = await openChannel(app, runner, r.runnerId, 1);
    const b = await openChannel(app2, runner, r.runnerId, 1);
    expect(a.rch).not.toBe(b.rch);
    runner.sendBinary(encodeData(b.rch, 0n, Buffer.from('for-b')));
    expect(decodeData(await app2.nextBinary())?.payload.toString()).toBe('for-b');
    expect(app.pendingBinaries()).toBe(0);
  });

  it('refuses channels the user may not open', async () => {
    const { s, r, runner, app } = await setup();
    h.github.addUser('mallory');
    const m = await signIn(h, 'mallory');
    const mApp = await connectApp(h, m.accessToken);
    sockets.push(mApp);
    mApp.send({ type: 'open', ch: 1, runnerId: r.runnerId, kind: 'control', e2e: { appEphemeralPub: pub() } });
    expect(await mApp.next('close')).toMatchObject({ ch: 1, reason: 'not-found' });

    // attach needs an active environment of this user on this runner
    app.send({ type: 'open', ch: 2, runnerId: r.runnerId, kind: 'attach', envId: 'env_missing', e2e: { appEphemeralPub: pub() } });
    expect(await app.next('close')).toMatchObject({ ch: 2, reason: 'not-found' });
    app.send({ type: 'open', ch: 3, runnerId: r.runnerId, kind: 'attach', e2e: { appEphemeralPub: pub() } });
    expect(await app.next('close')).toMatchObject({ ch: 3, reason: 'bad-open' });
    app.send({ type: 'open', ch: 4, runnerId: r.runnerId, kind: 'control', e2e: { appEphemeralPub: 'nope' } });
    expect(await app.next('close')).toMatchObject({ ch: 4, reason: 'bad-open' });

    const other = await registerRunner(h, s, { name: 'other' });
    const inst = await call(h, 'POST', '/v1/instances', {
      token: s.accessToken,
      body: { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] },
    });
    app.send({ type: 'open', ch: 5, runnerId: other.runnerId, kind: 'attach', envId: inst.body.envId, e2e: { appEphemeralPub: pub() } });
    expect(await app.next('close')).toMatchObject({ ch: 5, reason: 'not-found' });
    app.send({ type: 'open', ch: 6, runnerId: r.runnerId, kind: 'attach', envId: inst.body.envId, e2e: { appEphemeralPub: pub() } });
    expect(await runner.next('open')).toMatchObject({ kind: 'attach', envId: inst.body.envId });
  });

  it('answers runner-offline when the runner has no socket, and refuses a number in use', async () => {
    const { s, r, runner, app } = await setup();
    const other = await registerRunner(h, s, { name: 'other' });
    app.send({ type: 'open', ch: 1, runnerId: other.runnerId, kind: 'control', e2e: { appEphemeralPub: pub() } });
    expect(await app.next('close')).toMatchObject({ reason: 'runner-offline' });
    await openChannel(app, runner, r.runnerId, 2);
    app.send({ type: 'open', ch: 2, runnerId: r.runnerId, kind: 'control', e2e: { appEphemeralPub: pub() } });
    expect(await app.next('close')).toMatchObject({ ch: 2, reason: 'channel-in-use' });
  });

  it('drops data sent before the runner accepts', async () => {
    const { r, runner, app } = await setup();
    app.send({ type: 'open', ch: 1, runnerId: r.runnerId, kind: 'control', e2e: { appEphemeralPub: pub() } });
    await runner.next('open');
    app.sendBinary(encodeData(1, 0n, Buffer.from('early')));
    await runner.nextBinary(200).catch(() => undefined);
    expect(runner.pendingBinaries()).toBe(0);
  });

  it('closes a channel the runner never accepts after 30 s', async () => {
    const { r, runner, app } = await setup();
    app.send({ type: 'open', ch: 1, runnerId: r.runnerId, kind: 'control', e2e: { appEphemeralPub: pub() } });
    const open = await runner.next('open');
    h.clock.advance(30_000);
    expect(await app.next('close')).toMatchObject({ ch: 1, reason: 'open-timeout' });
    expect(await runner.next('close')).toMatchObject({ ch: open.ch, reason: 'open-timeout' });
  });

  it('closes both ends when either side goes away', async () => {
    const { s, r, runner, app } = await setup();
    const { rch } = await openChannel(app, runner, r.runnerId, 1);
    app.send({ type: 'close', ch: 1, reason: 'done' });
    expect(await runner.next('close')).toMatchObject({ ch: rch, reason: 'done' });

    const second = await openChannel(app, runner, r.runnerId, 2);
    app.close();
    expect(await runner.next('close')).toMatchObject({ ch: second.rch, reason: 'app-gone' });

    const app2 = await connectApp(h, s.accessToken);
    sockets.push(app2);
    await openChannel(app2, runner, r.runnerId, 3);
    runner.close();
    expect(await app2.next('close')).toMatchObject({ ch: 3, reason: 'runner-offline' });
  });
});

describe('flow control', () => {
  const full = () => randomBytes(MAX_CIPHERTEXT_BYTES);

  it('holds at most one window in flight per direction, and closes a sender that overruns it', async () => {
    const { s, r, runner, app } = await setup();
    const { rch } = await openChannel(app, runner, r.runnerId, 1);
    const frames = WINDOW_BYTES / MAX_CIPHERTEXT_BYTES;
    for (let i = 0; i < frames; i++) app.sendBinary(encodeData(1, BigInt(i), full()));
    for (let i = 0; i < frames; i++) await runner.nextBinary();
    expect(h.server.relay.inFlight(s.userId, 1)).toEqual({ toRunner: WINDOW_BYTES, toApp: 0 });

    // The runner consumed one frame and returns its credit: exactly one more fits.
    runner.send({ type: 'window', ch: rch, credit: MAX_CIPHERTEXT_BYTES });
    expect(await app.next('window')).toMatchObject({ ch: 1, credit: MAX_CIPHERTEXT_BYTES });
    app.sendBinary(encodeData(1, BigInt(frames), full()));
    await runner.nextBinary();
    expect(h.server.relay.inFlight(s.userId, 1)?.toRunner).toBe(WINDOW_BYTES);

    app.sendBinary(encodeData(1, BigInt(frames + 1), full()));
    expect(await app.next('close')).toMatchObject({ ch: 1, reason: 'flow-control' });
    expect(await runner.next('close')).toMatchObject({ reason: 'flow-control' });
    expect(h.server.relay.inFlight(s.userId, 1)).toBeNull();
  });

  it('closes a channel whose receiver returns credit it was never owed', async () => {
    const { r, runner, app } = await setup();
    const { rch } = await openChannel(app, runner, r.runnerId, 1);
    runner.sendBinary(encodeData(rch, 0n, Buffer.alloc(100)));
    await app.nextBinary();
    app.send({ type: 'window', ch: 1, credit: 101 });
    expect(await app.next('close')).toMatchObject({ reason: 'flow-control' });
  });
});

describe('sockets', () => {
  it('refuses upgrades without the right kind of token', async () => {
    const { s, r } = await setup();
    const tries: [string, string][] = [
      ['/v1/runners/connect', s.accessToken],
      ['/v1/app/connect', r.accessToken],
      ['/v1/app/connect', 'PSA_' + 'x'.repeat(43)],
    ];
    for (const [path, token] of tries) {
      const sock = new Socket(wsUrl(h, path), token);
      await expect(sock.opened()).rejects.toThrow(/401/);
    }
    const nowhere = new Socket(wsUrl(h, '/v1/nope'), s.accessToken);
    await expect(nowhere.opened()).rejects.toThrow(/404/);
  });

  it('closes a session’s app sockets at sign-out', async () => {
    const { s, app } = await setup();
    await call(h, 'POST', '/v1/auth/logout', { token: s.accessToken });
    expect(await app.waitClosed()).toMatchObject({ code: 4401, reason: 'signed-out' });
  });

  it('replaces a runner’s older socket when it reconnects', async () => {
    const { r, runner } = await setup();
    const again = await connectRunner(h, r.accessToken);
    sockets.push(again);
    expect((await runner.waitClosed()).code).toBe(4409);
  });

  it('refuses an outdated runner at hello', async () => {
    h = await startServer({ PUCK_RUNNER_MIN_VERSION: '0.1.0' });
    h.github.addUser('namik');
    const s = await signIn(h, 'namik');
    const r = await registerRunner(h, s);
    const sock = await connectRunner(h, r.accessToken, { version: '0.0.9' });
    sockets.push(sock);
    expect(await sock.waitClosed()).toMatchObject({ code: 4426, reason: 'runner-outdated' });
  });

  it('closes an app socket when the access token that opened it expires', async () => {
    const { s, app } = await setup();
    h.clock.advance(10 * 60_000);
    const fresh = await call(h, 'POST', '/v1/auth/token', {
      body: { grant_type: 'refresh_token', refresh_token: s.refreshToken },
    });
    expect(fresh.status).toBe(200);
    expect((await call(h, 'GET', '/v1/me', { token: s.accessToken })).status).toBe(401);
    app.send({ type: 'ping', t: 1 });
    expect(await app.next('pong')).toMatchObject({ t: 1 });
    h.clock.advance(ACCESS_TTL_MS - 10 * 60_000);
    expect(await app.waitClosed()).toMatchObject({ code: 4401, reason: 'token-expired' });
    expect((await call(h, 'GET', '/v1/me', { token: String(fresh.body.accessToken) })).status).toBe(200);
  });

  it('extends an app socket when the same session presents a fresh access token', async () => {
    const { s, r, runner, app } = await setup();
    const { rch } = await openChannel(app, runner, r.runnerId, 1);
    const beat = async (ms: number) => {
      let left = ms;
      while (left > 0) {
        const step = Math.min(left, 50_000);
        h.clock.advance(step);
        left -= step;
        runner.send({ type: 'ping', t: left });
        await runner.next('pong');
      }
    };
    await beat(10 * 60_000);
    const fresh = await call(h, 'POST', '/v1/auth/token', {
      body: { grant_type: 'refresh_token', refresh_token: s.refreshToken },
    });
    app.send({ type: 'auth', token: String(fresh.body.accessToken) });
    await app.sync();
    await beat(6 * 60_000);
    app.sendBinary(encodeData(1, 0n, Buffer.from('still')));
    expect(decodeData(await runner.nextBinary())).toEqual({ ch: rch, seq: 0n, payload: Buffer.from('still') });
    h.clock.advance(ACCESS_TTL_MS - 6 * 60_000);
    expect(await app.waitClosed()).toMatchObject({ code: 4401, reason: 'token-expired' });
  });

  it('closes an app socket whose auth frame is for another session or is invalid', async () => {
    const { s, app } = await setup();
    h.github.addUser('mallory');
    const m = await signIn(h, 'mallory');
    app.send({ type: 'auth', token: m.accessToken });
    expect(await app.waitClosed()).toMatchObject({ code: 4401, reason: 'token-expired' });

    const other = await connectApp(h, s.accessToken);
    sockets.push(other);
    other.send({ type: 'auth', token: `PSA_${'x'.repeat(43)}` });
    expect(await other.waitClosed()).toMatchObject({ code: 4401, reason: 'token-expired' });
  });

  it('closes an app socket on the sweep after its session is revoked', async () => {
    const { s, app } = await setup();
    const session = await h.server.ctx.store.sessionByAccess(hashSecret(s.accessToken));
    await h.server.ctx.store.revokeSession(session!.id, h.clock.now());
    h.clock.advance(5_000);
    expect(await app.waitClosed()).toMatchObject({ code: 4401, reason: 'signed-out' });
  });

  it('answers pings', async () => {
    const { app, runner } = await setup();
    app.send({ type: 'ping', t: 1 });
    expect(await app.next('pong')).toMatchObject({ t: 1 });
    runner.send({ type: 'ping', t: 2 });
    expect(await runner.next('pong')).toMatchObject({ t: 2 });
  });
});
