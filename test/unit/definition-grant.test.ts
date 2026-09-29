import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonFrame, Snapshot } from '../../src/harness/daemon-protocol';
import { expectedPackages } from '../../src/harness/provisioning';
import { harnessDescriptors } from '../../src/harness/providers';
import { Daemon } from '../../src/daemon/daemon';
import { syncGrantPolicies } from '../../src/daemon/grant-sync';
import type { GitHubTokenPolicies } from '../../src/harness/github-permissions';
import type { HarnessAdapter } from '../../src/daemon/harness/types';
import { createLogger } from '../../src/daemon/log';
import { exampleDefinition, tempRoot } from './daemon-fakes';
import { call, connectRunner, registerRunner, signIn, startServer, type Harness, type Socket } from './server-fakes';

// definition.apply is what changes policies.github after the instance exists.
// The next installation-token mint has to follow that definition: workflows
// appears only while allowWorkflowEdits is on, and issues follows intake and
// the status comment. A change that does not affect permissions leaves the
// grant alone. A change that cannot be recorded is not applied.

const installed = expectedPackages(harnessDescriptors)
  .map((p) => `${p.name} ${p.version}`)
  .join('\n');

const adapter: HarnessAdapter = {
  id: 'claude-code',
  run: async (_req, ctx) => {
    ctx.emit({ kind: 'turn-end', stats: { inputTokens: 1, outputTokens: 1, durationMs: 1 } });
  },
};

const definition = (github: Record<string, unknown> = {}) =>
  exampleDefinition({
    orchestrator: { agent: 'lead', autoWake: false, maxAutoTurnsPerHour: 30 },
    policies: { github },
  });

const pin = (sha: string) => ({ kind: 'tag' as const, name: 'v1', sha });

