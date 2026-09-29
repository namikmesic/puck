/**
 * The start flow's preflight messages and its create sequence, with every
 * dependency scripted: the index entry first, the daemon bundle only when
 * the runner lacks it (in chunks), `instance.create` carrying the resolved
 * definition, fresh harness credentials and the secrets, the runner's stage
 * events, and the index entry forgotten again when creation fails.
 */

import { describe, expect, it, vi } from 'vitest';
import type { StartSpec } from '../../src/harness/bridge';
import { resolveEnvironment } from '../../src/harness/definitions/resolve';
import type { Pin, ResolvedEnvironment } from '../../src/harness/definitions/types';
import { validateSnapshot } from '../../src/harness/definitions/validate';
import { memoryBytes, placement } from '../../src/harness/placement';
import { RUNNER_LIMITS, type ControlEvent } from '../../src/harness/runner-protocol';
import { create, harnessesOf, preflight, uploadBundle, type StartDeps } from '../../src/main/instances/start-flow';
import { exampleFiles, patchYaml, snapshotOf } from './definitions-fixtures';

const pin: Pin = { kind: 'tag', name: 'v1.0.0', sha: 'a'.repeat(40) };
const RUNNER = 'rnr_01J8Z3X0000000000000000001';

function resolved(edit?: (f: ReturnType<typeof exampleFiles>) => void): ResolvedEnvironment {
  const files = exampleFiles();
  edit?.(files);
  const snap = snapshotOf(files);
  return resolveEnvironment(validateSnapshot(snap), snap, 'example', { repo: 'acme/config', pin });
}

const spec = (over: Partial<StartSpec> = {}): StartSpec => ({ pin: { kind: 'tag', name: 'v1.0.0' }, definition: 'example', runnerId: RUNNER, secrets: {}, ...over });

function deps(over: Partial<StartDeps> = {}, def: ResolvedEnvironment = resolved()) {
  const calls: { op: string; args: unknown }[] = [];
  const stages: string[] = [];
  const d: StartDeps = {
    resolve: async () => def,
    runner: () => ({ id: RUNNER, name: 'build-box', status: 'idle', docker: { ok: true, version: '27.3.1', problem: null, ncpu: 16, memTotal: 64 * 1024 ** 3 }, maxEnvironments: null }),
    hosted: () => 0,
    checkTransport: () => undefined,
    harnessSignedIn: () => true,
    harnessLabel: (id) => (id === 'claude-code' ? 'Claude Code' : 'Codex'),
    harnessCredential: async (id) => JSON.stringify({ id, fresh: true }),
    containerEnv: (id) => (id === 'claude-code' ? { IS_SANDBOX: '1' } : {}),
    createIndexEntry: vi.fn(async () => ({ envId: 'env_01J8Z3X0000000000000000000' })),
    forgetIndexEntry: vi.fn(async () => undefined),
    control: (async (_runner: string, op: string, args: unknown, opts?: { onEvent?: (ev: ControlEvent) => void }) => {
      calls.push({ op, args });
      if (op === 'bundle.has') return { has: false };
      if (op === 'bundle.put') return { received: 0, complete: (args as { last: boolean }).last };
      if (op === 'instance.create') {
        opts?.onEvent?.({ kind: 'instance.stage', envId: 'env_01J8Z3X0000000000000000000', stage: 'pulling-image', detail: 'node:22' });
        opts?.onEvent?.({ kind: 'instance.stage', envId: 'env_other', stage: 'removing-image' });
        return {};
      }
      return {};
    }) as StartDeps['control'],
    daemonBundle: () => ({ source: 'x'.repeat(RUNNER_LIMITS.maxBundleChunkBytes + 10), sha: 'b'.repeat(64) }),
    onStage: (_e, stage, detail) => stages.push(`${stage}:${detail}`),
    log: { info: () => undefined },
    ...over,
  };
  return { d, calls, stages };
}

describe('placement', () => {
  it('reads Docker memory notation', () => {
    expect(memoryBytes('8g')).toBe(8 * 1024 ** 3);
    expect(memoryBytes('512m')).toBe(512 * 1024 ** 2);
    expect(memoryBytes('1.5g')).toBe(1.5 * 1024 ** 3);
    expect(memoryBytes('lots')).toBeNull();
  });
  it('needs an online runner with Docker, room, and enough CPUs and memory', () => {
    const r = { name: 'box', status: 'idle' as const, docker: { ok: true, version: '27', problem: null, ncpu: 4, memTotal: 8 * 1024 ** 3 }, maxEnvironments: 2 };
    expect(placement(r, 0, { cpus: 4, memory: '8g' })).toEqual({ ok: true, reason: null });
    expect(placement({ ...r, status: 'offline' }, 0, { cpus: null, memory: null }).reason).toBe('box is offline.');
    expect(placement({ ...r, docker: { ...r.docker, ok: false } }, 0, { cpus: null, memory: null }).reason).toMatch(/Docker is not working/);
    expect(placement(r, 2, { cpus: null, memory: null }).reason).toMatch(/maximum of 2/);
    expect(placement(r, 0, { cpus: 8, memory: null }).reason).toMatch(/asks for 8 CPUs; box has 4/);
    expect(placement(r, 0, { cpus: null, memory: '16g' }).reason).toMatch(/asks for 16g of memory; box has 8.0 GB/);
    expect(placement({ ...r, keyChanged: true }, 0, { cpus: null, memory: null }).reason).toMatch(/key changed/);
  });
});

