import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, zipBuffer } from '../../src/main/zip';

/** An independent reader: walks the central directory back to each local entry. */
function readZip(zip: Buffer): Array<{ name: string; data: Buffer; method: number }> {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  let pos = zip.readUInt32LE(eocd + 16);
  expect(pos + centralSize).toBe(eocd);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(pos)).toBe(0x02014b50);
    const method = zip.readUInt16LE(pos + 10);
    const crc = zip.readUInt32LE(pos + 16);
    const csize = zip.readUInt32LE(pos + 20);
    const usize = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28);
    const localOffset = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen;

    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    expect(zip.readUInt16LE(localOffset + 8)).toBe(method);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const payload = zip.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(payload) : Buffer.from(payload);
    expect(data.length).toBe(usize);
    expect(crc32(data)).toBe(crc);
    out.push({ name, data, method });
  }
  return out;
}

describe('crc32', () => {
  it('matches the reference vectors', () => {
    expect(crc32(Buffer.from(''))).toBe(0);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.from('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});

describe('zipBuffer', () => {
  it('round-trips text and binary entries, deflating text and storing incompressible data', () => {
    const text = 'line\n'.repeat(400);
    const random = crypto.randomBytes(4096);
    const zip = zipBuffer(
      [
        { name: 'summary.json', data: '{"ok":true}' },
        { name: 'logs/puck.log', data: text },
        { name: 'blob.bin', data: random },
      ],
      new Date(2026, 8, 23, 12, 0, 0),
    );
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['summary.json', 'logs/puck.log', 'blob.bin']);
    expect(entries[0].data.toString()).toBe('{"ok":true}');
    expect(entries[1].data.toString()).toBe(text);
    expect(entries[1].method).toBe(8);
    expect(entries[2].data.equals(random)).toBe(true);
    expect(entries[2].method).toBe(0);
  });

  it('keeps UTF-8 names and the empty archive well-formed', () => {
    const zip = zipBuffer([{ name: 'ünïcødé/файл.txt', data: 'x' }]);
    expect(readZip(zip)[0].name).toBe('ünïcødé/файл.txt');
    expect(readZip(zipBuffer([]))).toEqual([]);
  });

  it('records a DOS timestamp no earlier than 1980', () => {
    const zip = zipBuffer([{ name: 'a', data: 'a', mtime: new Date(1970, 0, 1) }]);
    const date = zip.readUInt16LE(12);
    expect(date >> 9).toBe(0); // 1980
    expect((date >> 5) & 0xf).toBe(1);
    expect(date & 0x1f).toBe(1);
  });
});
