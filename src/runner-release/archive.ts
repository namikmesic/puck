/**
 * Reads a runner package (a gzipped ustar archive, as
 * scripts/package-runner.mjs writes one) into a private staging directory,
 * accepting only the fixed layout RUNNER_PACKAGE_ENTRIES: nine regular
 * files and `bin/`, each once, with the packager's exact modes. Node
 * built-ins only; system tar is never run, so what was checked is what
 * was written. Nothing here runs or installs anything: a caller activates
 * a staging directory itself, after its own checks.
 *
 * The file is one gzip member and nothing else, framed here rather than by
 * zlib's gunzip (which joins concatenated members and ignores trailing
 * NULs): a fixed ten-byte header with no optional fields, one raw deflate
 * stream that must consume every byte up to the eight-byte trailer, and a
 * trailer whose CRC-32 and size must match what was inflated. A second
 * member, bytes between the stream and the trailer, or bytes after the
 * trailer fail the read.
 *
 * The deflate stream is inflated as a stream and read block by block.
 * Every header must be ustar (magic `ustar\0`, version `00`) with a
 * verified checksum, octal fields (no base-256), an empty prefix and link
 * name, and a type flag of a regular file or a directory: links, devices,
 * FIFOs, PAX and GNU extension entries are refused. A name must be exactly
 * one of the layout's; absolute, traversing or otherwise unsafe paths are
 * refused before that lookup. Modes must equal the layout's, so setuid,
 * setgid and sticky bits never pass. After the last entry come two zero
 * blocks and nothing else; a further byte, a missing trailer, a member
 * seen twice or a member missing fails the read. Inflated bytes are
 * counted against MAX_UNPACKED_BYTES and the compressed file against
 * MAX_PACKAGE_BYTES.
 *
 * Entries are written as they are validated, into a fresh directory of
 * mode 0700 under the caller's parent, with the layout's modes. VERSION
 * must read exactly the expected version. Any failure removes the
 * directory and throws RunnerArchiveError.
 *
 * Only erasable TypeScript here (see verify.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { crc32, createInflateRaw } from 'node:zlib';
import { RUNNER_PACKAGE_ENTRIES, type RunnerPackageEntry } from '../harness/runner-releases';
import { MAX_PACKAGE_BYTES, writeAll } from './download';

/** Most bytes a package may inflate to. */
export const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
/** Most bytes VERSION may have; a version line is a few. */
const MAX_VERSION_BYTES = 64;
const BLOCK = 512;
/** A gzip member: ID1, ID2, CM, FLG, MTIME(4), XFL, OS; then the deflate stream; then CRC-32 and ISIZE, little-endian. */
const GZIP_HEADER_BYTES = 10;
const GZIP_TRAILER_BYTES = 8;

export type RunnerArchiveErrorCode =
  /** Not one plain gzip member with a matching trailer, or a corrupt deflate stream. */
  | 'corrupt'
  /** A header's checksum, magic, version or fields are wrong. */
  | 'bad-header'
  /** An entry the layout has no place for: another name, type or extension entry. */
  | 'unexpected-entry'
  /** An absolute or traversing path. */
  | 'unsafe-path'
  | 'duplicate-entry'
  | 'missing-entry'
  /** A mode other than the layout's (setuid, setgid and sticky bits included). */
  | 'bad-mode'
  /** Over MAX_UNPACKED_BYTES inflated, or MAX_PACKAGE_BYTES compressed. */
  | 'too-large'
  /** The stream ended before the trailer. */
  | 'truncated'
  /** Bytes after the two-block tar trailer, or between the deflate stream and the gzip trailer (a second member, say). */
  | 'trailing-data'
  /** VERSION is not the expected version. */
  | 'version-mismatch'
  /** Staging could not be created or written. */
  | 'write-failed';

export class RunnerArchiveError extends Error {
  readonly code: RunnerArchiveErrorCode;

