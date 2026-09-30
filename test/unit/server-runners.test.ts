import { afterEach, describe, expect, it } from 'vitest';
import { keyFingerprint } from '../../src/channel/wire';
import { signAssertion } from '../../src/puck-runner/identity';
import { NameTakenError } from '../../src/server/store';
import {
  assertion,
  call,
  connectApp,
  connectRunner,
  registerRunner,
  runnerKeyPair,
  signIn,
  startServer,
  type Harness,
  type SignedIn,
} from './server-fakes';

const TOKEN_AUD = 'http://puck.test/v1/runners/token';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

async function setup(overrides: Record<string, string> = {}): Promise<SignedIn> {
  h = await startServer(overrides);
  h.github.addUser('namik');
  return signIn(h, 'namik');
}

async function register(session: SignedIn, token: string, body: Record<string, unknown> = {}) {
  const { publicKey, privateKey } = runnerKeyPair();
  const res = await call(h, 'POST', '/v1/runners/register', {
    body: { registrationToken: token, name: 'build-box', os: 'linux', arch: 'x64', publicKey, runnerVersion: '0.1.0', ...body },
  });
  return { res, publicKey, privateKey };
}

describe('registration tokens', () => {
  it('registers several runners within the hour, none after it', async () => {
    const s = await setup();
    const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: s.accessToken });
    expect(reg.status).toBe(201);
    expect(reg.body.token).toMatch(/^PRT_[A-Za-z0-9]{43}$/);
    expect(reg.body.expiresAt).toBe(h.clock.now() + 60 * 60_000);
    expect((await register(s, String(reg.body.token), { name: 'a' })).res.status).toBe(201);
    h.clock.advance(59 * 60_000);
    expect((await register(s, String(reg.body.token), { name: 'b' })).res.status).toBe(201);
    h.clock.advance(60_000);
    const late = await register(s, String(reg.body.token), { name: 'c' });
    expect(late.res.status).toBe(401);
    expect(late.res.body.error).toBe('invalid-token');
  });

  it('can be revoked, and only by its owner', async () => {
    const s = await setup();
    h.github.addUser('mallory');
    const other = await signIn(h, 'mallory');
    const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: s.accessToken });
    expect((await call(h, 'DELETE', `/v1/runners/registration-token/${reg.body.id}`, { token: other.accessToken })).status).toBe(404);
    expect((await call(h, 'DELETE', `/v1/runners/registration-token/${reg.body.id}`, { token: s.accessToken })).status).toBe(204);
    expect((await register(s, String(reg.body.token))).res.status).toBe(401);
  });

  it('never accepts a removal token for registration', async () => {
    const s = await setup();
    const rm = await call(h, 'POST', '/v1/runners/removal-token', { token: s.accessToken });
    expect((await register(s, String(rm.body.token))).res.status).toBe(401);
  });

  it('is stored hashed', async () => {
    const s = await setup();
    const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: s.accessToken });
    const audit = JSON.stringify(await h.server.ctx.store.listAudit(s.userId, 50));
    expect(audit).not.toContain(String(reg.body.token));
    expect(h.logs.join('')).not.toContain(String(reg.body.token));
  });
});

