import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { app, dialog } from 'electron';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as agents from '../../src/main/agents';
import { useDockerRunner, type DockerResult } from '../../src/main/docker-client';
import * as environments from '../../src/main/environments';
import { log } from '../../src/main/log';
import { saveSecret } from '../../src/main/secrets';
import {
  buildSupportBundle,
  bundleFileName,
  exportSupportBundle,
  supportInfo,
  supportSummary,
} from '../../src/main/support';

const TOKEN = 'sk-ant-api03-supersecrettokenvalue1234567890';
const SECRET_VALUE = 'hunter2-the-secret-value';
const ENV_VALUE = 'env-var-value-that-must-not-leak';

/** Reads every entry of a ZIP built by src/main/zip.ts (central directory walk). */
function unzip(zip: Buffer): Record<string, string> {
  const eocd = zip.length - 22;
  const count = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(pos + 10);
    const csize = zip.readUInt32LE(pos + 20);
    const nameLen = zip.readUInt16LE(pos + 28);
    const local = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const payload = zip.subarray(start, start + csize);
    out[name] = (method === 8 ? zlib.inflateRawSync(payload) : payload).toString('utf8');
  }
  return out;
}

/** Scripted docker: `version` and `ps` answer, and every other command succeeds. */
function scriptedDocker(): void {
  useDockerRunner(async (args): Promise<DockerResult> => {
    if (args[0] === 'version') return { code: 0, stdout: '28.0.1 client, 28.0.1 server\n', stderr: '' };
    if (args[0] === 'ps') return { code: 0, stdout: 'puck-env-e1 | Up 2 hours | node:22-bookworm\n', stderr: '' };
    if (args[0] === 'inspect') return { code: 0, stdout: 'true\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
}

describe('support bundle', () => {
  let envId: string;

  beforeEach(async () => {
    scriptedDocker();
    // A realistic store: an agent with options and a system prompt, an
    // environment with an env var and a secret, and a provider token file.
    const [agent] = agents.list();
    agents.update(agent.id, {
      name: 'Reviewer',
      provider: agent.provider,
      model: 'auto',
      systemPrompt: 'You are careful. Never reveal the launch codes.',
      effort: 'auto',
      options: { permissionMode: 'plan' },
      advanced: '{"maxTurns": 3}',
    });
    const envs = await environments.create({
      name: 'dev',
      image: 'node:22-bookworm',
      workspacePath: '/tmp/ws',
      autoInstall: true,
      dockerfile: '',
      envVars: { API_HOST: ENV_VALUE },
    });
    envId = envs[envs.length - 1].id;
    await environments.secretSet(envId, 'API_TOKEN', SECRET_VALUE);
    saveSecret('claude-oauth.bin', JSON.stringify({ accessToken: TOKEN, refreshToken: TOKEN }));
    log.info('turn.start', { turnId: 't1' });
    log.error('auth error', new Error(`exchange failed with ${TOKEN}`));
  });

  afterEach(async () => {
    await environments.remove(envId);
  });

  it('reports the version and the two data paths', () => {
    const info = supportInfo();
    expect(info.version).toBe('0.0.0-test');
    expect(info.dataDir).toBe(app.getPath('userData'));
    expect(info.logFile).toBe(path.join(app.getPath('userData'), 'logs', 'puck.log'));
  });

  it('summarizes configuration by id, name, flag, and key name only', async () => {
    const summary = await supportSummary(new Date('2026-09-23T16:00:00Z'));
    expect(summary.generatedAt).toBe('2026-09-23T16:00:00.000Z');
    expect(summary.app.version).toBe('0.0.0-test');
    expect(summary.app.dataDir).toBe(app.getPath('userData'));

    const reviewer = summary.agents.find((a) => a.name === 'Reviewer');
    expect(reviewer).toMatchObject({
      provider: 'claude-code',
      optionKeys: ['permissionMode'],
      systemPromptChars: 'You are careful. Never reveal the launch codes.'.length,
      advancedSet: true,
    });
    expect(JSON.stringify(reviewer)).not.toContain('launch codes');
    expect(JSON.stringify(reviewer)).not.toContain('plan'); // option VALUES stay out
    expect(JSON.stringify(reviewer)).not.toContain('maxTurns');

    const dev = summary.environments.find((e) => e.id === envId);
    expect(dev).toMatchObject({
      name: 'dev',
      image: 'node:22-bookworm',
      envVarKeys: ['API_HOST'],
      secretKeys: ['API_TOKEN'],
      status: 'stopped', // lifecycle state: created, never started
      stage: null,
    });

    expect(summary.providers.map((p) => p.id)).toEqual(['claude-code', 'codex']);
    expect(summary.providers.find((p) => p.id === 'claude-code')?.connected).toBe(true);
    expect(summary.docker).toEqual({
      version: '28.0.1 client, 28.0.1 server',
      containers: ['puck-env-e1 | Up 2 hours | node:22-bookworm'],
    });
    expect(summary.logs).toEqual(['puck.log']);

    const text = JSON.stringify(summary);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain(ENV_VALUE);
  });

  it('zips README, summary, and the redacted logs, and leaks no secret into any entry', async () => {
    const now = new Date('2026-09-23T16:05:06.789Z');
    const bundle = await buildSupportBundle(now);
    expect(bundle.fileName).toBe('puck-support-2026-09-23T16-05-06.zip');
    expect(bundle.entries).toEqual(['README.txt', 'summary.json', 'logs/puck.log']);

    const files = unzip(bundle.zip);
    expect(Object.keys(files)).toEqual(bundle.entries);
    expect(files['README.txt']).toContain('summary.json');
    expect(JSON.parse(files['summary.json']).app.version).toBe('0.0.0-test');
    expect(files['logs/puck.log']).toContain('INFO  turn.start {"turnId":"t1"}');
    expect(files['logs/puck.log']).toContain('ERROR auth error');

    const everything = Object.values(files).join('\n');
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(SECRET_VALUE);
    expect(everything).not.toContain(ENV_VALUE);
    expect(everything).not.toContain('launch codes');
  });

  it('reports docker as unavailable instead of failing the export', async () => {
    useDockerRunner(async () => ({ code: -1, stdout: '', stderr: 'spawn docker ENOENT' }));
    const summary = await supportSummary();
    expect(summary.docker.version).toBe('unavailable: spawn docker ENOENT');
    expect(summary.docker.containers).toEqual(['unavailable: spawn docker ENOENT']);
    expect(summary.environments.find((e) => e.id === envId)?.status).toBe('stopped');
  });

  it('writes the bundle where the dialog points, and nothing when canceled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-support-'));
    const target = path.join(dir, 'bundle.zip');

    dialog.nextSave = { canceled: true };
    expect(await exportSupportBundle(null)).toEqual({ path: null });
    expect(fs.existsSync(target)).toBe(false);

    dialog.nextSave = { canceled: false, filePath: target };
    expect(await exportSupportBundle(null)).toEqual({ path: target });
    const files = unzip(fs.readFileSync(target));
    expect(Object.keys(files)).toEqual(['README.txt', 'summary.json', 'logs/puck.log']);
    expect(files['logs/puck.log']).toContain('support.export.canceled');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names bundles by UTC second so two exports never collide', () => {
    expect(bundleFileName(new Date('2026-01-02T03:04:05.678Z'))).toBe('puck-support-2026-01-02T03-04-05.zip');
  });
});