  constructor(code: RunnerArchiveErrorCode, message: string) {
    super(message);
    this.name = 'RunnerArchiveError';
    this.code = code;
  }
}

export interface UnpackOptions {
  /** An existing directory the private staging directory is made under. */
  into: string;
  /** What VERSION must say. */
  version: string;
  /** Test seam; MAX_UNPACKED_BYTES is the contract. */
  maxUnpackedBytes?: number;
}

export interface UnpackedPackage {
  /** The staging directory: mode 0700, holding exactly the layout. */
  dir: string;
}

const fail = (code: RunnerArchiveErrorCode, message: string): RunnerArchiveError => new RunnerArchiveError(code, message);
const header = (message: string): RunnerArchiveError => fail('bad-header', message);

/** A NUL-terminated text field; bytes after the terminator must be NUL. */
function text(block: Buffer, at: number, length: number, what: string): string {
  const field = block.subarray(at, at + length);
  const end = field.indexOf(0);
  if (end !== -1 && field.subarray(end).some((b) => b !== 0)) throw header(`The ${what} field has bytes after its terminator.`);
  return (end === -1 ? field : field.subarray(0, end)).toString('latin1');
}

/** An octal field: digits, then NUL or space terminators. Base-256 (a GNU extension) is refused. */
function octal(block: Buffer, at: number, length: number, what: string): number {
  const field = block.subarray(at, at + length);
  if (field[0] & 0x80) throw header(`The ${what} field is base-256, a GNU extension.`);
  let end = length;
  while (end > 0 && (field[end - 1] === 0 || field[end - 1] === 0x20)) end--;
  const digits = field.subarray(0, end).toString('latin1');
  if (!/^[0-7]{1,11}$/.test(digits)) throw header(`The ${what} field is not octal.`);
  return parseInt(digits, 8);
}

const allZero = (bytes: Buffer): boolean => bytes.every((b) => b === 0);

/** The fixed gzip header: deflate, and no optional field (zlib writes a package that way). */
function checkGzipHeader(head: Buffer): void {
  if (head[0] !== 0x1f || head[1] !== 0x8b) throw fail('corrupt', 'The package is not a gzip file.');
  if (head[2] !== 8) throw fail('corrupt', `The package's gzip member uses compression method ${head[2]}, not deflate.`);
  if (head[3] !== 0) throw fail('corrupt', "The package's gzip header sets flags (an extra field, a name, a comment, a header CRC or a reserved bit); packages carry none.");
}

/** Exactly `length` bytes at `position` of an open file. */
function readAt(fd: number, position: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, out, got, length - got, position + got);
    if (n <= 0) throw fail('corrupt', 'The package file is shorter than its size says.');
    got += n;
  }
  return out;
}

/** The typeflags this reader refuses, named for the error. */
const REFUSED_TYPES: Record<string, string> = {
  '1': 'a hard link',
  '2': 'a symbolic link',
  '3': 'a character device',
  '4': 'a block device',
  '6': 'a FIFO',
  '7': 'a contiguous file',
  x: 'a PAX extended header',
  g: 'a PAX global header',
  L: 'a GNU long name',
  K: 'a GNU long link',
};

interface Entry {
  spec: RunnerPackageEntry;
  size: number;
}

/** Checks the path before anything is looked up: relative, forward slashes, no `.` or `..`, no empty segment but a directory's last. */
function checkPath(name: string): void {
  if (!name) throw fail('unsafe-path', 'An entry has an empty name.');
  if (name.startsWith('/')) throw fail('unsafe-path', `Entry ${JSON.stringify(name)} is an absolute path.`);
  // eslint-disable-next-line no-control-regex
  if (name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name)) throw fail('unsafe-path', `Entry ${JSON.stringify(name)} has a backslash or a control character.`);
  const segments = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw fail('unsafe-path', `Entry ${JSON.stringify(name)} has an empty, "." or ".." segment.`);
}