describe('register', () => {
  it('records the runner with default labels and its key fingerprint', async () => {
    const s = await setup();
    const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: s.accessToken });
    const { res, publicKey } = await register(s, String(reg.body.token), { labels: ['gpu', 'linux'], maxEnvironments: 3 });
    expect(res.body).toMatchObject({
      name: 'build-box',
      labels: ['linux', 'x64', 'gpu'],
      fingerprint: keyFingerprint(publicKey),
      owner: { login: 'namik' },
      serverUrl: 'http://puck.test',
    });
    expect(res.body.runnerId).toMatch(/^rnr_[0-9A-Z]{26}$/);
    const list = await call(h, 'GET', '/v1/runners', { token: s.accessToken });
    expect(list.body.runners).toEqual([expect.objectContaining({ name: 'build-box', status: 'offline', maxEnvironments: 3 })]);
  });

  it.each([
    [{ os: 'windows' }, 'unsupported-platform'],
    [{ arch: 'ia32' }, 'unsupported-platform'],
    [{ publicKey: 'nope' }, 'invalid-key'],
    [{ name: '' }, 'invalid-body'],
    [{ name: '../etc' }, 'invalid-name'],
    [{ labels: ['Bad Label'] }, 'invalid-labels'],
    [{ runnerVersion: 'latest' }, 'invalid-body'],
    [{ maxEnvironments: 0 }, 'invalid-body'],
  ])('refuses %j', async (body, code) => {
    const s = await setup();
    const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: s.accessToken });
    const { res } = await register(s, String(reg.body.token), body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBe(code);
  });

  it('refuses a taken name unless replacing, which revokes the old runner and moves its environments', async () => {
    const s = await setup();
    h.github.addRepo('namik/web', { pushers: ['namik'] });
    const old = await registerRunner(h, s);
    const sock = await connectRunner(h, old.accessToken);
    const inst = await call(h, 'POST', '/v1/instances', {
      token: s.accessToken,
      body: { runnerId: old.runnerId, definition: 'web', repos: ['namik/web'] },
    });
    expect(inst.status).toBe(201);

    const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: s.accessToken });
    expect((await register(s, String(reg.body.token))).res.body.error).toBe('name-taken');
    const again = await register(s, String(reg.body.token), { replace: true });
    expect(again.res.status).toBe(201);
    expect((await sock.waitClosed()).code).toBe(4403);
    const moved = await call(h, 'GET', `/v1/instances/${inst.body.envId}`, { token: s.accessToken });
    expect((moved.body.instance as { runnerId: string }).runnerId).toBe(again.res.body.runnerId);
    const oldToken = await call(h, 'POST', '/v1/runners/token', {
      body: { assertion: assertion(old.runnerId, old.privateKey, TOKEN_AUD, h.clock.now()) },
    });
    expect(oldToken.body.error).toBe('runner-removed');
  });

  it('answers name-taken when two registers claim one name together', async () => {
    const s = await setup();
    const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: s.accessToken });
    const token = String(reg.body.token);
    const [a, b] = await Promise.all([register(s, token), register(s, token)]);
    expect([a.res.status, b.res.status].sort((x, y) => x - y)).toEqual([201, 409]);
    expect([a, b].find((r) => r.res.status === 409)?.res.body.error).toBe('name-taken');
    const list = await call(h, 'GET', '/v1/runners', { token: s.accessToken });
    expect(list.body.runners).toHaveLength(1);
  });

  it('keeps the old runner and its environments when a replace cannot claim the name', async () => {
    const s = await setup();
    h.github.addRepo('namik/web', { pushers: ['namik'] });
    await registerRunner(h, s, { name: 'kept' });
    const old = await registerRunner(h, s, { name: 'old' });
    const sock = await connectRunner(h, old.accessToken);
    const inst = await call(h, 'POST', '/v1/instances', {
      token: s.accessToken,
      body: { runnerId: old.runnerId, definition: 'web', repos: ['namik/web'] },
    });
    expect(inst.status).toBe(201);
    const current = await h.server.ctx.store.getRunner(old.runnerId);
    if (!current) throw new Error('runner missing');
    await expect(
      h.server.ctx.store.replaceRunner(
        old.runnerId,
        {
          id: 'rnr_does_not_land',
          userId: s.userId,
          name: 'kept',
          labels: current.labels,
          os: current.os,
          arch: current.arch,
          publicKey: current.publicKey,
          fingerprint: current.fingerprint,
          version: current.version,
          maxEnvironments: current.maxEnvironments,
          docker: current.docker,
          createdAt: h.clock.now(),
        },
        h.clock.now(),
      ),
    ).rejects.toBeInstanceOf(NameTakenError);
    sock.close();
    const again = await connectRunner(h, old.accessToken);
    again.close();
    const moved = await call(h, 'GET', `/v1/instances/${String(inst.body.envId)}`, { token: s.accessToken });
    expect(moved.body.instance).toMatchObject({ runnerId: old.runnerId, status: 'active' });
    expect(await h.server.ctx.store.getRunner('rnr_does_not_land')).toBeNull();
    expect((await h.server.ctx.store.listRunners(s.userId)).map((r) => r.name).sort()).toEqual(['kept', 'old']);
  });

  it('refuses runners older than the minimum version', async () => {
    const s = await setup({ PUCK_RUNNER_MIN_VERSION: '0.2.0' });
    const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: s.accessToken });
    const { res } = await register(s, String(reg.body.token));
    expect(res.status).toBe(426);
    expect(res.body).toMatchObject({ error: 'runner-outdated', minVersion: '0.2.0' });
  });
});

