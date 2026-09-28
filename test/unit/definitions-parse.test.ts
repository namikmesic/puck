import { describe, expect, it } from 'vitest';
import { fieldName, parseDefinitionFile } from '../../src/harness/definitions/parse';

describe('parseDefinitionFile', () => {
  it('parses the core schema to plain values (no YAML 1.1 booleans or dates)', () => {
    const f = parseDefinitionFile('a.yaml', 'a: yes\nb: 0x1f\nc: ~\nd: 2020-01-01\ne: true\n');
    expect(f.errors).toEqual([]);
    expect(f.value).toEqual({ a: 'yes', b: 31, c: null, d: '2020-01-01', e: true });
  });

  it('reports duplicate keys with the position of the duplicate', () => {
    const f = parseDefinitionFile('agents/x.yaml', 'name: x\nmodel: a\nmodel: b\n');
    expect(f.value).toBeUndefined();
    expect(f.errors).toEqual([
      expect.objectContaining({ file: 'agents/x.yaml', rule: 'yaml.duplicate-key', line: 3, column: 1 }),
    ]);
  });

  it('rejects every tag, custom or built in', () => {
    const f = parseDefinitionFile('x.yaml', 'a: !custom x\nb: !!binary aGk=\nc: !!str ok\n');
    expect(f.errors.map((e) => [e.rule, e.line])).toEqual([
      ['yaml.tag', 1],
      ['yaml.tag', 2],
      ['yaml.tag', 3],
    ]);
  });

  it('rejects more than one document', () => {
    const f = parseDefinitionFile('x.yaml', 'a: 1\n---\nb: 2\n');
    expect(f.errors).toEqual([expect.objectContaining({ rule: 'yaml.syntax', line: 2 })]);
  });

  it('reports syntax errors with a line and column and no repeated position text', () => {
    const f = parseDefinitionFile('x.yaml', 'a: 1\nb: [1,\n');
    expect(f.errors[0]).toMatchObject({ rule: 'yaml.syntax' });
    expect(f.errors[0].line).toBeGreaterThanOrEqual(2);
    expect(f.errors[0].message).not.toMatch(/at line/);
  });

  it('caps alias expansion', () => {
    const bomb = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (const k of 'bcdefg') bomb.push(`${k}: &${k} [${Array(10).fill(`*${String.fromCharCode(k.charCodeAt(0) - 1)}`).join(', ')}]`);
    const f = parseDefinitionFile('x.yaml', `${bomb.join('\n')}\n`);
    expect(f.errors.map((e) => e.rule)).toEqual(['yaml.syntax']);
  });

  it('locates values, keys, sequence items, and the nearest ancestor of a missing field', () => {
    const text = 'name: x\nrepos:\n  - github: a/b\n    dir: b\nenv:\n  PORT: 1\n';
    const f = parseDefinitionFile('x.yaml', text);
    expect(f.locate(['name'])).toEqual({ line: 1, column: 7 });
    expect(f.locate(['name'], { key: true })).toEqual({ line: 1, column: 1 });
    expect(f.locate(['repos', 0, 'dir'])).toEqual({ line: 4, column: 10 });
    expect(f.locate(['repos', 0])).toEqual({ line: 3, column: 5 });
    expect(f.locate(['repos', 3, 'dir'])).toEqual({ line: 3, column: 3 });
    expect(f.locate(['env', 'PORT'], { key: true })).toEqual({ line: 6, column: 3 });
    expect(f.locate(['missing'])).toEqual({ line: 1, column: 1 });
  });

  it('names field paths the way errors print them', () => {
    expect(fieldName(['repos', 0, 'dir'])).toBe('repos[0].dir');
    expect(fieldName(['options', 'tool.Bash'])).toBe('options.tool.Bash');
    expect(fieldName([])).toBe('');
  });
});
