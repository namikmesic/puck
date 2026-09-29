/**
 * The Puck home (the repository of agent and environment definitions),
 * read through the GitHub API at a pinned ref. Internal names keep the
 * older "config repo".
 *
 *  - Refs: tags (semver newest first; the default pin is the highest
 *    release tag, or the highest prerelease when no release exists) and
 *    branches. A pin resolves to a commit through
 *    `/commits/tags/<name>`, `/commits/heads/<name>` or the SHA itself, so
 *    a tag and a branch with the same name never shadow each other.
 *  - Load: the tree at the commit, omitting symlink blobs (mode 120000,
 *    whose content is the link target), then every definition file
 *    (agents/<name>.yaml, environments/<name>.yaml) and the instructions
 *    files they reference. Files over the limits are never fetched; the
 *    validator reports them from their tree size.
 *  - Cache: kept by commit SHA in memory and in
 *    userData/puck-defs-cache/<sha>.json (safe to delete). `CACHE_VERSION`
 *    changes when that snapshot's shape changes, so an older file for the
 *    same SHA is a miss.
 *  - Updates: tag pins offer a newer semver tag, branch pins a moved head,
 *    commit pins nothing.
 *
 * GitHub access goes through the app's own sign-in (providers/github.ts);
 * tokens never leave that module.
 */

import { app } from 'electron';
import * as path from 'node:path';
import { resolveEnvironment } from '../harness/definitions/resolve';
import {
  LIMITS,
  type DefinitionListing,
  type DefinitionRefs,
  type Pin,
  type PinSpec,
  type RefInfo,
  type RepoSnapshot,
  type ResolvedEnvironment,
  type TreeBlob,
  type UpdateInfo,
} from '../harness/definitions/types';
import {
  COMMIT_RE,
  definitionPaths,
  instructionsFileToFetch,
  isValidRefName,
  summarize,
  validateSnapshot,
} from '../harness/definitions/validate';
import { GitHubApiError, type GitHubClient } from '../harness/github';
import { readJson, writeJsonAtomic } from './jsonstore';
import { log } from './log';
import { githubClient } from './providers/github';
import { githubSettings } from './providers/providers-store';

export const SHA_RE = /^[0-9a-f]{40}$/;

