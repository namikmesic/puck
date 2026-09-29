import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { app, dialog } from 'electron';
import { beforeEach, describe, expect, it } from 'vitest';
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

describe('support bundle', () => {
  beforeEach(() => {
    // A provider token file and log lines that carry it.
    saveSecret('claude-oauth.bin', JSON.stringify({ accessToken: TOKEN, refreshToken: TOKEN }));
    log.info('turn.start', { turnId: 't1' });
    log.error('auth error', new Error(`exchange failed with ${TOKEN}`));
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

    expect(summary.providers.map((p) => p.id)).toEqual(['claude-code', 'codex']);
    expect(summary.providers.find((p) => p.id === 'claude-code')?.connected).toBe(true);
    expect(summary.runners).toMatchObject({ signedIn: false, list: [] });
    expect(summary.instances).toEqual([]);
    expect(summary).not.toHaveProperty('agents');
    expect(summary).not.toHaveProperty('environments');
    expect(summary.logs).toEqual(['puck.log']);

    const text = JSON.stringify(summary);
    expect(text).not.toContain(TOKEN);
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
