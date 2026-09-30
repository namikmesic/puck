import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { packageRunner } from '../../scripts/package-runner.mjs';
import { RUNNER_PACKAGE_ENTRIES, RUNNER_TARGETS, runnerPackageFile, targetName } from '../../src/harness/runner-releases';
import { tar, tarGz, type TarEntry } from '../../src/puck-runner/tar';
import { MAX_UNPACKED_BYTES, RunnerArchiveError, unpackRunnerPackage, type RunnerArchiveErrorCode } from '../../src/runner-release/archive';
import { MAX_PACKAGE_BYTES } from '../../src/runner-release/download';

/** When set, the next staging directory is given a file named `bin`, so `bin/` cannot be created. */
const plantBin = vi.hoisted(() => ({ on: false }));
/**
 * When set, every file handle opened persists only part of what it is given:
 * `half` writes half of the first write and nothing after, `zero` writes
 * nothing at all, as a full disk or a short POSIX write would.
 */
const shortWrite = vi.hoisted(() => ({ mode: null as null | 'half' | 'zero', opened: 0 }));
/**
 * When `ms` is set, every open for writing takes that long, and each open and
 * close is recorded in order. `failSourceOnOpen` destroys the archive's read
 * stream the moment the first open begins, so the stream fails while that
 * open is in flight.
 */
const slowOpen = vi.hoisted(() => ({ ms: 0, events: [] as string[], failSourceOnOpen: false, source: null as null | { destroy(err?: Error): unknown } }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync(prefix: string): string {
      const dir = actual.mkdtempSync(prefix);
      if (plantBin.on) actual.writeFileSync(join(dir, 'bin'), 'not a directory');
      return dir;
    },
    createReadStream(...args: Parameters<typeof actual.createReadStream>): ReturnType<typeof actual.createReadStream> {
      const stream = actual.createReadStream(...args);
      slowOpen.source = stream;
      return stream;
    },
    promises: {
      ...actual.promises,
      async open(...args: Parameters<typeof actual.promises.open>): ReturnType<typeof actual.promises.open> {
        if (slowOpen.failSourceOnOpen) {
          slowOpen.failSourceOnOpen = false;
          slowOpen.source?.destroy(new Error('the disk read failed'));
        }
        if (slowOpen.ms) await new Promise((resolve) => setTimeout(resolve, slowOpen.ms));
        const handle = await actual.promises.open(...args);
        if (slowOpen.ms) {
          slowOpen.events.push(`opened ${String(args[0]).split('/').pop()}`);
          const close = handle.close.bind(handle);
          handle.close = async () => {
            slowOpen.events.push(`closed ${String(args[0]).split('/').pop()}`);
            return close();
          };
        }
        if (!shortWrite.mode) return handle;
        shortWrite.opened++;
        let calls = 0;
        const patched = Object.create(handle) as typeof handle;
        patched.write = (async (data: Uint8Array) => {
          calls++;
          if (shortWrite.mode === 'zero' || calls > 1) return { bytesWritten: 0, buffer: data };
          return handle.write(data.subarray(0, Math.max(1, data.length >> 1)));
        }) as typeof handle.write;
        return patched;
      },
    },
  };
});

const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } = fs;

// The strict package reader: the packager's fixed layout and nothing else,
// read header by header into private staging, with every failure leaving
// no staging behind. Packages come from the runner's own tar writer (as
// the packager's do), from the packager itself with a stand-in bundle and
// runtime, and, where a packaging run left them under out/, from the real
// artifacts.

const VERSION = '1.2.3';
const root = join(__dirname, '..', '..');

