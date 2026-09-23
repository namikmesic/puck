import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJson, writeJsonAtomic } from '../../src/main/jsonstore';

describe('jsonstore', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-jsonstore-'));

  it('round-trips values and creates parent dirs', async () => {
    const file = path.join(dir, 'nested', 'a.json');
    await writeJsonAtomic(file, { x: 1 });
    expect(readJson(file)).toEqual({ x: 1 });
  });

  it('returns null on garbage or missing files', () => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{truncated');
    expect(readJson(file)).toBeNull();
    expect(readJson(path.join(dir, 'missing.json'))).toBeNull();
  });

  it('serializes concurrent writes — last queued wins, no interleaving', async () => {
    const file = path.join(dir, 'chain.json');
    await Promise.all([
      writeJsonAtomic(file, { seq: 1 }),
      writeJsonAtomic(file, { seq: 2 }),
      writeJsonAtomic(file, { seq: 3 }),
    ]);
    expect(readJson(file)).toEqual({ seq: 3 });
  });

  it('leaves no temp files behind', async () => {
    const file = path.join(dir, 'clean.json');
    await writeJsonAtomic(file, [1, 2, 3]);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
