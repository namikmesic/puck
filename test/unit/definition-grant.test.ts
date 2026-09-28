import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonFrame, Snapshot } from '../../src/harness/daemon-protocol';
import { expectedPackages } from '../../src/harness/provisioning';
import { harnessDescriptors } from '../../src/harness/providers';
import { Daemon } from '../../src/daemon/daemon';
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

  async function setup(withGrant: boolean): Promise<void> {
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
    return { cmd };
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
  });
});