describe('token exchange by signed assertion', () => {
  async function registered(version = '0.1.0') {
    const s = await setup();
    const reg = await call(h, 'POST', '/v1/runners/registration-token', { token: s.accessToken });
    const r = await register(s, String(reg.body.token), { runnerVersion: version });
    return { s, runnerId: String(r.res.body.runnerId), privateKey: r.privateKey };
  }

  const exchange = (a: string) => call(h, 'POST', '/v1/runners/token', { body: { assertion: a } });

  it('issues a one-hour runner token that opens the runner socket', async () => {
    const { runnerId, privateKey } = await registered();
    const res = await exchange(assertion(runnerId, privateKey, TOKEN_AUD, h.clock.now()));
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toMatch(/^PRA_/);
    expect(res.body.expiresAt).toBe(h.clock.now() + 60 * 60_000);
    const sock = await connectRunner(h, String(res.body.accessToken));
    sock.close();
    h.clock.advance(60 * 60_000);
    await expect(connectRunner(h, String(res.body.accessToken))).rejects.toThrow(/401/);
  });

  it('lets an updated runner reconnect after the floor rises, recording its version only on hello', async () => {
    const { s, runnerId, privateKey } = await registered();
    h.server.ctx.config.minRunnerVersion = '0.2.0';
    const res = await exchange(signAssertion(runnerId, privateKey, TOKEN_AUD, h.clock.now(), '0.2.0'));
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toMatch(/^PRA_/);
    expect((await h.server.ctx.store.getRunner(runnerId))?.version).toBe('0.1.0');

    const app = await connectApp(h, s.accessToken);
    const sock = await connectRunner(h, String(res.body.accessToken), { version: '0.2.0' });
    expect((await app.next('event')).event).toMatchObject({ type: 'runner.upsert', runner: { version: '0.2.0' } });
    expect((await h.server.ctx.store.getRunner(runnerId))?.version).toBe('0.2.0');
    expect((await exchange(assertion(runnerId, privateKey, TOKEN_AUD, h.clock.now()))).status).toBe(200);
    sock.close();
    app.close();
  });

  it.each([undefined, '0.1.0'])('refuses an old stored or signed version after the floor rises (ver=%s)', async (ver) => {
    const { runnerId, privateKey } = await registered();
    h.server.ctx.config.minRunnerVersion = '0.2.0';
    const res = await exchange(assertion(runnerId, privateKey, TOKEN_AUD, h.clock.now(), { ver }));
    expect(res.status).toBe(426);
    expect(res.body).toMatchObject({ error: 'runner-outdated', minVersion: '0.2.0' });
    expect((await h.server.ctx.store.getRunner(runnerId))?.version).toBe('0.1.0');
  });

  it('checks a signed version even when the stored version satisfies the floor', async () => {
    const { runnerId, privateKey } = await registered('0.2.0');
    h.server.ctx.config.minRunnerVersion = '0.2.0';
    const res = await exchange(assertion(runnerId, privateKey, TOKEN_AUD, h.clock.now(), { ver: '0.1.0' }));
    expect(res.status).toBe(426);
    expect(res.body).toMatchObject({ error: 'runner-outdated', minVersion: '0.2.0' });
    expect((await h.server.ctx.store.getRunner(runnerId))?.version).toBe('0.2.0');
  });

  it.each([null, 200, false, {}, [], '', '0.2', '0.2.0+build', '0.2.0\n', '0.2.0-' + 'a'.repeat(64)].map((ver) => [ver]))(
    'refuses a present malformed version claim (%j)',
    async (ver) => {
      const { runnerId, privateKey } = await registered();
      const res = await exchange(assertion(runnerId, privateKey, TOKEN_AUD, h.clock.now(), { ver }));
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ error: 'invalid-assertion' });
    },
  );

  it('refuses a version claim changed after signing', async () => {
    const { runnerId, privateKey } = await registered();
    h.server.ctx.config.minRunnerVersion = '0.2.0';
    const [head, body, sig] = assertion(runnerId, privateKey, TOKEN_AUD, h.clock.now(), { ver: '0.1.0' }).split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    claims.ver = '0.2.0';
    const tampered = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const res = await exchange(`${head}.${tampered}.${sig}`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'invalid-assertion', message: expect.stringContaining('bad signature') });
  });

  it.each([undefined, '0.2.0'])('refuses a bad signature, audience, lifetime, expiry or a replayed jti (ver=%s)', async (ver) => {
    const { runnerId, privateKey } = await registered();
    const now = h.clock.now();
    const other = runnerKeyPair().privateKey;
    const cases: [string, RegExp][] = [
      [assertion(runnerId, other, TOKEN_AUD, now, { ver }), /bad signature/],
      [assertion(runnerId, privateKey, 'http://elsewhere/v1/runners/token', now, { ver }), /audience/],
      [assertion(runnerId, privateKey, TOKEN_AUD, now, { ver, exp: Math.floor(now / 1000) + 3600 }), /five minutes/],
      [assertion(runnerId, privateKey, TOKEN_AUD, now - 10 * 60_000, { ver }), /expired/],
      [assertion(runnerId, privateKey, TOKEN_AUD, now, { ver, sub: 'rnr_other' }), /iss and sub/],
      [assertion('rnr_nope', privateKey, TOKEN_AUD, now, { ver }), /unknown runner/],
      ['a.b', /not a JWT/],
    ];
    for (const [a, why] of cases) {
      const res = await exchange(a);
      expect(res.status).toBe(401);
      expect(String(res.body.message)).toMatch(why);
    }
    const once = assertion(runnerId, privateKey, TOKEN_AUD, now, { ver, jti: 'same' });
    expect((await exchange(once)).status).toBe(200);
    const replay = await exchange(once);
    expect(replay.status).toBe(401);
    expect(String(replay.body.message)).toMatch(/already used/);
  });
});

