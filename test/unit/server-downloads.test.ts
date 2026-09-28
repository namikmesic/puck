import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { call, startServer, type Harness } from './server-fakes';

let h: Harness;
let dir: string;
afterEach(async () => {
  await h?.close();
  rmSync(dir, { recursive: true, force: true });
});

function publish(version: string, name: string, body: string): string {
  mkdirSync(join(dir, version), { recursive: true });
  writeFileSync(join(dir, version, name), body);
  return createHash('sha256').update(body).digest('hex');
}

describe('runner downloads', () => {
  it('lists the newest version’s tarballs with sha256 and the minimum version', async () => {
    dir = mkdtempSync(join(tmpdir(), 'puck-dl-'));
    publish('0.1.0', 'puck-runner-linux-x64-0.1.0.tar.gz', 'old');
    const sum = publish('0.10.0', 'puck-runner-linux-x64-0.10.0.tar.gz', 'linux');
    publish('0.10.0', 'puck-runner-macos-arm64-0.10.0.tar.gz', 'mac');
    publish('0.10.0', 'notes.txt', 'ignored');
    h = await startServer({ PUCK_RUNNER_DOWNLOADS: dir, PUCK_RUNNER_MIN_VERSION: '0.1.0' }, { github: false });
    const res = await call(h, 'GET', '/v1/runner/releases');
    expect(res.body).toMatchObject({ latest: '0.10.0', minVersion: '0.1.0' });
    expect(res.body.assets).toEqual([
      {
        os: 'linux',
        arch: 'x64',
        version: '0.10.0',
        file: 'puck-runner-linux-x64-0.10.0.tar.gz',
        url: 'http://puck.test/runner/0.10.0/puck-runner-linux-x64-0.10.0.tar.gz',
        sha256: sum,
        size: 5,
      },
      expect.objectContaining({ os: 'macos', arch: 'arm64' }),
    ]);
  });

  it('serves a tarball and its checksum line, and nothing else', async () => {
    dir = mkdtempSync(join(tmpdir(), 'puck-dl-'));
    const sum = publish('0.1.0', 'puck-runner-linux-arm64-0.1.0.tar.gz', 'tarball-bytes');
    writeFileSync(join(dir, 'secret.txt'), 'nope');
    h = await startServer({ PUCK_RUNNER_DOWNLOADS: dir }, { github: false });
    const file = await fetch(`${h.base}/runner/0.1.0/puck-runner-linux-arm64-0.1.0.tar.gz`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('application/gzip');
    expect(await file.text()).toBe('tarball-bytes');
    const line = await fetch(`${h.base}/runner/0.1.0/puck-runner-linux-arm64-0.1.0.tar.gz.sha256`);
    expect(await line.text()).toBe(`${sum}  puck-runner-linux-arm64-0.1.0.tar.gz\n`);
    for (const path of ['/runner/0.1.0/secret.txt', '/runner/..%2Fsecret.txt/x', '/runner/0.1.0/puck-runner-linux-arm64-0.2.0.tar.gz']) {
      expect((await fetch(h.base + path)).status).toBe(404);
    }
  });

  it('lists nothing when no directory is configured', async () => {
    dir = mkdtempSync(join(tmpdir(), 'puck-dl-'));
    h = await startServer({}, { github: false });
    expect((await call(h, 'GET', '/v1/runner/releases')).body).toEqual({ latest: null, minVersion: null, assets: [] });
  });
});

describe('http basics', () => {
  it('answers unknown paths, wrong methods, bad bodies and big bodies with JSON errors', async () => {
    dir = mkdtempSync(join(tmpdir(), 'puck-dl-'));
    h = await startServer();
    expect((await call(h, 'GET', '/nope')).body.error).toBe('not-found');
    expect((await call(h, 'GET', '/v1/auth/token')).body.error).toBe('method-not-allowed');
    const notJson = await fetch(`${h.base}/v1/auth/token`, { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } });
    expect((await notJson.json()).error).toBe('unsupported-media-type');
    const broken = await fetch(`${h.base}/v1/auth/token`, { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } });
    expect((await broken.json()).error).toBe('invalid-json');
    const big = await fetch(`${h.base}/v1/auth/token`, {
      method: 'POST',
      body: JSON.stringify({ x: 'a'.repeat(70_000) }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(big.status).toBe(413);
    const health = await fetch(`${h.base}/healthz`);
    expect(health.headers.get('cache-control')).toBe('no-store');
  });
});
