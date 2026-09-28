/**
 * YAML to plain objects with source positions. One document per file, the
 * YAML 1.2 core schema, no tags of any kind (`!foo` and `!!binary` alike),
 * and duplicate keys are errors. Every error carries the file, line and
 * column; `locate` maps a field path back to where it was written, so the
 * validator can point at a field without re-walking YAML itself.
 */

import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, visit, type Node } from 'yaml';
import type { DefinitionError, SourcePos } from './types';

/** A field path: map keys and sequence indexes (`['repos', 0, 'dir']`). */
export type FieldPath = ReadonlyArray<string | number>;

export interface ParsedFile {
  path: string;
  /** The document as plain JS; undefined when the YAML did not parse. */
  value: unknown;
  /** YAML-level errors (syntax, duplicate keys, tags). */
  errors: DefinitionError[];
  /**
   * Where `field` was written: the value's position, or the key's with
   * `key`. A path that is not in the file resolves to its deepest written
   * ancestor, so a missing field points at the map it belongs in.
   */
  locate(field: FieldPath, opts?: { key?: boolean }): SourcePos;
}

/** `['repos', 0, 'dir']` → `repos[0].dir`. */
export function fieldName(field: FieldPath): string {
  let out = '';
  for (const seg of field) out += typeof seg === 'number' ? `[${seg}]` : out ? `.${seg}` : seg;
  return out;
}

const START: SourcePos = { line: 1, column: 1 };

/** Some YAML error messages repeat the position; the error carries it already. */
function bare(message: string): string {
  return message.replace(/ at line \d+, column \d+:?[\s\S]*$/, '').trim();
}

export function parseDefinitionFile(path: string, text: string): ParsedFile {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter,
    schema: 'core',
    uniqueKeys: true,
    resolveKnownTags: false,
    prettyErrors: false,
  });
  const posOf = (offset: number): SourcePos => {
    const { line, col } = lineCounter.linePos(offset);
    return { line, column: col };
  };
  const errors: DefinitionError[] = [];
  const add = (offset: number, rule: string, message: string): void => {
    errors.push({ file: path, ...posOf(offset), field: '', rule, message });
  };
  for (const err of doc.errors) {
    const rule = err.code === 'DUPLICATE_KEY' ? 'yaml.duplicate-key' : 'yaml.syntax';
    add(err.pos[0], rule, bare(err.message));
  }
  visit(doc, (_key, node) => {
    if ((isScalar(node) || isMap(node) || isSeq(node)) && node.tag) {
      add(node.range?.[0] ?? 0, 'yaml.tag', `YAML tags are not allowed (${node.tag}).`);
    }
  });

  let value: unknown;
  if (!errors.length) {
    try {
      value = doc.toJS({ maxAliasCount: 100 });
    } catch (err) {
      add(0, 'yaml.syntax', err instanceof Error ? err.message : String(err));
    }
    if (errors.length === 0 && hasCycle(value)) {
      value = undefined;
      add(0, 'yaml.syntax', 'YAML anchors must not form a cycle.');
    }
  }

  function locate(field: FieldPath, opts: { key?: boolean } = {}): SourcePos {
    let node: unknown = doc.contents;
    let at: SourcePos = isNodeWithRange(node) ? posOf(node.range[0]) : START;
    for (let i = 0; i < field.length; i++) {
      const seg = field[i];
      const last = i === field.length - 1;
      if (isMap(node) && typeof seg === 'string') {
        const pair = node.items.find((p) => isPair(p) && isScalar(p.key) && p.key.value === seg);
        if (!pair) return at;
        if (last && opts.key && isNodeWithRange(pair.key)) return posOf(pair.key.range[0]);
        node = pair.value;
        at = isNodeWithRange(node) ? posOf(node.range[0]) : isNodeWithRange(pair.key) ? posOf(pair.key.range[0]) : at;
      } else if (isSeq(node) && typeof seg === 'number') {
        const item: unknown = node.items[seg];
        if (!isNodeWithRange(item)) return at;
        node = item;
        at = posOf(item.range[0]);
      } else {
        return at;
      }
    }
    return at;
  }

  return { path, value, errors, locate };
}

function isNodeWithRange(node: unknown): node is Node & { range: [number, number, number] } {
  return typeof node === 'object' && node !== null && Array.isArray((node as { range?: unknown }).range);
}

function hasCycle(value: unknown): boolean {
  const stack = new Set<object>();
  const walk = (node: unknown): boolean => {
    if (typeof node !== 'object' || node === null) return false;
    if (stack.has(node)) return true;
    stack.add(node);
    for (const child of Object.values(node)) {
      if (walk(child)) return true;
    }
    stack.delete(node);
    return false;
  };
  return walk(value);
}
