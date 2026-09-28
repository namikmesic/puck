import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { splitName, tar, tarGz } from '../../src/puck-runner/tar';

// The runner's ustar writer: copy-in archives for `docker cp -` and the
// release tarballs. Headers are checked byte by byte, and the system tar
// must read the result back with the same names, modes and owners.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const field = (h: Buffer, at: number, len: number) => h.subarray(at, at + len).toString('utf8').replace(/\0.*$/s, '');

describe('ustar writer', () => {
  it('writes headers with explicit modes, root owners, sizes and a valid checksum', () => {
    const out = tar([
      { name: 'puck/inbox/', type: 'dir', mode: 0o700 },
      { name: 'puck/inbox/secrets.json', type: 'file', mode: 0o600, body: '{"values":{}}' },
    ]);
    expect(out.length % 512).toBe(0);
    const dir = out.subarray(0, 512);
    expect(field(dir, 0, 100)).toBe('puck/inbox/');
    expect(field(dir, 100, 8)).toBe('0000700');
    expect(field(dir, 108, 8)).toBe('0000000');
    expect(field(dir, 156, 1)).toBe('5');
    expect(field(dir, 257, 6)).toBe('ustar');
    expect(field(dir, 265, 32)).toBe('root');
    const file = out.subarray(512, 1024);
    expect(field(file, 0, 100)).toBe('puck/inbox/secrets.json');
    expect(field(file, 100, 8)).toBe('0000600');
    expect(parseInt(field(file, 124, 12), 8)).toBe(13);
    expect(field(file, 156, 1)).toBe('0');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : file[i];
    expect(parseInt(field(file, 148, 8), 8)).toBe(sum);
    expect(out.subarray(1024, 1024 + 13).toString()).toBe('{"values":{}}');
    // Two zero blocks end the archive.
    expect(out.subarray(out.length - 1024).every((b) => b === 0)).toBe(true);
  });

  it('splits long names into prefix and name, and falls back to a PAX path', () => {
    const long = `${'a'.repeat(120)}/${'b'.repeat(90)}`;
    expect(splitName(long)).toEqual({ prefix: 'a'.repeat(120), name: 'b'.repeat(90) });
    expect(splitName('short/name')).toEqual({ prefix: '', name: 'short/name' });
    expect(splitName('x'.repeat(300))).toBeNull();
    const out = tar([{ name: 'x'.repeat(300), type: 'file', mode: 0o644, body: 'hi' }]);
    expect(field(out, 156, 1)).toBe('x');
    expect(out.subarray(512, 1024).toString()).toContain(`path=${'x'.repeat(300)}\n`);
  });

  it('refuses paths that climb out of the archive root', () => {
    expect(() => tar([{ name: '../etc/passwd', type: 'file', mode: 0o644, body: '' }])).toThrow(/unsafe/);
    expect(() => tar([{ name: 'a/../../b', type: 'file', mode: 0o644, body: '' }])).toThrow(/unsafe/);
  });

  it('round-trips through the system tar with names, modes and long paths intact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-tar-'));
    dirs.push(dir);
    const deep = `${'d'.repeat(110)}/${'e'.repeat(60)}.txt`;
    const archive = path.join(dir, 'a.tar.gz');
    fs.writeFileSync(
      archive,
      tarGz([
        { name: 'run.sh', type: 'file', mode: 0o755, body: '#!/bin/sh\necho hi\n' },
        { name: 'bin/', type: 'dir', mode: 0o755 },
        { name: 'bin/secret.json', type: 'file', mode: 0o600, body: '{}' },
        { name: deep, type: 'file', mode: 0o644, body: 'deep' },
        // No slash leaves a name part of 100 bytes or less: only a PAX path can carry it.
        { name: `${'p'.repeat(200)}/${'q'.repeat(120)}`, type: 'file', mode: 0o644, body: 'pax' },
      ]),
    );
    expect(gunzipSync(fs.readFileSync(archive)).length % 512).toBe(0);
    const into = path.join(dir, 'x');
    fs.mkdirSync(into);
    execFileSync('tar', ['-xzf', archive, '-C', into]);
    expect(fs.statSync(path.join(into, 'run.sh')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(into, 'bin', 'secret.json')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(into, deep), 'utf8')).toBe('deep');
    expect(fs.readFileSync(path.join(into, 'p'.repeat(200), 'q'.repeat(120)), 'utf8')).toBe('pax');
  });
});