describe('status', () => {
  it('goes Idle on connect, Active while hosting a running environment, Offline 60 s after the last frame', async () => {
    const s = await setup();
    const r = await registerRunner(h, s);
    const app = await connectApp(h, s.accessToken);
    const runner = await connectRunner(h, r.accessToken);
    const idle = await app.next('event');
    expect(idle.event).toMatchObject({ type: 'runner.upsert', runner: { status: 'idle', running: 0, docker: { version: '27.3.1' } } });

    runner.send({
      type: 'status',
      version: '0.1.0',
      docker: { ok: true, version: '27.3.1', ncpu: 16, memTotal: 1 },
      maxEnvironments: null,
      instances: [{ envId: 'env_1', state: 'running' }, { envId: 'env_2', state: 'exited' }],
    });
    const active = await app.next('event');
    expect(active.event).toMatchObject({ runner: { status: 'active', running: 1 } });

    // Quiet for 59 s: still Active; one more second: Offline, pushed once.
    h.clock.advance(59_000);
    const mid = await call(h, 'GET', `/v1/runners/${r.runnerId}`, { token: s.accessToken });
    expect((mid.body.runner as { status: string }).status).toBe('active');
    h.clock.advance(1_000);
    const offline = await app.next('event');
    expect(offline.event).toMatchObject({ runner: { status: 'offline' } });
    runner.close();
    app.close();
  });

  it('counts WebSocket pings as frames', async () => {
    const s = await setup();
    const r = await registerRunner(h, s);
    const runner = await connectRunner(h, r.accessToken);
    h.clock.advance(50_000);
    await new Promise((resolve) => {
      runner.ws.once('pong', resolve);
      runner.ws.ping();
    });
    h.clock.advance(20_000);
    const got = await call(h, 'GET', `/v1/runners/${r.runnerId}`, { token: s.accessToken });
    expect((got.body.runner as { status: string }).status).toBe('idle');
    runner.close();
  });

  it('reports a Docker problem alongside the status', async () => {
    const s = await setup();
    const r = await registerRunner(h, s);
    const runner = await connectRunner(h, r.accessToken, {
      docker: { ok: false, version: null, problem: 'socket-permission', ncpu: null, memTotal: null },
    });
    const got = await call(h, 'GET', '/v1/runners', { token: s.accessToken });
    expect((got.body.runners as { docker: unknown }[])[0].docker).toMatchObject({ ok: false, problem: 'socket-permission' });
    runner.close();
  });

  it('renames and relabels, keeping the platform labels', async () => {
    const s = await setup();
    const r = await registerRunner(h, s);
    const res = await call(h, 'PATCH', `/v1/runners/${r.runnerId}`, { token: s.accessToken, body: { name: 'nuc', labels: ['fast'] } });
    expect(res.body.runner).toMatchObject({ name: 'nuc', labels: ['linux', 'x64', 'fast'] });
  });

  it('hides other users’ runners', async () => {
    const s = await setup();
    const r = await registerRunner(h, s);
    h.github.addUser('mallory');
    const m = await signIn(h, 'mallory');
    expect((await call(h, 'GET', `/v1/runners/${r.runnerId}`, { token: m.accessToken })).status).toBe(404);
    expect((await call(h, 'DELETE', `/v1/runners/${r.runnerId}`, { token: m.accessToken })).status).toBe(404);
    expect((await call(h, 'GET', '/v1/runners', { token: m.accessToken })).body.runners).toEqual([]);
  });
});

