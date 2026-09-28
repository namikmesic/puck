/** The example config repo (docs/examples/config-repo) as test fixtures. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse, stringify } from 'yaml';
import type { RepoSnapshot } from '../../src/harness/definitions/types';

export const EXAMPLE_DIR = join(__dirname, '..', '..', 'docs', 'examples', 'config-repo');

export type Files = Record<string, string>;

/** Every file of the example repo by repo path (hidden folders included). */
export function exampleFiles(): Files {
  const out: Files = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(EXAMPLE_DIR, full).split(sep).join('/')] = readFileSync(full, 'utf8');
    }
  };
  walk(EXAMPLE_DIR);
  return out;
}

/** A deterministic fake blob sha per path. */
export const blobSha = (path: string): string =>
  Buffer.from(path).toString('hex').padEnd(40, '0').slice(0, 40);

/** A snapshot holding every file (as if all were fetched), with byte sizes in the tree. */
export function snapshotOf(files: Files, sha = 'a'.repeat(40)): RepoSnapshot {
  const tree: RepoSnapshot['tree'] = {};
  for (const [path, text] of Object.entries(files)) tree[path] = { size: Buffer.byteLength(text), sha: blobSha(path) };
  return { sha, tree, files: { ...files } };
}

/** Set (or, with `undefined`, delete) top-level fields of a YAML file. */
export function patchYaml(files: Files, path: string, patch: Record<string, unknown>): void {
  const obj = parse(files[path]) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete obj[key];
    else obj[key] = value;
  }
  files[path] = stringify(obj);
}

export const AGENT = 'agents/implementer.yaml';
export const ENV = 'environments/example.yaml';

export const agentPatch =
  (patch: Record<string, unknown>, path = AGENT) =>
  (files: Files): void =>
    patchYaml(files, path, patch);
export const envPatch =
  (patch: Record<string, unknown>) =>
  (files: Files): void =>
    patchYaml(files, ENV, patch);