describe('definition.apply governs the next mint', () => {
  let h: Harness;
  let relay: Socket;
  let userId: string;
  let userToken: string;
  let runnerToken: string;
  let envId: string;
  let root: ReturnType<typeof tempRoot>;
  let daemon: Daemon | null;
  let sockets: net.Socket[];

  afterEach(async () => {
    for (const s of sockets ?? []) s.destroy();
    sockets = [];
    if (daemon) await daemon.shutdown();
    daemon = null;
    relay?.close();
    await h?.close();
    root?.cleanup();
  });

  const stored = () => JSON.parse(fs.readFileSync(path.join(root.paths.state, 'instance.json'), 'utf8')) as { grantUnsure?: boolean };

  async function setup(withGrant: boolean, extra: { grantSyncTimeoutMs?: number } = {}): Promise<void> {
    sockets = [];
    h = await startServer();
    h.github.addUser('namik');
    h.github.addRepo('namik/web', { pushers: ['namik'], installationId: 7 });
    const session = await signIn(h, 'namik');
    userId = session.userId;
    userToken = session.accessToken;
    const runner = await registerRunner(h, session);
    runnerToken = runner.accessToken;
    relay = await connectRunner(h, runnerToken);
    const created = await call(h, 'POST', '/v1/instances', {
      token: userToken,
      body: { runnerId: runner.runnerId, definition: 'example', repos: ['namik/web'] },
    });
    expect(created.status).toBe(201);
    envId = String(created.body.envId);

    root = tempRoot('pd-grant-');
    fs.mkdirSync(root.paths.inbox, { recursive: true });
    fs.writeFileSync(
      path.join(root.paths.inbox, 'instance.json'),
      JSON.stringify({ envId, name: 'Example', pin: pin('abc1234'), definition: definition() }),
    );
    daemon = new Daemon({
      paths: root.paths,
      log: createLogger({ dir: root.paths.logs }),
      identity: { daemonVersion: '0.0.1+test', protocolVersion: 1, build: 'b'.repeat(64) },
      env: withGrant ? { PUCK_SERVER_URL: h.base, PUCK_GRANT_TOKEN: userToken } : {},
      privileged: false,
      exit: () => undefined,
      shutdownGraceMs: 200,
      ...extra,
      run: async (argv) => {
        if (argv[0] === 'id') return { code: 0, stdout: '10001\n', stderr: '', timedOut: false };
        if (argv[0] === 'sh' && argv[1] === '-lc' && argv[2]?.includes('echo "')) {
          return { code: 0, stdout: installed, stderr: '', timedOut: false };
        }
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      },
      adapters: { 'claude-code': adapter, codex: { ...adapter, id: 'codex' } },
    });
    await daemon.start();
  }

  function client() {
    const socket = net.connect(root.paths.socket);
    sockets.push(socket);
    const frames: DaemonFrame[] = [];
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(buf.slice(0, nl)) as DaemonFrame);
        buf = buf.slice(nl + 1);
      }
    });
    const send = (frame: unknown) => socket.write(JSON.stringify(frame) + '\n');
    send({ t: 'hello', protocol: 1, client: { app: 'test', build: 'x' }, since: null });
    let n = 0;
    async function cmd<T = unknown>(op: string, args: unknown = {}): Promise<T> {
      const id = `c${++n}`;
      send({ t: 'cmd', id, op, args });
      let res: Extract<DaemonFrame, { t: 'res' }> | undefined;
      await vi.waitFor(
        () => {
          res = frames.find((f): f is Extract<DaemonFrame, { t: 'res' }> => f.t === 'res' && f.id === id);
          expect(res).toBeDefined();
        },
        { timeout: 5000, interval: 5 },
      );
      if (!res?.ok) throw new Error(`${op}: ${res?.error.code}: ${res?.error.message}`);
      return res.result as T;
    }
    return { cmd, send, frames };
  }

  async function mint(): Promise<Record<string, string>> {
    const res = await call(h, 'POST', `/v1/runners/instances/${envId}/github-token`, { token: runnerToken });
    expect(res.status).toBe(200);
    const permissions = h.github.mints.at(-1)?.permissions;
    expect(permissions).toBeDefined();
    return permissions as Record<string, string>;
  }

  const permissionAudits = () =>
    h.server.ctx.store.listAudit(userId, 50).then((rows) => rows.filter((e) => e.kind === 'grant.permissions'));

  it('adds workflows when allowWorkflowEdits turns on and removes it when the flag turns off', async () => {
    await setup(true);
    const c = client();
    const apply = (github: Record<string, unknown>, sha: string) =>
      c.cmd('definition.apply', { definition: definition(github), pin: pin(sha) });

    const created = await mint();
    expect(created).not.toHaveProperty('workflows');
    expect(created.issues).toBe('write');

    expect(await apply({ allowWorkflowEdits: true }, 'aaa1111')).toEqual({ classes: ['hot'] });
    expect(await mint()).toMatchObject({ workflows: 'write', issues: 'write' });

    expect(await apply({ allowWorkflowEdits: false }, 'bbb2222')).toEqual({ classes: ['hot'] });
    const off = await mint();
    expect(off).not.toHaveProperty('workflows');
    expect(off.issues).toBe('write');
    expect(await permissionAudits()).toHaveLength(2);

    expect(await apply({ reviews: 'address' }, 'ccc3333')).toEqual({ classes: ['hot'] });
    expect(await permissionAudits()).toHaveLength(2);
    const view = await call(h, 'GET', `/v1/instances/${envId}`, { token: userToken });
    expect((view.body.instance as { repos: unknown[] }).repos).toEqual([{ owner: 'namik', name: 'web', revoked: false }]);

    expect(await apply({ statusComment: false }, 'ddd4444')).toEqual({ classes: ['hot'] });
    const quiet = await mint();
    expect(quiet.issues).toBe('read');
    expect(quiet).not.toHaveProperty('workflows');

    expect(await apply({ statusComment: false, intake: 'label' }, 'eee5555')).toEqual({ classes: ['hot'] });
    const labeled = await mint();
    expect(labeled.issues).toBe('write');
    expect(labeled).not.toHaveProperty('workflows');
    const audits = await permissionAudits();
    expect(audits).toHaveLength(4);
    expect(JSON.stringify(audits)).not.toContain(userToken);
  });

  it('leaves the definition and the grant unchanged when the update cannot be recorded', async () => {
    await setup(false);
    const c = client();
    const before = await mint();
    expect(before).not.toHaveProperty('workflows');
    await expect(
      c.cmd('definition.apply', { definition: definition({ allowWorkflowEdits: true }), pin: pin('fff6666') }),
    ).rejects.toThrow(/no way to update its grant/);
    expect((await c.cmd<Snapshot>('snapshot.get')).instance.sha).toBe('abc1234');
    const after = await mint();
    expect(after).not.toHaveProperty('workflows');
    expect(after.issues).toBe(before.issues);
    expect(await permissionAudits()).toHaveLength(0);
    expect(await c.cmd('definition.apply', { definition: definition({ reviews: 'address' }), pin: pin('aaa7777') })).toEqual({ classes: ['hot'] });
    expect((await c.cmd<Snapshot>('snapshot.get')).instance.sha).toBe('aaa7777');
  });

  it('applies the definition when permissions commit and the policies response then fails', async () => {
    await setup(true);
    const original = h.server.ctx.audit.bind(h.server.ctx);
    h.server.ctx.audit = async (kind, fields) => {
      if (kind === 'grant.permissions') throw new Error('audit failed');
      return original(kind, fields);
    };
    const c = client();
    expect(await c.cmd('definition.apply', { definition: definition({ allowWorkflowEdits: true }), pin: pin('aaa1111') })).toEqual({ classes: ['hot'] });
    expect((await c.cmd<Snapshot>('snapshot.get')).instance.sha).toBe('aaa1111');
    expect(await mint()).toMatchObject({ workflows: 'write', issues: 'write' });
  });

  it('puts the previous permissions back when the server commits and then fails the reply', async () => {
    await setup(true);
    const before = await mint();
    const orig = h.server.ctx.store.setPermissions.bind(h.server.ctx.store);
    const spy = vi.spyOn(h.server.ctx.store, 'setPermissions').mockImplementationOnce(async (id, permissions, now) => {
      await orig(id, permissions, now);
      throw new Error('reply lost');
    });
    try {
      const c = client();
      await expect(
        c.cmd('definition.apply', { definition: definition({ allowWorkflowEdits: true }), pin: pin('aaa1111') }),
      ).rejects.toThrow(/could not be updated/);
      expect((await c.cmd<Snapshot>('snapshot.get')).instance.sha).toBe('abc1234');
      expect(await mint()).toEqual(before);
      expect(stored().grantUnsure).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('syncs the grant on the next apply, even one that keeps permissions, when the revert also failed', async () => {
    await setup(true);
    const orig = h.server.ctx.store.setPermissions.bind(h.server.ctx.store);
    const spy = vi
      .spyOn(h.server.ctx.store, 'setPermissions')
      .mockImplementationOnce(async (id, permissions, now) => {
        await orig(id, permissions, now);
        throw new Error('reply lost');
      })
      .mockImplementationOnce(async () => {
        throw new Error('still down');
      });
    const c = client();
    try {
      await expect(
        c.cmd('definition.apply', { definition: definition({ allowWorkflowEdits: true }), pin: pin('aaa1111') }),
      ).rejects.toThrow(/could not be updated/);
    } finally {
      spy.mockRestore();
    }
    expect(await mint()).toMatchObject({ workflows: 'write' });
    expect(stored().grantUnsure).toBe(true);
    expect(await c.cmd('definition.apply', { definition: definition({ reviews: 'address' }), pin: pin('bbb2222') })).toEqual({ classes: ['hot'] });
    expect(await mint()).not.toHaveProperty('workflows');
    expect(stored().grantUnsure).toBe(false);
  });

  it('pushes the new permissions to the app when the audit fails after the commit', async () => {
    await setup(true);
    const original = h.server.ctx.audit.bind(h.server.ctx);
    h.server.ctx.audit = async (kind, fields) => {
      if (kind === 'grant.permissions') throw new Error('audit failed');
      return original(kind, fields);
    };
    const push = vi.spyOn(h.server.ctx.hub, 'push');
    const c = client();
    expect(await c.cmd('definition.apply', { definition: definition({ allowWorkflowEdits: true }), pin: pin('aaa1111') })).toEqual({ classes: ['hot'] });
    expect(push).toHaveBeenCalledWith(userId, {
      type: 'instance.upsert',
      instance: expect.objectContaining({ id: envId, permissions: expect.objectContaining({ workflows: 'write' }) }),
    });
  });

  it('refuses the apply and releases it when the policies request hangs', async () => {
    await setup(true, { grantSyncTimeoutMs: 50 });
    const orig = h.server.ctx.store.setPermissions.bind(h.server.ctx.store);
    let hang = true;
    const spy = vi.spyOn(h.server.ctx.store, 'setPermissions').mockImplementation(async (id, permissions, now) => {
      if (hang) await new Promise(() => undefined);
      return orig(id, permissions, now);
    });
    try {
      const c = client();
      await expect(
        c.cmd('definition.apply', { definition: definition({ allowWorkflowEdits: true }), pin: pin('aaa1111') }),
      ).rejects.toThrow(/could not be updated/);
      hang = false;
      expect(await c.cmd('definition.apply', { definition: definition({ allowWorkflowEdits: true }), pin: pin('bbb2222') })).toEqual({ classes: ['hot'] });
      expect(await mint()).toMatchObject({ workflows: 'write' });
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a second definition.apply until the first has stored its definition', async () => {
    await setup(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    const orig = h.server.ctx.store.setPermissions.bind(h.server.ctx.store);
    const spy = vi.spyOn(h.server.ctx.store, 'setPermissions').mockImplementation(async (envId, permissions, now) => {
      writes += 1;
      await gate;
      return orig(envId, permissions, now);
    });
    try {
      const c = client();
      await vi.waitFor(() => expect(c.frames.some((f) => f.t === 'welcome')).toBe(true));
      c.send({
        t: 'cmd',
        id: 'first',
        op: 'definition.apply',
        args: { definition: definition({ allowWorkflowEdits: true }), pin: pin('aaa1111') },
      });
      await vi.waitFor(() => expect(writes).toBe(1));
      c.send({
        t: 'cmd',
        id: 'second',
        op: 'definition.apply',
        args: { definition: definition({ allowWorkflowEdits: false }), pin: pin('bbb2222') },
      });
      await vi.waitFor(() => {
        const second = c.frames.find((f) => f.t === 'res' && f.id === 'second');
        expect(second).toMatchObject({ ok: false, error: { code: 'invalid-state' } });
      });
      expect(writes).toBe(1);
      release();
      await vi.waitFor(() => {
        const first = c.frames.find((f) => f.t === 'res' && f.id === 'first');
        expect(first).toMatchObject({ ok: true, result: { classes: ['hot'] } });
      });
      expect((await c.cmd<Snapshot>('snapshot.get')).instance.sha).toBe('aaa1111');
      expect(await mint()).toMatchObject({ workflows: 'write' });
      expect(writes).toBe(1);
    } finally {
      release();
      spy.mockRestore();
    }
  });
});

describe('syncGrantPolicies', () => {
  const env = { PUCK_SERVER_URL: 'https://puck.test', PUCK_GRANT_TOKEN: 'PSA_testtoken' };
  const policies: GitHubTokenPolicies = { intake: 'off', statusComment: true, ci: 'notify', allowWorkflowEdits: true };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function reply(status: number, read: () => Promise<ArrayBuffer> = async () => new ArrayBuffer(0)): Response {
    return { status, ok: status >= 200 && status < 300, arrayBuffer: read } as Response;
  }

  it('treats HTTP 200 as success when the body cannot be read', async () => {
    const fetchMock = vi.fn(async () => reply(200, async () => Promise.reject(new Error('dropped'))));
    vi.stubGlobal('fetch', fetchMock);
    await syncGrantPolicies(env, 'env_1', policies);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a transport failure once and then accepts HTTP 200', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(reply(200));
    vi.stubGlobal('fetch', fetchMock);
    await syncGrantPolicies(env, 'env_1', policies);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://puck.test/v1/instances/env_1/policies');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PUT' });
  });

  it('retries a response with no status once', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(reply(0)).mockResolvedValueOnce(reply(200));
    vi.stubGlobal('fetch', fetchMock);
    await syncGrantPolicies(env, 'env_1', policies);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('refuses the apply when a transport failure repeats', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(syncGrantPolicies(env, 'env_1', policies)).rejects.toThrow(/could not be updated/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives each attempt a deadline, so a hung request fails after two', async () => {
    const fetchMock = vi.fn(
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason))),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(syncGrantPolicies(env, 'env_1', policies, 20)).rejects.toThrow(/could not be updated/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry an HTTP error', async () => {
    const fetchMock = vi.fn(async () => reply(500));
    vi.stubGlobal('fetch', fetchMock);
    await expect(syncGrantPolicies(env, 'env_1', policies)).rejects.toThrow(/could not be updated/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