/** Reads and validates one non-zero header block against the layout. */
function readHeader(block: Buffer, seen: Set<string>): Entry {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
  if (sum !== octal(block, 148, 8, 'checksum')) throw header('An entry header has a wrong checksum.');
  if (text(block, 257, 6, 'magic') !== 'ustar' || block[262] !== 0 || block.subarray(263, 265).toString('latin1') !== '00') {
    throw header('An entry header is not ustar (magic "ustar\\0", version "00").');
  }
  const type = String.fromCharCode(block[156]);
  const name = text(block, 0, 100, 'name');
  const refused = REFUSED_TYPES[type];
  if (refused) throw fail('unexpected-entry', `Entry ${JSON.stringify(name)} is ${refused}; a package holds regular files and bin/ only.`);
  if (type !== '0' && type !== '\0' && type !== '5') throw fail('unexpected-entry', `Entry ${JSON.stringify(name)} has type flag ${JSON.stringify(type)}.`);
  if (!allZero(block.subarray(157, 257))) throw header(`Entry ${JSON.stringify(name)} has a link name.`);
  if (!allZero(block.subarray(345, 500))) throw header(`Entry ${JSON.stringify(name)} uses the prefix field; package names are short.`);
  if (!allZero(block.subarray(500, BLOCK))) throw header(`Entry ${JSON.stringify(name)} has bytes in the header's padding.`);
  const mode = octal(block, 100, 8, 'mode');
  octal(block, 108, 8, 'uid');
  octal(block, 116, 8, 'gid');
  const size = octal(block, 124, 12, 'size');
  octal(block, 136, 12, 'mtime');
  checkPath(name);
  const spec = RUNNER_PACKAGE_ENTRIES.find((e) => e.name === name);
  const isDir = type === '5';
  if (!spec || (spec.type === 'dir') !== isDir) throw fail('unexpected-entry', `Entry ${JSON.stringify(name)}${isDir ? ' (a directory)' : ''} is not part of a runner package.`);
  if (seen.has(name)) throw fail('duplicate-entry', `Entry ${JSON.stringify(name)} appears twice.`);
  if (mode & 0o7000) throw fail('bad-mode', `Entry ${JSON.stringify(name)} has mode ${mode.toString(8)}: setuid, setgid and sticky bits are refused.`);
  if (mode !== spec.mode) throw fail('bad-mode', `Entry ${JSON.stringify(name)} has mode ${mode.toString(8)}, not ${spec.mode.toString(8)}.`);
  if (isDir && size !== 0) throw header(`Directory ${JSON.stringify(name)} has a size.`);
  if (name === 'VERSION' && size > MAX_VERSION_BYTES) throw fail('version-mismatch', `VERSION is ${size} bytes; a version line is under ${MAX_VERSION_BYTES}.`);
  seen.add(name);
  return { spec, size };
}

/**
 * The block reader: a Writable fed the inflated archive. It validates each
 * header, streams each file's bytes into staging, and insists on the
 * trailer and on nothing after it.
 */
class PackageSink extends Writable {
  private pending: Buffer = Buffer.alloc(0);
  private inflated = 0;
  private crc = 0;
  private zeroBlocks = 0;
  private current: { entry: Entry; remaining: number; padding: number; file: fs.promises.FileHandle | null; version: Buffer[] } | null = null;
  readonly seen = new Set<string>();
  private readonly dir: string;
  private readonly version: string;
  private readonly maxUnpackedBytes: number;

  constructor(dir: string, version: string, maxUnpackedBytes: number) {
    super();
    this.dir = dir;
    this.version = version;
    this.maxUnpackedBytes = maxUnpackedBytes;
  }

  /** What the gzip trailer must name: the inflated byte count and its CRC-32. */
  get inflatedBytes(): number {
    return this.inflated;
  }

