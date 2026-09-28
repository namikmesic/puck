/**
 * A small ustar writer: the runner copies files into environment containers
 * with `docker cp - <container>:/` from a tar stream built here, so every
 * file's owner and mode is explicit and nothing touches a host temp
 * directory. The runner packaging script builds its release tarballs with
 * it too, which is why this module imports nothing but Node built-ins and
 * uses only type syntax Node can strip.
 *
 * Names up to 100 bytes go in the name field; longer ones split into the
 * 155-byte prefix and the name at a slash; anything still too long gets a
 * PAX extended header carrying the full path.
 */

import { gzipSync } from 'node:zlib';

export interface TarEntry {
  /** Relative path with forward slashes; directories may end with '/'. */
  name: string;
  type: 'file' | 'dir';
  mode: number;
  uid?: number;
  gid?: number;
  /** Seconds since the epoch; defaults to 0 so archives are reproducible. */
  mtime?: number;
  body?: string | Buffer;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  // width includes the trailing NUL
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function writeString(buf: Buffer, offset: number, width: number, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > width) throw new Error(`tar field overflow: ${text}`);
  bytes.copy(buf, offset);
}

/** Splits a long name into ustar prefix and name, or null when no slash makes both fit. */
export function splitName(name: string): { prefix: string; name: string } | null {
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes <= 100) return { prefix: '', name };
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(rest, 'utf8') <= 100 && rest.length > 0) {
      return { prefix, name: rest };
    }
  }
  return null;
}

function header(fields: {
  name: string;
  prefix: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  typeflag: string;
}): Buffer {
  const h = Buffer.alloc(BLOCK);
  writeString(h, 0, 100, fields.name);
  writeString(h, 100, 8, octal(fields.mode & 0o7777, 8));
  writeString(h, 108, 8, octal(fields.uid, 8));
  writeString(h, 116, 8, octal(fields.gid, 8));
  writeString(h, 124, 12, octal(fields.size, 12));
  writeString(h, 136, 12, octal(fields.mtime, 12));
  h.fill(0x20, 148, 156); // checksum field counts as spaces
  writeString(h, 156, 1, fields.typeflag);
  writeString(h, 257, 6, 'ustar\0');
  writeString(h, 263, 2, '00');
  writeString(h, 265, 32, fields.uid === 0 ? 'root' : '');
  writeString(h, 297, 32, fields.gid === 0 ? 'root' : '');
  writeString(h, 345, 155, fields.prefix);
  let sum = 0;
  for (const b of h) sum += b;
  writeString(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

function padded(body: Buffer): Buffer[] {
  const rest = body.length % BLOCK;
  return rest ? [body, Buffer.alloc(BLOCK - rest)] : [body];
}

/** One PAX record: "<len> path=<value>\n", where len counts the whole record. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body, 'utf8') + 1;
  while (String(len).length + Buffer.byteLength(body, 'utf8') !== len) len++;
  return `${len}${body}`;
}

export function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    let name = e.name.replace(/^\.?\/+/, '');
    if (!name || name.split('/').includes('..')) throw new Error(`unsafe tar path: ${e.name}`);
    if (e.type === 'dir' && !name.endsWith('/')) name += '/';
    const body = e.type === 'file' ? (typeof e.body === 'string' ? Buffer.from(e.body, 'utf8') : (e.body ?? Buffer.alloc(0))) : Buffer.alloc(0);
    const uid = e.uid ?? 0;
    const gid = e.gid ?? 0;
    const mtime = e.mtime ?? 0;
    let split = splitName(name);
    if (!split) {
      const pax = Buffer.from(paxRecord('path', name), 'utf8');
      parts.push(header({ name: 'PaxHeader', prefix: '', mode: 0o644, uid, gid, size: pax.length, mtime, typeflag: 'x' }), ...padded(pax));
      split = { prefix: '', name: name.slice(0, 100) };
    }
    const typeflag = e.type === 'dir' ? '5' : '0';
    parts.push(header({ ...split, mode: e.mode, uid, gid, size: body.length, mtime, typeflag }));
    if (body.length) parts.push(...padded(body));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export function tarGz(entries: TarEntry[]): Buffer {
  return gzipSync(tar(entries), { level: 9 });
}