const dirs: string[] = [];
let into: string;
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'puck-archive-'));
  dirs.push(dir);
  return dir;
};
beforeEach(() => {
  into = tmp();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  plantBin.on = false;
  shortWrite.mode = null;
  shortWrite.opened = 0;
  slowOpen.ms = 0;
  slowOpen.events = [];
  slowOpen.failSourceOnOpen = false;
  slowOpen.source = null;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NODE = randomBytes(300 * 1024);
const BUNDLE = Buffer.from(`// runner ${VERSION}\n`.repeat(2000));
const BODIES: Record<string, Buffer> = {
  'config.sh': Buffer.from('#!/bin/sh\n# config\n'),
  'run.sh': Buffer.from('#!/bin/sh\n# run\n'),
  'svc.sh': Buffer.from('#!/bin/sh\n# svc\n'),
  VERSION: Buffer.from(`${VERSION}\n`),
  'README.md': Buffer.from('# runner\n'),
  LICENSE: Buffer.from('MIT\n'),
  'bin/node': NODE,
  'bin/node.LICENSE': Buffer.from('Node.js license\n'),
  'bin/puck-runner.cjs': BUNDLE,
};

/** The layout as entries for the writer, with `overrides` applied by name. */
function entries(overrides: Record<string, Partial<TarEntry> | null> = {}): TarEntry[] {
  return RUNNER_PACKAGE_ENTRIES.flatMap((e) => {
    const change = overrides[e.name];
    if (change === null) return [];
    const entry: TarEntry = e.type === 'dir' ? { name: e.name, type: 'dir', mode: e.mode } : { name: e.name, type: 'file', mode: e.mode, body: BODIES[e.name] };
    return [{ ...entry, ...change }];
  });
}

const write = (bytes: Buffer): string => {
  const file = join(tmp(), 'package.tar.gz');
  writeFileSync(file, bytes);
  return file;
};

const unpack = (bytes: Buffer, version = VERSION, maxUnpackedBytes?: number) => unpackRunnerPackage(write(bytes), { into, version, maxUnpackedBytes });

async function failure(promise: Promise<unknown>): Promise<{ code: RunnerArchiveErrorCode; message: string }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RunnerArchiveError) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('expected a RunnerArchiveError');
}

/** Unpacking fails with `code` and a message matching `message`, and leaves no staging behind. */
async function refused(bytes: Buffer, code: RunnerArchiveErrorCode, message: RegExp | string, version = VERSION): Promise<void> {
  const f = await failure(unpack(bytes, version));
  expect(f.code, f.message).toBe(code);
  expect(f.message).toMatch(message);
  expect(readdirSync(into)).toEqual([]);
}

/** Everything under `dir`, relative, sorted, with directories marked by a slash. */
function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      const st = statSync(join(dir, path));
      if (st.isDirectory()) {
        out.push(`${path}/`);
        walk(path);
      } else out.push(path);
    }
  };
  walk('');
  return out;
}

function expectLayout(dir: string, bodies: Record<string, Buffer> = BODIES): void {
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(listing(dir)).toEqual([...RUNNER_PACKAGE_ENTRIES.map((e) => e.name)].sort());
  for (const e of RUNNER_PACKAGE_ENTRIES) {
    const st = statSync(join(dir, e.name));
    expect(st.mode & 0o7777, e.name).toBe(e.mode);
    expect(st.isDirectory(), e.name).toBe(e.type === 'dir');
    if (e.type === 'file') expect(readFileSync(join(dir, e.name)).equals(bodies[e.name]), e.name).toBe(true);
  }
}

/** Where `name`'s header and body sit in a raw archive. */
function locate(raw: Buffer, name: string): { header: number; body: number; size: number } {
  const field = (h: Buffer, at: number, len: number): string => h.subarray(at, at + len).toString('latin1').replace(/\0.*$/s, '');
  for (let at = 0; at + 512 <= raw.length; ) {
    const header = raw.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = parseInt(field(header, 124, 12), 8);
    if (field(header, 0, 100) === name) return { header: at, body: at + 512, size };
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`no entry ${name}`);
}

function checksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
}

/** The archive with `name`'s header changed by `edit` (and its checksum fixed, unless `keepChecksum`). */
function mutated(name: string, edit: (header: Buffer) => void, opts: { keepChecksum?: boolean; entries?: TarEntry[] } = {}): Buffer {
  const raw = Buffer.from(tar(opts.entries ?? entries()));
  const { header } = locate(raw, name);
  const block = raw.subarray(header, header + 512);
  edit(block);
  if (!opts.keepChecksum) checksum(block);
  return gzipSync(raw);
}

const octal = (value: number, width: number): string => value.toString(8).padStart(width - 1, '0') + '\0';