/* ---------- Semver tags ---------- */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** `v1.2.3`, `1.2.3-rc.1` and the like; null for any other tag. */
export function parseSemverTag(tag: string): SemVer | null {
  const m = SEMVER_RE.exec(tag);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: negative when a < b. Build metadata is ignored. */
export function compareSemver(a: SemVer, b: SemVer): number {
  const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (core) return core;
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Semver tags newest first, then the rest by name. */
export function sortTags(tags: readonly RefInfo[]): RefInfo[] {
  const semver = tags
    .map((t) => ({ t, v: parseSemverTag(t.name) }))
    .filter((x): x is { t: RefInfo; v: SemVer } => x.v !== null)
    .sort((a, b) => compareSemver(b.v, a.v))
    .map((x) => x.t);
  const other = tags.filter((t) => !parseSemverTag(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  return [...semver, ...other];
}

/**
 * The newest semver tag: releases only, unless `prerelease` (a pin that is
 * itself a prerelease follows prereleases too).
 */
export function newestTag(tags: readonly RefInfo[], prerelease = false): RefInfo | null {
  for (const t of sortTags(tags)) {
    const v = parseSemverTag(t.name);
    if (v && (prerelease || !v.pre.length)) return t;
  }
  return null;
}

/* ---------- Loading ---------- */

export interface ConfigRepoDeps {
  client(): GitHubClient;
  /** `owner/name` of the Puck home, null until one is connected. */
  repo(): string | null;
  /** Folder of the on-disk SHA cache; null keeps the cache in memory only. */
  cacheDir(): string | null;
}

interface CacheFile {
  v: 2;
  sha: string;
  tree: Record<string, TreeBlob>;
  files: Record<string, string>;
}

const CACHE_VERSION = 2;
const SYMLINK_MODE = '120000';
/** Snapshots kept in memory; each is a small file map. */
const MEMORY_ENTRIES = 16;
/** Parallel blob requests while loading one commit. */
const FETCH_CONCURRENCY = 6;

function isStringMap(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && Object.values(value).every((v) => typeof v === 'string');
}

function isTree(value: unknown): value is Record<string, TreeBlob> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every(
      (b) => typeof b === 'object' && b !== null && typeof (b as TreeBlob).size === 'number' && typeof (b as TreeBlob).sha === 'string',
    )
  );
}

/** "Open in GitHub" for one line of one file at one commit. */
export function blobUrl(repo: string, sha: string, file: string, line: number): string {
  return `https://github.com/${repo}/blob/${sha}/${file.split('/').map(encodeURIComponent).join('/')}#L${line}`;
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(run));
}

export function createConfigRepo(deps: ConfigRepoDeps) {
  const memory = new Map<string, RepoSnapshot>();

  function target(): { repo: string; owner: string; name: string } {
    const repo = deps.repo();
    if (!repo) throw new Error('Connect your Puck home in Settings → Providers → GitHub first.');
    const [owner, name] = repo.split('/');
    return { repo, owner, name };
  }

  async function refs(): Promise<DefinitionRefs> {
    const { owner, name } = target();
    const client = deps.client();
    const [tags, branches, info] = await Promise.all([client.tags(owner, name), client.branches(owner, name), client.repo(owner, name)]);
    const toRef = (r: { name: string; commit: { sha: string } }): RefInfo => ({ name: r.name, sha: r.commit.sha });
    const tagRefs = sortTags(tags.map(toRef));
    return {
      defaultBranch: info.default_branch,
      tags: tagRefs,
      branches: branches.map(toRef).sort((a, b) => a.name.localeCompare(b.name)),
      defaultTag: (newestTag(tagRefs) ?? newestTag(tagRefs, true))?.name ?? null,
    };
  }

  async function resolvePin(spec: PinSpec): Promise<Pin> {
    const { repo, owner, name } = target();
    let ref: string;
    if (spec.kind === 'commit') {
      if (!COMMIT_RE.test(spec.name)) throw new Error(`"${spec.name}" is not a commit SHA.`);
      ref = spec.name.toLowerCase();
    } else {
      if (!isValidRefName(spec.name)) throw new Error(`"${spec.name}" is not a valid ${spec.kind} name.`);
      ref = `${spec.kind === 'tag' ? 'tags' : 'heads'}/${spec.name}`;
    }
    let sha: string;
    try {
      sha = await deps.client().commitSha(owner, name, ref);
    } catch (err) {
      if (err instanceof GitHubApiError && (err.status === 404 || err.status === 422)) {
        throw new Error(`No ${spec.kind} "${spec.name}" in ${repo}.`);
      }
      throw err;
    }
    if (!SHA_RE.test(sha)) throw new Error(`GitHub returned an unexpected commit id for ${spec.kind} "${spec.name}".`);
    return { kind: spec.kind, name: spec.name, sha };
  }

  function cachePath(sha: string): string | null {
    const dir = deps.cacheDir();
    return dir && SHA_RE.test(sha) ? path.join(dir, `${sha}.json`) : null;
  }

  function remember(snap: RepoSnapshot): RepoSnapshot {
    memory.delete(snap.sha);
    memory.set(snap.sha, snap);
    while (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value as string);
    return snap;
  }

  function fromDisk(sha: string): RepoSnapshot | null {
    const file = cachePath(sha);
    const data = file ? readJson<Partial<CacheFile>>(file) : null;
    if (!data || data.v !== CACHE_VERSION || data.sha !== sha || !isTree(data.tree) || !isStringMap(data.files)) return null;
    return { sha, tree: data.tree, files: data.files };
  }

  async function fetchSnapshot(sha: string): Promise<RepoSnapshot> {
    const { owner, name } = target();
    const client = deps.client();
    const started = Date.now();
    const tree: Record<string, TreeBlob> = Object.create(null);
    for (const entry of await client.tree(owner, name, sha)) {
      if (entry.type === 'blob' && entry.mode !== SYMLINK_MODE) tree[entry.path] = { size: entry.size ?? 0, sha: entry.sha };
    }
    const files: Record<string, string> = Object.create(null);
    const fetchFiles = (paths: string[]): Promise<void> =>
      inBatches(paths, FETCH_CONCURRENCY, async (p) => {
        files[p] = await client.blob(owner, name, tree[p].sha);
      });

    const defs = definitionPaths(Object.keys(tree))
      .slice(0, LIMITS.files)
      .filter((d) => tree[d.path].size <= LIMITS.fileBytes);
    await fetchFiles(defs.map((d) => d.path));
    const referenced = new Set<string>();
    for (const d of defs) {
      if (d.kind !== 'Agent') continue;
      const p = instructionsFileToFetch({ tree }, files[d.path]);
      if (p && files[p] === undefined) referenced.add(p);
    }
    await fetchFiles([...referenced]);
    log.info('defs.loaded', { sha: sha.slice(0, 12), files: Object.keys(files).length, ms: Date.now() - started });
    return { sha, tree, files };
  }

  /** The file map at a commit, from memory, disk, or GitHub. */
  async function snapshot(sha: string): Promise<RepoSnapshot> {
    if (!SHA_RE.test(sha)) throw new Error('Definitions load at a full commit SHA.');
    const hit = memory.get(sha) ?? fromDisk(sha);
    if (hit) return remember(hit);
    const snap = await fetchSnapshot(sha);
    const file = cachePath(sha);
    if (file) {
      const data: CacheFile = { v: CACHE_VERSION, sha, tree: snap.tree, files: snap.files };
      await writeJsonAtomic(file, data).catch(() => undefined); // a cache miss next time is fine
    }
    return remember(snap);
  }

  /** Every definition at a pin, validated, with its errors linked to GitHub. */
  async function listing(spec: PinSpec): Promise<DefinitionListing> {
    const { repo } = target();
    const pin = await resolvePin(spec);
    const validated = validateSnapshot(await snapshot(pin.sha));
    const { agents, environments } = summarize(validated);
    return {
      repo,
      pin,
      sha: pin.sha,
      agents,
      environments,
      errors: validated.errors.map((e) => ({ ...e, url: blobUrl(repo, pin.sha, e.file, e.line) })),
    };
  }

  /** The ResolvedEnvironment for one environment at a pin (throws DefinitionsInvalidError). */
  async function resolve(spec: PinSpec, envName: string): Promise<ResolvedEnvironment> {
    const { repo } = target();
    const pin = await resolvePin(spec);
    const snap = await snapshot(pin.sha);
    return resolveEnvironment(validateSnapshot(snap), snap, envName, { repo, pin });
  }

  /** A newer commit for `pin`, or null. */
  async function checkUpdate(pin: Pin): Promise<UpdateInfo | null> {
    if (pin.kind === 'commit') return null;
    if (pin.kind === 'branch') {
      const head = await resolvePin({ kind: 'branch', name: pin.name });
      return head.sha !== pin.sha ? { pin: head } : null;
    }
    const current = parseSemverTag(pin.name);
    if (!current) return null;
    const { tags } = await refs();
    const newest = newestTag(tags, current.pre.length > 0);
    const version = newest ? parseSemverTag(newest.name) : null;
    if (!newest || !version || compareSemver(version, current) <= 0) return null;
    return { pin: { kind: 'tag', name: newest.name, sha: newest.sha } };
  }

  return { refs, resolvePin, snapshot, listing, resolve, checkUpdate, forget: () => memory.clear() };
}

export type ConfigRepo = ReturnType<typeof createConfigRepo>;

const configRepo = createConfigRepo({
  client: githubClient,
  repo: () => githubSettings().configRepo,
  cacheDir: () => path.join(app.getPath('userData'), 'puck-defs-cache'),
});

export const definitionRefs = (): Promise<DefinitionRefs> => configRepo.refs();
export const definitionsAt = (pin: PinSpec): Promise<DefinitionListing> => configRepo.listing(pin);
export const resolveDefinition = (pin: PinSpec, envName: string): Promise<ResolvedEnvironment> =>
  configRepo.resolve(pin, envName);
export const checkDefinitionUpdate = (pin: Pin): Promise<UpdateInfo | null> => configRepo.checkUpdate(pin);