describe('preflight', () => {
  it('passes a valid definition on a runner that fits, naming its harnesses', async () => {
    const plan = await preflight(spec(), deps().d);
    expect(plan.runnerId).toBe(RUNNER);
    expect(plan.pin).toEqual(pin);
    expect(plan.harnesses).toEqual(harnessesOf(plan.definition));
    expect(plan.harnesses).toContain('claude-code');
  });

  it('stops with one specific message for each thing that is missing', async () => {
    await expect(preflight(spec(), deps({ harnessSignedIn: (id) => id !== 'claude-code' }).d)).rejects.toThrow(
      'Connect Claude Code first (Settings → Providers): this environment\'s agents use it.',
    );
    const withSecret = resolved((f) => patchYaml(f, 'environments/example.yaml', { secrets: ['API_KEY'] }));
    await expect(preflight(spec(), deps({}, withSecret).d)).rejects.toThrow('Give a value for API_KEY: the definition needs it.');
    await expect(preflight(spec({ secrets: { API_KEY: 'v' } }), deps({}, withSecret).d)).resolves.toBeTruthy();
    await expect(preflight(spec(), deps({ runner: () => null }).d)).rejects.toThrow(/not in your runner list/);
    await expect(preflight(spec(), deps({ hosted: () => 3, runner: () => ({ id: RUNNER, name: 'box', status: 'active', docker: null, maxEnvironments: 3 }) }).d)).rejects.toThrow(/maximum of 3/);
    await expect(preflight(spec(), deps({ checkTransport: () => { throw new Error('key changed for box'); } }).d)).rejects.toThrow('key changed for box');
    const codexLead = async () => resolved((f) => patchYaml(f, 'agents/lead.yaml', { harness: 'codex' }));
    await expect(preflight(spec(), deps({ resolve: codexLead }).d)).rejects.toThrow(/must use harness claude-code/);
  });
});

describe('create', () => {
  it('records the index entry, uploads the bundle in chunks, and creates the container with the inbox', async () => {
    const def = resolved();
    // The index entry carries policies.github whenever resolution attached it.
    const github = { ci: 'fix', allowWorkflowEdits: true };
    (def.policies as { github?: object }).github = github;
    const { d, calls, stages } = deps({}, def);
    const plan = await preflight(spec(), d);
    const created: string[] = [];
    const envId = await create(plan, spec(), d, (id) => created.push(id));
    expect(envId).toBe('env_01J8Z3X0000000000000000000');
    expect(created).toEqual([envId]);
    expect(d.createIndexEntry).toHaveBeenCalledWith({
      runnerId: RUNNER,
      definition: 'example',
      repos: ['your-org/your-app'],
      policies: { github },
    });
    expect(calls.map((c) => c.op)).toEqual(['bundle.has', 'bundle.put', 'bundle.put', 'instance.create']);
    const puts = calls.filter((c) => c.op === 'bundle.put').map((c) => c.args as { offset: number; last: boolean; data: string });
    expect(puts.map((p) => [p.offset, p.last])).toEqual([
      [0, false],
      [RUNNER_LIMITS.maxBundleChunkBytes, true],
    ]);
    const createArgs = calls.at(-1)?.args as Record<string, unknown>;
    expect(createArgs).toMatchObject({
      envId,
      image: 'node:22-bookworm',
      resources: { cpus: 4, memory: '8g' },
      containerEnv: { IS_SANDBOX: '1' },
      bundleSha: 'b'.repeat(64),
      inbox: { instance: { envId, name: 'example', pin } },
    });
    const inbox = createArgs.inbox as { harness: { id: string }[]; secrets?: unknown; instance: { definition: ResolvedEnvironment } };
    expect(inbox.instance.definition.name).toBe('example');
    expect(inbox.harness.map((h) => h.id)).toEqual(plan.harnesses);
    expect(inbox.secrets).toBeUndefined();
    // No GitHub token travels through the app: the runner fetches it from the server.
    expect(JSON.stringify(createArgs)).not.toMatch(/ghs_|github\.json|token/i);
    expect(stages).toEqual(['pulling-image:node:22']);
  });

  it('skips the upload when the runner has the bundle', async () => {
    const calls: string[] = [];
    const control = (async (_r: string, op: string) => {
      calls.push(op);
      return op === 'bundle.has' ? { has: true } : {};
    }) as StartDeps['control'];
    expect(await uploadBundle(RUNNER, { control, daemonBundle: () => ({ source: 'x', sha: 'c'.repeat(64) }) })).toBe('c'.repeat(64));
    expect(calls).toEqual(['bundle.has']);
  });

  it('forgets the index entry when the runner cannot create the container', async () => {
    const { d } = deps({
      control: (async (_r: string, op: string) => {
        if (op === 'instance.create') throw new Error('docker: pull access denied');
        return op === 'bundle.has' ? { has: true } : {};
      }) as StartDeps['control'],
    });
    const plan = await preflight(spec(), d);
    await expect(create(plan, spec(), d, () => undefined)).rejects.toThrow(/pull access denied/);
    expect(d.forgetIndexEntry).toHaveBeenCalledWith('env_01J8Z3X0000000000000000000');
  });
});