describe('a valid package', () => {
  it('unpacks into a fresh 0700 directory under the parent, with the layout and its modes, and nothing else', async () => {
    const { dir } = await unpack(tarGz(entries()));
    expect(dir.startsWith(into + '/')).toBe(true);
    expect(readdirSync(into)).toEqual([dir.slice(into.length + 1)]);
    expectLayout(dir);
  });

  it('accepts the entries in any order', async () => {
    const reversed = [...entries()].reverse();
    expectLayout((await unpack(tarGz(reversed))).dir);
    const binFirst = entries().sort((a) => (a.name === 'bin/node' ? -1 : 0));
    expectLayout((await unpack(tarGz(binFirst))).dir);
  });

  it('restores the layout modes whatever the umask, and refuses nothing on an empty file', async () => {
    const empty = { ...BODIES, LICENSE: Buffer.alloc(0) };
    const { dir } = await unpack(tarGz(entries({ LICENSE: { body: empty.LICENSE } })));
    expectLayout(dir, empty);
  });

  it('is what scripts/package-runner.mjs writes, for every target', async () => {
    const version = '9.8.7';
    const outDir = tmp();
    const build = async ({ mode }: { mode: string }) => {
      const bundlePath = join(tmp(), 'puck-runner.cjs');
      const probe = JSON.stringify({ version, trustMode: mode, runnerProtocol: 7 });
      writeFileSync(bundlePath, `// stand-in runner bundle\nprocess.stdout.write(${JSON.stringify(probe + '\n')});\n`);
      return { bundlePath, version };
    };
    const runtime = async (target: { node: string }) => ({ node: Buffer.from(`#!/bin/sh\n# node for ${target.node}\n`), license: Buffer.from('Node.js license\n') });
    const result = await packageRunner({ mode: 'development', outDir, build, runtime, commit: () => { throw new Error('no commit'); } });
    expect(result.files).toHaveLength(RUNNER_TARGETS.length);
    for (const target of RUNNER_TARGETS) {
      const file = join(outDir, version, runnerPackageFile(target, version));
      const { dir } = await unpackRunnerPackage(file, { into, version });
      expect(listing(dir), targetName(target)).toEqual([...RUNNER_PACKAGE_ENTRIES.map((e) => e.name)].sort());
      for (const e of RUNNER_PACKAGE_ENTRIES) expect(statSync(join(dir, e.name)).mode & 0o7777, `${targetName(target)} ${e.name}`).toBe(e.mode);
      expect(readFileSync(join(dir, 'VERSION'), 'utf8')).toBe(`${version}\n`);
      expect(readFileSync(join(dir, 'bin', 'node'), 'utf8')).toContain(`node for`);
      expect(readFileSync(join(dir, 'config.sh'))).toEqual(readFileSync(join(root, 'src', 'puck-runner', 'sh', 'config.sh')));
      expect(readFileSync(join(dir, 'LICENSE'))).toEqual(readFileSync(join(root, 'LICENSE')));
      await expect(failure(unpackRunnerPackage(file, { into, version: '9.8.8' }))).resolves.toMatchObject({ code: 'version-mismatch' });
    }
  });

  it('reads the real packaged artifacts under out/, when a packaging run left them there', async (ctx) => {
    const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
    const files = ['puck-runner-suite', 'puck-runner']
      .flatMap((out) => RUNNER_TARGETS.map((t) => join(root, 'out', out, version, runnerPackageFile(t, version))))
      .filter((file) => existsSync(file));
    if (!files.length) ctx.skip(`no packaged runner under out/puck-runner-suite/${version} or out/puck-runner/${version}`);
    for (const file of files) {
      const { dir } = await unpackRunnerPackage(file, { into, version });
      expect(listing(dir), file).toEqual([...RUNNER_PACKAGE_ENTRIES.map((e) => e.name)].sort());
      for (const e of RUNNER_PACKAGE_ENTRIES) expect(statSync(join(dir, e.name)).mode & 0o7777, `${file} ${e.name}`).toBe(e.mode);
      expect(readFileSync(join(dir, 'VERSION'), 'utf8')).toBe(`${version}\n`);
      expect(statSync(join(dir, 'bin', 'node')).size).toBeGreaterThan(10 * 1024 * 1024);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('entries outside the layout', () => {
  it('refuses any other name, a state file, another directory, or bin as a file', async () => {
    for (const [name, entry] of [
      ['extra.txt', { name: 'extra.txt', type: 'file', mode: 0o644, body: 'x' }],
      ['bin/extra', { name: 'bin/extra', type: 'file', mode: 0o644, body: 'x' }],
      ['.runner', { name: '.runner', type: 'file', mode: 0o644, body: '{}' }],
      ['.runner_key', { name: '.runner_key', type: 'file', mode: 0o600, body: 'key' }],
      ['_update/', { name: '_update/', type: 'dir', mode: 0o700 }],
      ['lib/', { name: 'lib/', type: 'dir', mode: 0o755 }],
      ['config.sh/', { name: 'config.sh/', type: 'dir', mode: 0o755 }],
      ['Bin/node', { name: 'Bin/node', type: 'file', mode: 0o755, body: 'x' }],
    ] as [string, TarEntry][]) {
      await refused(tarGz([...entries(), entry]), 'unexpected-entry', `Entry ${JSON.stringify(name)}`);
    }
    await refused(tarGz([...entries({ 'bin/': null }), { name: 'bin', type: 'file', mode: 0o755, body: 'x' }]), 'unexpected-entry', 'Entry "bin"');
    await refused(tarGz(entries({ 'bin/node': { name: 'bin/node', type: 'dir' } })), 'unexpected-entry', 'Entry "bin/node/" (a directory)');
  });

  it('refuses a missing member, including bin/ itself, and a duplicate', async () => {
    await refused(tarGz(entries({ LICENSE: null })), 'missing-entry', 'The package lacks LICENSE.');
    await refused(tarGz(entries({ 'bin/': null })), 'missing-entry', 'The package lacks bin/.');
    await refused(tarGz(entries({ 'bin/node': null, 'bin/puck-runner.cjs': null })), 'missing-entry', 'lacks bin/node, bin/puck-runner.cjs');
    await refused(tarGz([]), 'missing-entry', 'The package lacks config.sh, run.sh');
    const all = entries();
    await refused(tarGz([...all, all[3]]), 'duplicate-entry', 'Entry "VERSION" appears twice.');
    await refused(tarGz([...all, all[6]]), 'duplicate-entry', 'Entry "bin/" appears twice.');
  });

  it('refuses absolute, traversing and otherwise unsafe paths before looking anything up', async () => {
    const rename = (to: string): Buffer =>
      mutated('LICENSE', (h) => {
        h.fill(0, 0, 100);
        h.write(to, 0, 'latin1');
      });
    await refused(rename('/etc/passwd'), 'unsafe-path', 'is an absolute path');
    await refused(rename('/LICENSE'), 'unsafe-path', 'is an absolute path');
    await refused(rename('../LICENSE'), 'unsafe-path', 'has an empty, "." or ".." segment');
    await refused(rename('bin/../LICENSE'), 'unsafe-path', '".." segment');
    await refused(rename('./LICENSE'), 'unsafe-path', '"." or ".." segment');
    await refused(rename('bin//LICENSE'), 'unsafe-path', 'empty');
    await refused(rename('bin\\LICENSE'), 'unsafe-path', 'backslash or a control character');
    await refused(rename('LICENSE\x01'), 'unsafe-path', 'backslash or a control character');
    await refused(rename(''), 'unsafe-path', 'empty name');
  });
});

describe('entry types and modes', () => {
  it('refuses links, devices, FIFOs, contiguous files and unknown type flags', async () => {
    const typed = (flag: string, extra?: (h: Buffer) => void): Buffer =>
      mutated('LICENSE', (h) => {
        h.write(flag, 156, 'latin1');
        extra?.(h);
      });
    await refused(typed('1'), 'unexpected-entry', 'Entry "LICENSE" is a hard link');
    await refused(typed('2'), 'unexpected-entry', 'Entry "LICENSE" is a symbolic link');
    await refused(typed('3'), 'unexpected-entry', 'is a character device');
    await refused(typed('4'), 'unexpected-entry', 'is a block device');
    await refused(typed('6'), 'unexpected-entry', 'is a FIFO');
    await refused(typed('7'), 'unexpected-entry', 'is a contiguous file');
    await refused(typed('A'), 'unexpected-entry', 'has type flag "A"');
    await refused(typed('S'), 'unexpected-entry', 'has type flag "S"');
    // A symlink shaped like the real thing: a link name and no body.
    await refused(typed('2', (h) => h.write('/etc/passwd', 157, 'latin1')), 'unexpected-entry', 'symbolic link');
  });

  it('refuses PAX and GNU extension entries, including the ones the shared writer makes for long names', async () => {
    await refused(mutated('LICENSE', (h) => h.write('x', 156, 'latin1')), 'unexpected-entry', 'is a PAX extended header');
    await refused(mutated('LICENSE', (h) => h.write('g', 156, 'latin1')), 'unexpected-entry', 'is a PAX global header');
    await refused(mutated('LICENSE', (h) => h.write('L', 156, 'latin1')), 'unexpected-entry', 'is a GNU long name');
    await refused(mutated('LICENSE', (h) => h.write('K', 156, 'latin1')), 'unexpected-entry', 'is a GNU long link');
    const long = 'x'.repeat(300);
    await refused(tarGz([...entries(), { name: long, type: 'file', mode: 0o644, body: 'x' }]), 'unexpected-entry', 'Entry "PaxHeader" is a PAX extended header');
  });

  it('refuses setuid, setgid and sticky bits, and any mode but the layout\'s', async () => {
    await refused(tarGz(entries({ 'config.sh': { mode: 0o4755 } })), 'bad-mode', 'Entry "config.sh" has mode 4755: setuid, setgid and sticky bits are refused.');
    await refused(tarGz(entries({ 'bin/node': { mode: 0o2755 } })), 'bad-mode', 'has mode 2755: setuid');
    await refused(tarGz(entries({ 'bin/': { mode: 0o1755 } })), 'bad-mode', 'has mode 1755: setuid');
    await refused(tarGz(entries({ 'bin/node': { mode: 0o6755 } })), 'bad-mode', 'has mode 6755: setuid');
    await refused(tarGz(entries({ 'run.sh': { mode: 0o644 } })), 'bad-mode', 'Entry "run.sh" has mode 644, not 755.');
    await refused(tarGz(entries({ VERSION: { mode: 0o755 } })), 'bad-mode', 'Entry "VERSION" has mode 755, not 644.');
    await refused(tarGz(entries({ 'bin/': { mode: 0o700 } })), 'bad-mode', 'Entry "bin/" has mode 700, not 755.');
    await refused(tarGz(entries({ LICENSE: { mode: 0o664 } })), 'bad-mode', 'has mode 664, not 644');
    await refused(tarGz(entries({ 'bin/puck-runner.cjs': { mode: 0o755 } })), 'bad-mode', 'has mode 755, not 644');
  });
});

describe('header fields', () => {
  it('verifies the checksum', async () => {
    // The same bytes, one field changed: the checksum no longer matches, and that is what is reported.
    await refused(mutated('LICENSE', (h) => h.write(octal(0o600, 8), 100, 'latin1'), { keepChecksum: true }), 'bad-header', 'wrong checksum');
    await refused(mutated('run.sh', (h) => h.write('X', 0, 'latin1'), { keepChecksum: true }), 'bad-header', 'wrong checksum');
    await refused(mutated('LICENSE', (h) => h.write('0000000\0', 148, 'latin1'), { keepChecksum: true }), 'bad-header', 'wrong checksum');
  });

  it('requires ustar magic and version 00', async () => {
    await refused(mutated('LICENSE', (h) => h.write('ustar  \0', 257, 'latin1')), 'bad-header', 'not ustar');
    await refused(mutated('LICENSE', (h) => h.write('01', 263, 'latin1')), 'bad-header', 'not ustar');
    await refused(mutated('LICENSE', (h) => h.fill(0, 257, 265)), 'bad-header', 'not ustar');
  });

  it('reads octal fields only: no base-256 or other GNU numeric encodings', async () => {
    await refused(mutated('LICENSE', (h) => (h[124] = 0x80)), 'bad-header', 'size field is base-256, a GNU extension');
    await refused(mutated('LICENSE', (h) => h.write('00000000089\0', 124, 'latin1')), 'bad-header', 'size field is not octal');
    await refused(mutated('LICENSE', (h) => h.write('       \0', 124, 'latin1')), 'bad-header', 'size field is not octal');
    await refused(mutated('LICENSE', (h) => h.write('0000x44\0', 100, 'latin1')), 'bad-header', 'mode field is not octal');
    await refused(mutated('LICENSE', (h) => (h[136] = 0xff)), 'bad-header', 'mtime field is base-256');
    await refused(mutated('LICENSE', (h) => h.write('9', 108, 'latin1')), 'bad-header', 'uid field is not octal');
  });

  it('refuses a prefix, a link name on a regular file, a directory with a size, and stray header bytes', async () => {
    await refused(mutated('LICENSE', (h) => h.write('bin', 345, 'latin1')), 'bad-header', 'uses the prefix field');
    await refused(mutated('LICENSE', (h) => h.write('target', 157, 'latin1')), 'bad-header', 'has a link name');
    await refused(mutated('bin/', (h) => h.write(octal(512, 12), 124, 'latin1')), 'bad-header', 'Directory "bin/" has a size');
    await refused(mutated('LICENSE', (h) => (h[500] = 1)), 'bad-header', "bytes in the header's padding");
    await refused(mutated('LICENSE', (h) => (h[8] = 0x41)), 'bad-header', 'name field has bytes after its terminator');
  });

  it('reads the owner names like every text field and requires NUL device numbers, whatever the checksum says', async () => {
    // Each mutation carries a corrected checksum: only the field itself is what refuses the header.
    await refused(mutated('LICENSE', (h) => h.write('root\0x', 265, 'latin1')), 'bad-header', 'uname field has bytes after its terminator');
    await refused(mutated('LICENSE', (h) => (h[296] = 0xff)), 'bad-header', 'uname field has bytes after its terminator');
    await refused(mutated('LICENSE', (h) => h.write('root\0x', 297, 'latin1')), 'bad-header', 'gname field has bytes after its terminator');
    await refused(mutated('LICENSE', (h) => (h[328] = 0xff)), 'bad-header', 'gname field has bytes after its terminator');
    await refused(mutated('LICENSE', (h) => (h[329] = 0xff)), 'bad-header', 'has device numbers');
    await refused(mutated('LICENSE', (h) => h.write('0000001\0', 329, 'latin1')), 'bad-header', 'has device numbers');
    await refused(mutated('LICENSE', (h) => (h[337] = 0xff)), 'bad-header', 'has device numbers');
    await refused(mutated('LICENSE', (h) => h.write('0000001\0', 337, 'latin1')), 'bad-header', 'has device numbers');
    await refused(mutated('bin/', (h) => (h[344] = 0x01)), 'bad-header', 'has device numbers');
    // Owner names that fill their field, and the packager's own, are fine.
    expectLayout((await unpack(mutated('LICENSE', (h) => h.write('x'.repeat(32), 265, 'latin1')))).dir);
    expectLayout((await unpack(mutated('LICENSE', (h) => h.write('wheel', 297, 'latin1')))).dir);
  });

  it('requires NUL padding after a body', async () => {
    const raw = Buffer.from(tar(entries()));
    const { body, size } = locate(raw, 'LICENSE');
    raw[body + size] = 0x41;
    await refused(gzipSync(raw), 'bad-header', 'padded with bytes other than NUL');
  });
});

describe('the stream and the trailer', () => {
  it('requires the two-block trailer and nothing after it', async () => {
    const raw = Buffer.from(tar(entries()));
    await refused(gzipSync(raw.subarray(0, raw.length - 512)), 'truncated', 'ended before its trailer');
    await refused(gzipSync(raw.subarray(0, raw.length - 1024)), 'truncated', 'ended before its trailer');
    await refused(gzipSync(raw.subarray(0, raw.length - 1024 - 100)), 'truncated', 'ended before its trailer');
    await refused(gzipSync(Buffer.concat([raw, Buffer.alloc(512)])), 'trailing-data', 'bytes after its trailer');
    await refused(gzipSync(Buffer.concat([raw, Buffer.alloc(1)])), 'trailing-data', 'bytes after its trailer');
    await refused(gzipSync(Buffer.concat([raw, raw])), 'trailing-data', 'bytes after its trailer');
    const withoutTrailer = raw.subarray(0, raw.length - 1024);
    await refused(gzipSync(Buffer.concat([withoutTrailer, Buffer.alloc(512), withoutTrailer, Buffer.alloc(1024)])), 'bad-header', 'An entry follows a zero block');
  });

  it('reads exactly one gzip member: nothing before it, between its deflate stream and its trailer, or after', async () => {
    const raw = Buffer.from(tar(entries()));
    const gz = gzipSync(raw, { level: 9 });
    const empty = gzipSync(Buffer.alloc(0));
    const ONE_MEMBER = 'a package is one gzip member and nothing else';
    // gunzip would join or ignore every one of these; the reader refuses them all.
    await refused(Buffer.concat([gz, empty]), 'trailing-data', ONE_MEMBER);
    await refused(Buffer.concat([empty, gz]), 'trailing-data', ONE_MEMBER);
    await refused(Buffer.concat([gzipSync(raw.subarray(0, 3000)), gzipSync(raw.subarray(3000))]), 'trailing-data', ONE_MEMBER);
    await refused(Buffer.concat([gz, gz]), 'trailing-data', ONE_MEMBER);
    await refused(Buffer.concat([gz, Buffer.from([0]), Buffer.from('trailing garbage')]), 'trailing-data', ONE_MEMBER);
    await refused(Buffer.concat([gz, Buffer.alloc(8)]), 'trailing-data', ONE_MEMBER);
    await refused(Buffer.concat([gz, Buffer.from('garbage')]), 'trailing-data', ONE_MEMBER);
    await refused(Buffer.concat([gz, Buffer.from([0])]), 'trailing-data', ONE_MEMBER);
    // A member is intact only with its own trailer: the CRC-32 and the inflated size.
    for (const at of [gz.length - 8, gz.length - 5, gz.length - 4, gz.length - 1]) {
      const bad = Buffer.from(gz);
      bad[at] ^= 0x01;
      await refused(bad, 'corrupt', 'gzip trailer does not match its contents');
    }
    // One byte short: the trailer is then the deflate stream's last bytes, so the stream itself ends early.
    await refused(gz.subarray(0, gz.length - 1), 'truncated', 'gzip stream ended early');
  });

  it('takes the fixed gzip header only: deflate, no optional fields', async () => {
    const gz = tarGz(entries());
    expect(gz.subarray(0, 4)).toEqual(Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    const withFlag = (flag: number): Buffer => {
      const out = Buffer.from(gz);
      out[3] = flag;
      return out;
    };
    for (const [flag, what] of [
      [0x01, 'text'],
      [0x02, 'header CRC'],
      [0x04, 'extra field'],
      [0x08, 'name'],
      [0x10, 'comment'],
      [0x20, 'reserved'],
    ] as [number, string][]) {
      await refused(withFlag(flag), 'corrupt', new RegExp(`gzip header sets flags.*${what === 'text' || what === 'reserved' ? '' : what}`));
    }
    const method = Buffer.from(gz);
    method[2] = 0x09;
    await refused(method, 'corrupt', 'compression method 9, not deflate');
    const magic = Buffer.from(gz);
    magic[1] = 0x8c;
    await refused(magic, 'corrupt', 'not a gzip file');
    await refused(Buffer.from('not a gzip stream at all'), 'corrupt', 'not a gzip file');
    for (const short of [gz.subarray(0, 10), gz.subarray(0, 18), Buffer.alloc(0)]) await refused(short, 'corrupt', 'too short to be a gzip file');
  });

  it('refuses a truncated or corrupt deflate stream', async () => {
    const gz = tarGz(entries());
    await refused(gz.subarray(0, gz.length - 100), 'truncated', 'gzip stream ended early');
    await refused(gz.subarray(0, 40), 'truncated', 'gzip stream ended early');
    const flipped = Buffer.from(gz);
    flipped[gz.length - 30] ^= 0xff;
    expect((await failure(unpack(flipped))).code).toMatch(/corrupt|truncated/);
    expect(readdirSync(into)).toEqual([]);
    const garbageBody = Buffer.concat([gz.subarray(0, 10), Buffer.from('this is not a deflate stream, whatever the framing says'), gz.subarray(gz.length - 8)]);
    await refused(garbageBody, 'corrupt', 'not a readable gzip stream');
  });

  it('caps what the package may inflate to, and how large the file may be', async () => {
    expect(MAX_UNPACKED_BYTES).toBe(512 * 1024 * 1024);
    const gz = tarGz(entries());
    const f = await failure(unpack(gz, VERSION, 64 * 1024));
    expect(f).toEqual({ code: 'too-large', message: 'The package inflates to over 65536 bytes.' });
    expect(readdirSync(into)).toEqual([]);
    const fits = await unpack(gz, VERSION, 2 * 1024 * 1024);
    expectLayout(fits.dir);
    rmSync(fits.dir, { recursive: true, force: true });
    const sparse = write(gz);
    truncateSync(sparse, MAX_PACKAGE_BYTES + 1);
    const large = await failure(unpackRunnerPackage(sparse, { into, version: VERSION }));
    expect(large).toEqual({ code: 'too-large', message: `The package is ${MAX_PACKAGE_BYTES + 1} bytes; at most ${MAX_PACKAGE_BYTES} are read.` });
    expect(readdirSync(into)).toEqual([]);
  });
});

describe('VERSION', () => {
  it('must be exactly the expected version and a newline', async () => {
    await refused(tarGz(entries()), 'version-mismatch', 'VERSION says "1.2.3", not 1.2.4.', '1.2.4');
    await refused(tarGz(entries({ VERSION: { body: '1.2.3' } })), 'version-mismatch', 'not 1.2.3');
    await refused(tarGz(entries({ VERSION: { body: '1.2.3\n\n' } })), 'version-mismatch', 'not 1.2.3');
    await refused(tarGz(entries({ VERSION: { body: ' 1.2.3\n' } })), 'version-mismatch', 'not 1.2.3');
    await refused(tarGz(entries({ VERSION: { body: '' } })), 'version-mismatch', 'VERSION says ""');
    await refused(tarGz(entries({ VERSION: { body: `${'9'.repeat(70)}\n` } })), 'version-mismatch', 'VERSION is 71 bytes');
  });
});

describe('staging', () => {
  it('needs an existing parent, and removes its directory on every failure', async () => {
    const missing = join(into, 'missing');
    const f = await failure(unpackRunnerPackage(write(tarGz(entries())), { into: missing, version: VERSION }));
    expect(f.code).toBe('write-failed');
    expect(existsSync(missing)).toBe(false);
    // A failure late in the stream, after files were written, still leaves nothing.
    const late = tarGz([...entries(), { name: 'zzz-extra', type: 'file', mode: 0o644, body: 'x' }]);
    expect((await failure(unpack(late))).code).toBe('unexpected-entry');
    expect(readdirSync(into)).toEqual([]);
    // Each read gets its own directory; a second read beside a first leaves the first alone.
    const first = await unpack(tarGz(entries()));
    const second = await unpack(tarGz(entries()));
    expect(first.dir).not.toBe(second.dir);
    expect(readdirSync(into).sort()).toEqual([first.dir, second.dir].map((d) => d.slice(into.length + 1)).sort());
    mkdirSync(join(into, 'other'));
    expect((await failure(unpack(tarGz(entries({ LICENSE: null }))))).code).toBe('missing-entry');
    expect(readdirSync(into).sort()).toEqual([first.dir, second.dir].map((d) => d.slice(into.length + 1)).concat('other').sort());
  });

  it('removes the staging directory when bin/ cannot be created', async () => {
    plantBin.on = true;
    const f = await failure(unpack(tarGz(entries())));
    expect(f.code).toBe('write-failed');
    expect(readdirSync(into)).toEqual([]);
  });

  it('closes a file whose open was still in flight when the stream failed, before it rejects and removes staging', async () => {
    // The read stream fails the moment the first entry's open begins, and that open takes a while.
    slowOpen.ms = 150;
    slowOpen.failSourceOnOpen = true;
    const f = await failure(unpack(tarGz(entries())));
    expect(f).toEqual({ code: 'corrupt', message: 'Reading the package failed: the disk read failed' });
    // By the time the caller hears of the failure, the late open has completed and its handle is closed.
    expect(slowOpen.events).toEqual(['opened config.sh', 'closed config.sh']);
    expect(readdirSync(into)).toEqual([]);
    // The same ordering when the sink itself is what fails, with an open in flight for the next entry.
    slowOpen.events = [];
    const g = await failure(unpack(tarGz(entries({ 'run.sh': { mode: 0o4755 } }))));
    expect(g.code).toBe('bad-mode');
    expect(slowOpen.events).toEqual(['opened config.sh', 'closed config.sh']);
    expect(readdirSync(into)).toEqual([]);
  });

  it('fails with write-failed and removes staging when a file write persists only a prefix, or nothing', async () => {
    for (const mode of ['half', 'zero'] as const) {
      shortWrite.mode = mode;
      shortWrite.opened = 0;
      const f = await failure(unpack(tarGz(entries())));
      expect(f.code, mode).toBe('write-failed');
      expect(f.message, mode).toMatch(/Cannot write config\.sh in staging: wrote none of the remaining \d+ bytes/);
      expect(shortWrite.opened, mode).toBe(1);
      expect(readdirSync(into), mode).toEqual([]);
    }
    shortWrite.mode = null;
    expectLayout((await unpack(tarGz(entries()))).dir);
  });
});