  get inflatedCrc32(): number {
    return this.crc;
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.consume(chunk).then(() => callback(), callback);
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.current || this.pending.length || this.zeroBlocks !== 2) {
      callback(fail('truncated', 'The archive ended before its trailer.'));
      return;
    }
    const missing = RUNNER_PACKAGE_ENTRIES.filter((e) => !this.seen.has(e.name)).map((e) => e.name);
    callback(missing.length ? fail('missing-entry', `The package lacks ${missing.join(', ')}.`) : null);
  }

  /** Closes an open file after a failure; pipeline destroys the stream before _final runs. */
  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    const file = this.current?.file ?? null;
    this.current = null;
    (file ? file.close().catch(() => undefined) : Promise.resolve()).then(() => callback(error));
  }

  private async consume(chunk: Buffer): Promise<void> {
    this.inflated += chunk.length;
    if (this.inflated > this.maxUnpackedBytes) throw fail('too-large', `The package inflates to over ${this.maxUnpackedBytes} bytes.`);
    this.crc = crc32(chunk, this.crc);
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    let at = 0;
    while (at < buf.length) {
      if (this.current) {
        at = await this.body(buf, at);
        continue;
      }
      if (this.zeroBlocks === 2) throw fail('trailing-data', 'The archive has bytes after its trailer.');
      if (buf.length - at < BLOCK) {
        this.pending = Buffer.from(buf.subarray(at));
        return;
      }
      const block = buf.subarray(at, at + BLOCK);
      at += BLOCK;
      if (allZero(block)) {
        this.zeroBlocks++;
        continue;
      }
      if (this.zeroBlocks) throw fail('bad-header', 'An entry follows a zero block; the trailer is two zero blocks and nothing else.');
      await this.open(readHeader(block, this.seen));
      buf = buf.subarray(at);
      at = 0;
    }
  }

  private async open(entry: Entry): Promise<void> {
    const { spec, size } = entry;
    let file: fs.promises.FileHandle | null = null;
    if (spec.type === 'file') {
      try {
        // bin/ is made with the staging directory; every file is this read's own.
        file = await fs.promises.open(path.join(this.dir, spec.name), 'wx', spec.mode);
        await file.chmod(spec.mode);
      } catch (err) {
        throw fail('write-failed', `Cannot create ${spec.name} in staging: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.current = { entry, remaining: size, padding: (BLOCK - (size % BLOCK)) % BLOCK, file, version: [] };
    if (size === 0) await this.finish();
  }

  /** Consumes an entry's bytes and padding from `buf` at `at`; returns where it stopped. */
  private async body(buf: Buffer, at: number): Promise<number> {
    const current = this.current;
    if (!current) return at;
    if (current.remaining > 0) {
      const take = Math.min(current.remaining, buf.length - at);
      const bytes = buf.subarray(at, at + take);
      if (current.entry.spec.name === 'VERSION') current.version.push(Buffer.from(bytes));
      if (current.file) {
        try {
          await writeAll(current.file, bytes);
        } catch (err) {
          throw fail('write-failed', `Cannot write ${current.entry.spec.name} in staging: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      current.remaining -= take;
      at += take;
    }
    if (current.remaining === 0 && current.padding > 0) {
      const take = Math.min(current.padding, buf.length - at);
      if (!allZero(buf.subarray(at, at + take))) throw header(`Entry ${JSON.stringify(current.entry.spec.name)} is padded with bytes other than NUL.`);
      current.padding -= take;
      at += take;
    }
    if (current.remaining === 0 && current.padding === 0) await this.finish();
    return at;
  }

  private async finish(): Promise<void> {
    const current = this.current;
    if (!current) return;
    this.current = null;
    if (current.file) await current.file.close();
    if (current.entry.spec.name === 'VERSION' && Buffer.concat(current.version).toString('utf8') !== `${this.version}\n`) {
      throw fail('version-mismatch', `VERSION says ${JSON.stringify(Buffer.concat(current.version).toString('utf8').trim().slice(0, 40))}, not ${this.version}.`);
    }
  }
}

/** Maps a stream failure to a RunnerArchiveError. */
function archiveError(err: unknown): RunnerArchiveError {
  if (err instanceof RunnerArchiveError) return err;
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (code === 'Z_BUF_ERROR') return fail('truncated', 'The gzip stream ended early.');
  if (typeof code === 'string' && code.startsWith('Z_')) return fail('corrupt', `The package is not a readable gzip stream (${code}).`);
  return fail('corrupt', `Reading the package failed: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Reads the package at `archive` into a new private directory under
 * `opts.into` (see the header). Resolves with that directory; throws
 * RunnerArchiveError with the directory removed.
 */
export async function unpackRunnerPackage(archive: string, opts: UnpackOptions): Promise<UnpackedPackage> {
  let size: number;
  try {
    size = fs.statSync(archive).size;
  } catch (err) {
    throw fail('corrupt', `Cannot read ${archive}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (size > MAX_PACKAGE_BYTES) throw fail('too-large', `The package is ${size} bytes; at most ${MAX_PACKAGE_BYTES} are read.`);
  if (size <= GZIP_HEADER_BYTES + GZIP_TRAILER_BYTES) throw fail('corrupt', 'The package is too short to be a gzip file.');
  let head: Buffer;
  let trailer: Buffer;
  let fd: number;
  try {
    fd = fs.openSync(archive, 'r');
  } catch (err) {
    throw fail('corrupt', `Cannot read ${archive}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    head = readAt(fd, 0, GZIP_HEADER_BYTES);
    trailer = readAt(fd, size - GZIP_TRAILER_BYTES, GZIP_TRAILER_BYTES);
  } finally {
    fs.closeSync(fd);
  }
  checkGzipHeader(head);
  const deflateBytes = size - GZIP_HEADER_BYTES - GZIP_TRAILER_BYTES;
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(opts.into, 'puck-runner-'));
  } catch (err) {
    throw fail('write-failed', `Cannot make a staging directory under ${opts.into}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    fs.chmodSync(dir, 0o700);
    const bin = RUNNER_PACKAGE_ENTRIES.find((e) => e.type === 'dir') as RunnerPackageEntry;
    fs.mkdirSync(path.join(dir, bin.name), { mode: bin.mode });
    fs.chmodSync(path.join(dir, bin.name), bin.mode);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw fail('write-failed', `Cannot make a staging directory under ${opts.into}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const sink = new PackageSink(dir, opts.version, opts.maxUnpackedBytes ?? MAX_UNPACKED_BYTES);
  try {
    await new Promise<void>((resolve, reject) => {
      // Only the bytes between the gzip header and trailer reach the inflater.
      const source = fs.createReadStream(archive, { start: GZIP_HEADER_BYTES, end: size - GZIP_TRAILER_BYTES - 1 });
      const inflate = createInflateRaw();
      let settled = false;
      // The first failure anywhere ends all three streams; the sink closes its file as it is destroyed.
      const end = (err: unknown): void => {
        if (settled) return;
        settled = true;
        source.destroy();
        inflate.destroy();
        sink.destroy();
        reject(err);
      };
      source.on('error', end);
      inflate.on('error', end);
      sink.on('error', end);
      // The deflate stream ended: it must have consumed every byte before the trailer. Registered
      // before the pipe's own 'end' listener, so a leftover is reported before the sink judges the tar.
      inflate.on('end', () => {
        const leftover = deflateBytes - inflate.bytesWritten;
        if (leftover !== 0) {
          end(fail('trailing-data', `The package has ${leftover} bytes between its deflate stream and its gzip trailer (a second gzip member, or other data); a package is one gzip member and nothing else.`));
        }
      });
      sink.on('finish', () => {
        if (settled) return;
        settled = true;
        source.destroy();
        resolve();
      });
      source.pipe(inflate).pipe(sink);
    });
    if (trailer.readUInt32LE(0) !== sink.inflatedCrc32 || trailer.readUInt32LE(4) !== sink.inflatedBytes % 0x1_0000_0000) {
      throw fail('corrupt', "The package's gzip trailer does not match its contents.");
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw archiveError(err);
  }
  return { dir };
}
