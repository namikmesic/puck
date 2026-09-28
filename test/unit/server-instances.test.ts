import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICIES, permissionsFor } from '../../src/server/instances';
import { call, connectRunner, registerRunner, signIn, startServer, type Harness, type Socket } from './server-fakes';

let h: Harness;
let sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets) s.close();
  sockets = [];
  await h?.close();
});

describe('permissionsFor', () => {
  const base = { contents: 'write', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read' };
  it.each([
    [{}, { ...base, issues: 'write', actions: 'read' }],
    [{ statusComment: false }, { ...base, actions: 'read' }],
    [{ statusComment: false, intake: 'label' }, { ...base, issues: 'write', actions: 'read' }],
    [{ ci: 'fix' }, { ...base, issues: 'write', actions: 'write' }],
    [{ allowWorkflowEdits: true }, { ...base, issues: 'write', actions: 'read', workflows: 'write' }],
  ])('%j → %j', (policies, expected) => {
    expect(permissionsFor({ ...DEFAULT_POLICIES, ...(policies as object) })).toEqual(expected);
  });

  it('never grants workflows by default', () => {
    expect(permissionsFor(DEFAULT_POLICIES)).not.toHaveProperty('workflows');
  });
});

async function setup() {
  h = await startServer();
  h.github.addUser('namik');
  const s = await signIn(h, 'namik');
  const r = await registerRunner(h, s);
  const sock = await connectRunner(h, r.accessToken);
  sockets.push(sock);
  return { s, r, sock };
}

const create = (token: string, body: Record<string, unknown>) => call(h, 'POST', '/v1/instances', { token, body });

describe('POST /v1/instances', () => {
  it('records the grant after checking push access and finding each installation', async () => {
    const { s, r } = await setup();
    const webId = h.github.addRepo('namik/web', { pushers: ['namik'], installationId: 7 });
    h.github.addRepo('acme/api', { pushers: ['namik'], installationId: 9 });
    const res = await create(s.accessToken, {
      runnerId: r.runnerId,
      definition: 'web',
      repos: ['namik/web', 'acme/api', 'NAMIK/web'],
      policies: { github: { ci: 'fix' } },
    });
    expect(res.status).toBe(201);
    expect(res.body.envId).toMatch(/^env_[0-9A-Z]{26}$/);
    expect(res.body.instance).toMatchObject({
      runnerId: r.runnerId,
      definition: 'web',
      status: 'active',
      permissions: expect.objectContaining({ actions: 'write' }),
      repos: [
        { owner: 'acme', name: 'api', revoked: false },
        { owner: 'namik', name: 'web', revoked: false },
      ],
    });
    const grant = await h.server.ctx.store.grantRepos(String(res.body.envId));
    expect(grant.find((g) => g.name === 'web')).toMatchObject({ repoId: webId, installationId: 7 });
  });

  it.each([
    ['a repository the user cannot see', { readers: [], pushers: [] }, 403, 'repo-not-accessible'],
    ['a repository the user can only read', { readers: ['namik'] }, 403, 'repo-not-writable'],
    ['a repository without the App installed', { pushers: ['namik'], installationId: null }, 403, 'repo-not-accessible'],
  ])('refuses %s', async (_what, repo, status, code) => {
    const { s, r } = await setup();
    h.github.addRepo('namik/web', repo as never);
    const res = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] });
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: code, repo: 'namik/web' });
  });

  it('refuses an offline runner, a full runner, and another user’s runner', async () => {
    const { s, r, sock } = await setup();
    h.github.addRepo('namik/web', { pushers: ['namik'] });
    sock.send({ type: 'status', version: '0.1.0', docker: { ok: true }, maxEnvironments: 1, instances: [] });
    await sock.sync();
    const first = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] });
    expect(first.status).toBe(201);
    const full = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] });
    expect(full.body.error).toBe('runner-full');

    h.github.addUser('mallory');
    const m = await signIn(h, 'mallory');
    expect((await create(m.accessToken, { runnerId: r.runnerId, definition: 'x', repos: ['namik/web'] })).status).toBe(404);

    h.clock.advance(60_000);
    const offline = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] });
    expect(offline.body.error).toBe('runner-offline');
  });

  it('lets only one of two overlapping creates claim the last slot', async () => {
    const { s, r, sock } = await setup();
    h.github.addRepo('namik/web', { pushers: ['namik'] });
    sock.send({ type: 'status', version: '0.1.0', docker: { ok: true }, maxEnvironments: 1, instances: [] });
    await sock.sync();
    const gate = h.github.pauseRepoReads(2);
    const pending = Promise.all([
      create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] }),
      create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] }),
    ]);
    await gate.arrived;
    gate.release();
    const [a, b] = await pending;
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((res) => res.status === 409)?.body.error).toBe('runner-full');
    const list = await call(h, 'GET', '/v1/instances', { token: s.accessToken });
    expect(list.body.instances).toHaveLength(1);
  });

  it('refreshes a user token GitHub rejected and retries the repository check', async () => {
    const { s, r } = await setup();
    h.github.addRepo('namik/web', { pushers: ['namik'] });
    h.github.rejectUserAccess();
    const res = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] });
    expect(res.status).toBe(201);
    expect(h.github.refreshCount).toBe(1);
    expect(await h.server.ctx.store.getGitHubTokens(s.userId)).not.toBeNull();
  });

  it('forgets the user when GitHub rejects the access token and the refresh', async () => {
    const { s, r } = await setup();
    h.github.addRepo('namik/web', { pushers: ['namik'] });
    h.github.rejectUserAccess();
    h.github.revokeAuthorizations();
    const res = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner-auth-lost');
    expect(await h.server.ctx.store.getGitHubTokens(s.userId)).toBeNull();
    const token = await call(h, 'GET', '/v1/github/token', { token: s.accessToken });
    expect(token.status).toBe(401);
    expect(token.body.error).toBe('github-auth-lost');
  });

  it('does not treat an App JWT rejection as the user losing GitHub', async () => {
    const { s, r } = await setup();
    h.github.addRepo('namik/web', { pushers: ['namik'] });
    h.github.rejectAppJwt = true;
    const res = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('github-unavailable');
    expect(await h.server.ctx.store.getGitHubTokens(s.userId)).not.toBeNull();
  });

  it('validates repositories and policies', async () => {
    const { s, r } = await setup();
    const bad = [
      { repos: [] },
      { repos: ['no-slash'] },
      { repos: ['a/b/c'] },
      { repos: Array.from({ length: 21 }, (_, i) => `o/r${i}`) },
      { repos: ['o/r'], policies: { github: { ci: 'yolo' } } },
    ];
    for (const body of bad) {
      const res = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', ...body });
      expect(res.status).toBe(400);
    }
  });
});

