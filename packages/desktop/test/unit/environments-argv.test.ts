import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useDockerRunner, type DockerResult } from '../../src/main/docker-client';
import * as environments from '../../src/main/environments';
import { providers } from '../../src/main/providers';

// Characterization: the exact docker argv an environment start issues. The
// orchestration's correctness lives in these argv strings and their order —
// a refactor that shuffles or drops a step must fail here, not in a
// container three days later.

const calls: string[][] = [];
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-ws-'));

beforeAll(() => {
  // Forwarded host auth vars would add machine-dependent -e flags.
  for (const key of providers.flatMap((p) => p.container.forwardedEnvKeys)) {
    delete process.env[key];
  }
  useDockerRunner(async (args): Promise<DockerResult> => {
    calls.push(args);
    if (args[0] === 'inspect') return { code: 1, stdout: '', stderr: 'no such container' };
    return { code: 0, stdout: '', stderr: '' };
  });
});

afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));

describe('environment start (scripted docker)', () => {
  it('creates, bootstraps, and provisions in the documented order', async () => {
    const list = await environments.create({
      name: 'charact',
      image: 'node:22-bookworm',
      workspacePath: workspace,
      autoInstall: true,
      dockerfile: '',
      envVars: { MY_VAR: 'v' },
    });
    const env = list[list.length - 1];
    calls.length = 0;
    await environments.start(env.id);

    const name = environments.containerName(env.id);
    // Credential mirroring depends on host files (~/.claude, ~/.codex);
    // filter those machine-dependent steps out of the characterization.
    const stable = calls.filter((a) => !a.some((s) => s.includes('/root/.')));

    // 1. State probe, 2. container creation, 3. /opt/puck, 4-5. bootstrap,
    // 6. runner deploy, 7-9. secrets file, 10. status probe for the returned list.
    expect(stable.map((a) => a[0])).toEqual([
      'inspect', 'run', 'exec', 'exec', 'exec', 'cp', 'exec', 'cp', 'exec', 'inspect',
    ]);

    const run = stable[1];
    // The security-load-bearing argv: detached, labeled, workspace mounted at
    // /workspace, sandbox marker env, user env, `--` guarding the image name.
    expect(run.slice(0, 2)).toEqual(['run', '-d']);
    expect(run).toContain('--name');
    expect(run).toContain(name);
    expect(run.join(' ')).toContain(`-v ${workspace}:/workspace`);
    expect(run.join(' ')).toContain('-w /workspace');
    expect(run.join(' ')).toContain('-e IS_SANDBOX=1');
    expect(run.join(' ')).toContain('-e MY_VAR=v');
    const dashDash = run.indexOf('--');
    expect(dashDash).toBeGreaterThan(-1);
    expect(run.slice(dashDash + 1)).toEqual(['node:22-bookworm', 'sleep', 'infinity']);

    // Bootstrap scripts run under a login shell inside the container.
    expect(stable[3].slice(0, 4)).toEqual(['exec', name, 'sh', '-lc']);
    expect(stable[3][4]).toContain('command -v claude');
    expect(stable[4][4]).toContain('npm install --prefix /opt/puck');

    // Runner deploy and secrets injection target the fixed container paths.
    expect(stable[5][2]).toBe(`${name}:/opt/puck/runner.js`);
    expect(stable[7][2]).toBe(`${name}:/opt/puck/secrets.json`);
    expect(stable[8].slice(1)).toEqual([name, 'chmod', '600', '/opt/puck/secrets.json']);
  });
});