describe('removal', () => {
  async function withEnvironment() {
    const s = await setup();
    h.github.addRepo('namik/web', { pushers: ['namik'] });
    const r = await registerRunner(h, s);
    const sock = await connectRunner(h, r.accessToken);
    const inst = await call(h, 'POST', '/v1/instances', {
      token: s.accessToken,
      body: { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] },
    });
    return { s, r, sock, envId: String(inst.body.envId) };
  }

  it('with a removal token, keeping environments as orphaned', async () => {
    const { s, r, sock, envId } = await withEnvironment();
    const rm = await call(h, 'POST', '/v1/runners/removal-token', { token: s.accessToken });
    const res = await call(h, 'POST', '/v1/runners/remove', {
      body: { removalToken: rm.body.token, runnerId: r.runnerId, environments: 'keep' },
    });
    expect(res.status).toBe(204);
    expect((await sock.waitClosed()).code).toBe(4403);
    const inst = await call(h, 'GET', `/v1/instances/${envId}`, { token: s.accessToken });
    expect((inst.body.instance as { status: string }).status).toBe('orphaned');
    expect((await call(h, 'GET', '/v1/runners', { token: s.accessToken })).body.runners).toEqual([]);
  });

  it('with the runner’s own assertion, deleting its environments from the index', async () => {
    const { s, r, envId } = await withEnvironment();
    const res = await call(h, 'POST', '/v1/runners/remove', {
      body: {
        assertion: assertion(r.runnerId, r.privateKey, 'http://puck.test/v1/runners/remove', h.clock.now()),
        runnerId: r.runnerId,
        environments: 'delete',
      },
    });
    expect(res.status).toBe(204);
    expect((await call(h, 'GET', `/v1/instances/${envId}`, { token: s.accessToken })).status).toBe(404);
  });

  it('keeps the removal audience and accepts versionless removal after the floor rises', async () => {
    const s = await setup();
    const r = await registerRunner(h, s);
    h.server.ctx.config.minRunnerVersion = '0.2.0';
    const wrongAudience = await call(h, 'POST', '/v1/runners/remove', {
      body: {
        assertion: signAssertion(r.runnerId, r.privateKey, TOKEN_AUD, h.clock.now(), '0.2.0'),
        runnerId: r.runnerId,
        environments: 'keep',
      },
    });
    expect(wrongAudience.status).toBe(401);
    expect(wrongAudience.body).toMatchObject({ error: 'invalid-assertion', message: expect.stringContaining('wrong audience') });
    const removed = await call(h, 'POST', '/v1/runners/remove', {
      body: {
        assertion: signAssertion(r.runnerId, r.privateKey, 'http://puck.test/v1/runners/remove', h.clock.now()),
        runnerId: r.runnerId,
        environments: 'keep',
      },
    });
    expect(removed.status).toBe(204);
  });

  it('refuses another user’s removal token', async () => {
    const { r } = await withEnvironment();
    h.github.addUser('mallory');
    const m = await signIn(h, 'mallory');
    const rm = await call(h, 'POST', '/v1/runners/removal-token', { token: m.accessToken });
    const res = await call(h, 'POST', '/v1/runners/remove', { body: { removalToken: rm.body.token, runnerId: r.runnerId, environments: 'keep' } });
    expect(res.status).toBe(404);
  });

  it.each([undefined, '0.2.0'])('force-removes from the app: environments become lost and the runner is told to stop for good (ver=%s)', async (ver) => {
    const { s, r, sock, envId } = await withEnvironment();
    expect((await call(h, 'DELETE', `/v1/runners/${r.runnerId}`, { token: s.accessToken })).status).toBe(204);
    expect((await sock.waitClosed()).reason).toBe('runner-removed');
    const inst = await call(h, 'GET', `/v1/instances/${envId}`, { token: s.accessToken });
    expect((inst.body.instance as { status: string }).status).toBe('lost');
    const back = await call(h, 'POST', '/v1/runners/token', {
      body: { assertion: assertion(r.runnerId, r.privateKey, TOKEN_AUD, h.clock.now(), { ver }) },
    });
    expect(back.status).toBe(403);
    expect(back.body.error).toBe('runner-removed');
    const kinds = (await h.server.ctx.store.listAudit(s.userId, 50)).map((e) => e.kind);
    expect(kinds).toContain('runner.removed');
  });

  it('never removes an offline runner by itself', async () => {
    const { s, r, sock } = await withEnvironment();
    sock.close();
    h.clock.advance(90 * 24 * 60 * 60_000);
    const fresh = await call(h, 'POST', '/v1/auth/token', { body: { grant_type: 'refresh_token', refresh_token: s.refreshToken } });
    // The session outlived its 30-day refresh window; sign in again and look.
    expect(fresh.status).toBe(400);
    const again = await signIn(h, 'namik');
    const list = await call(h, 'GET', '/v1/runners', { token: again.accessToken });
    expect(list.body.runners).toEqual([expect.objectContaining({ id: r.runnerId, status: 'offline' })]);
  });
});