describe('installation tokens for a runner', () => {
  const mint = (token: string, envId: string) => call(h, 'POST', `/v1/runners/instances/${envId}/github-token`, { token });

  it('mints one token per installation, scoped to the granted repositories and permissions', async () => {
    const { s, r } = await setup();
    const web = h.github.addRepo('namik/web', { pushers: ['namik'], installationId: 7 });
    const docs = h.github.addRepo('namik/docs', { pushers: ['namik'], installationId: 7 });
    const api = h.github.addRepo('acme/api', { pushers: ['namik'], installationId: 9 });
    h.github.addRepo('namik/secret', { pushers: ['namik'], installationId: 7 });
    const inst = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web', 'namik/docs', 'acme/api'] });
    const res = await mint(r.accessToken, String(inst.body.envId));
    expect(res.status).toBe(200);
    const grants = res.body.grants as { owner: string; installationId: number; repos: string[]; token: string; expiresAt: number }[];
    expect(grants.map((g) => [g.owner, g.installationId, g.repos])).toEqual([
      ['acme', 9, ['acme/api']],
      ['namik', 7, ['namik/docs', 'namik/web']],
    ]);
    expect(grants.every((g) => g.token.startsWith('ghs_') && g.expiresAt === h.clock.now() + 3_600_000)).toBe(true);
    expect(h.github.mints).toEqual([
      { installationId: 9, repositoryIds: [api], permissions: expect.objectContaining({ contents: 'write' }) },
      { installationId: 7, repositoryIds: [docs, web], permissions: expect.not.objectContaining({ workflows: 'write' }) },
    ]);
    // Audited without the value.
    const audit = await h.server.ctx.store.listAudit(s.userId, 50);
    const minted = audit.filter((e) => e.kind === 'github.token-minted');
    expect(minted).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain(grants[0].token);
    expect(h.logs.join('')).not.toContain(grants[0].token);
  });

  it('re-verifies after ten minutes and drops a repository the owner lost', async () => {
    const { s, r } = await setup();
    h.github.addRepo('namik/web', { pushers: ['namik'] });
    h.github.addRepo('namik/docs', { pushers: ['namik'] });
    const inst = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web', 'namik/docs'] });
    const envId = String(inst.body.envId);
    h.github.revokePush('namik/docs', 'namik');

    h.clock.advance(9 * 60_000);
    let res = await mint(r.accessToken, envId);
    expect((res.body.grants as { repos: string[] }[])[0].repos).toEqual(['namik/docs', 'namik/web']);

    h.clock.advance(60_000);
    const before = h.github.calls.filter((c) => c.includes('/repos/namik/')).length;
    res = await mint(r.accessToken, envId);
    expect((res.body.grants as { repos: string[] }[])[0].repos).toEqual(['namik/web']);
    expect(h.github.calls.filter((c) => c.includes('/repos/namik/')).length).toBeGreaterThan(before);
    const view = await call(h, 'GET', `/v1/instances/${envId}`, { token: s.accessToken });
    expect((view.body.instance as { repos: unknown[] }).repos).toContainEqual({ owner: 'namik', name: 'docs', revoked: true });

    h.github.revokePush('namik/web', 'namik');
    h.clock.advance(10 * 60_000);
    res = await mint(r.accessToken, envId);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no-repositories');
  });

  it('reports owner-auth-lost when re-verification’s user token is rejected', async () => {
    const { s, r } = await setup();
    h.github.addRepo('namik/web', { pushers: ['namik'] });
    const inst = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] });
    h.clock.advance(10 * 60_000);
    h.github.rejectUserAccess();
    h.github.revokeAuthorizations();
    const res = await mint(r.accessToken, String(inst.body.envId));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner-auth-lost');
    expect(await h.server.ctx.store.getGitHubTokens(s.userId)).toBeNull();
  });

  it('refuses another runner’s environment and inactive ones', async () => {
    const { s, r } = await setup();
    h.github.addRepo('namik/web', { pushers: ['namik'] });
    const inst = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] });
    const other = await registerRunner(h, s, { name: 'other' });
    expect((await mint(other.accessToken, String(inst.body.envId))).status).toBe(404);
    expect((await mint('PRA_bogus', String(inst.body.envId))).status).toBe(401);
    await h.server.ctx.store.setInstanceStatus(String(inst.body.envId), 'orphaned', h.clock.now());
    expect((await mint(r.accessToken, String(inst.body.envId))).body.error).toBe('instance-inactive');
  });

  it('updates a grant with fresh checks and forgets an environment', async () => {
    const { s, r } = await setup();
    h.github.addRepo('namik/web', { pushers: ['namik'] });
    h.github.addRepo('namik/docs', { pushers: ['namik'] });
    const inst = await create(s.accessToken, { runnerId: r.runnerId, definition: 'web', repos: ['namik/web'] });
    const envId = String(inst.body.envId);
    const upd = await call(h, 'PUT', `/v1/instances/${envId}/grant`, {
      token: s.accessToken,
      body: { repos: ['namik/web', 'namik/docs'], policies: { github: { allowWorkflowEdits: true } } },
    });
    expect(upd.body.instance).toMatchObject({ permissions: expect.objectContaining({ workflows: 'write' }) });
    expect((upd.body.instance as { repos: unknown[] }).repos).toHaveLength(2);
    expect((await call(h, 'DELETE', `/v1/instances/${envId}`, { token: s.accessToken })).status).toBe(204);
    expect((await call(h, 'GET', '/v1/instances', { token: s.accessToken })).body.instances).toEqual([]);
  });
});
