/**
 * Validation of a config repo snapshot against the definition field tables.
 *
 * Errors are per file and carry a file, line, column, dotted field path and
 * a stable rule id (RULES); the unit tests hold one passing and one failing
 * case per rule. Files are checked on their own first; the cross-file rules
 * (names unique per kind, references to existing agents, the orchestrator's
 * harness) run over the whole snapshot. An environment is startable only
 * when its own file and every agent it references are valid.
 */

import { checkSettings, isPlainObject } from '../options';
import { harnessDescriptors, type HarnessDescriptor } from '../providers';
import { fieldName, parseDefinitionFile, type FieldPath, type ParsedFile } from './parse';
import {
  API_VERSION,
  DEFINITION_DIRS,
  ENV_KEY_RE,
  LIMITS,
  NAME_RE,
  RESERVED_ENV_PREFIX,
  type AgentDefinition,
  type AgentSummary,
  type DefinitionError,
  type DefinitionKind,
  type EnvironmentDefinition,
  type EnvironmentSummary,
  type RepoSnapshot,
} from './types';

export const RULES = [
  // Files and YAML
  'file.count',
  'file.size',
  'file.object',
  'yaml.syntax',
  'yaml.duplicate-key',
  'yaml.tag',
  'unknown-field',
  // Both kinds
  'apiVersion',
  'kind',
  'name',
  'name.file',
  'name.unique',
  'description',
  // Agent
  'harness',
  'model',
  'effort',
  'instructions',
  'instructions.one-of',
  'instructionsFile.path',
  'instructionsFile.type',
  'instructionsFile.exists',
  'instructionsFile.size',
  'options',
  'advanced',
  // Environment
  'image',
  'image.one-of',
  'dockerfile.path',
  'dockerfile.exists',
  'resources',
  'resources.cpus',
  'resources.memory',
  'repos',
  'repos.github',
  'repos.github.unique',
  'repos.dir',
  'repos.dir.unique',
  'repos.branch',
  'orchestrator',
  'orchestrator.agent',
  'orchestrator.harness',
  'orchestrator.autoWake',
  'orchestrator.maxAutoTurnsPerHour',
  'agents',
  'agents.agent',
  'agents.unique',
  'agents.maxParallel',
  'agents.instructions',
  'limits',
  'limits.maxWorkers',
  'limits.maxAttempts',
  'policies',
  'policies.asks',
  'policies.publish',
  'policies.draftPullRequests',
  'git',
  'git.userName',
  'git.userEmail',
  'env',
  'env.key',
  'env.reserved',
  'env.value',
  'secrets',
  'secrets.name',
  'secrets.unique',
] as const;

export type RuleId = (typeof RULES)[number];

/** The harness every orchestrator must use (in-process MCP tools). */
export const ORCHESTRATOR_HARNESS = 'claude-code';

/* ---------- Small pure checks, shared with main (ipcguard, config-repo) ---------- */

/** GitHub `owner/name`. */
export const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** UTF-8 size of a string. */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A path inside the repo: relative, `/`-separated, no empty, `.` or `..` segments. */
export function isRepoRelativePath(p: string): boolean {
  if (!p || p.length > 1024 || p.startsWith('/') || /[\\\0]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A git ref name, per `git check-ref-format` (tags and branches alike). */
export function isValidRefName(name: string): boolean {
  if (!name || name.length > 255 || name === '@' || name === 'HEAD') return false;
  if (name.startsWith('-') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('@{')) return false;
  // Control characters, space, and ~ ^ : ? * [ \ are never allowed in a ref.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return name.split('/').every((seg) => seg !== '' && !seg.startsWith('.') && !seg.endsWith('.lock'));
}

// Docker's reference grammar (distribution/reference): [domain/]path[:tag][@digest].
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN = `${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*(?::[0-9]+)?`;
const PATH_COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
/** The reference grammar as a pattern (the JSON Schema reuses it). */
export const DOCKER_REF_PATTERN =
  `^(?:${DOMAIN}/)?${PATH_COMPONENT}(?:/${PATH_COMPONENT})*` +
  '(?::[\\w][\\w.-]{0,127})?' +
  '(?:@[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,})?$';
const DOCKER_REF_RE = new RegExp(DOCKER_REF_PATTERN);

/** A Docker image reference that can never be read as a flag. */
export function isDockerReference(ref: string): boolean {
  return !ref.startsWith('-') && ref.length <= 512 && DOCKER_REF_RE.test(ref);
}

/** Docker memory sizes like `512m` or `8g`. */
export const MEMORY_RE = /^[1-9][0-9]*[bkmg]$/i;

const INSTRUCTIONS_EXT_RE = /\.(md|txt)$/;

/** `agents/<name>.yaml` / `environments/<name>.yaml`; every other path is ignored. */
const DEFINITION_PATH_RE = /^(agents|environments)\/([^/]+)\.yaml$/;

export interface DefinitionPath {
  kind: DefinitionKind;
  path: string;
  /** The file name without `.yaml`: what the definition's `name` must equal. */
  fileName: string;
}

/** The definition files among the snapshot's paths, sorted by path. */
export function definitionPaths(paths: Iterable<string>): DefinitionPath[] {
  const out: DefinitionPath[] = [];
  for (const path of paths) {
    const m = DEFINITION_PATH_RE.exec(path);
    if (m) out.push({ kind: m[1] === 'agents' ? 'Agent' : 'Environment', path, fileName: m[2] });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The instructions file an agent file names, when it is one Puck would
 * read: a well-formed .md/.txt path present in the tree within the size
 * limit. The loader fetches exactly these beside the definition files.
 */
export function instructionsFileToFetch(snap: Pick<RepoSnapshot, 'tree'>, text: string): string | null {
  const value = parseDefinitionFile('', text).value;
  if (!isPlainObject(value) || typeof value.instructionsFile !== 'string') return null;
  const p = value.instructionsFile;
  const blob = snap.tree[p];
  if (!isRepoRelativePath(p) || !INSTRUCTIONS_EXT_RE.test(p) || !blob) return null;
  return blob.size <= LIMITS.instructionsBytes ? p : null;
}

/* ---------- Per-file checking ---------- */

export interface ValidatedFile<T> {
  kind: DefinitionKind;
  path: string;
  fileName: string;
  /** The parsed map (possibly invalid), null when the file is not a YAML map. */
  raw: Record<string, unknown> | null;
  /** Set only when the file has no errors. */
  definition: T | null;
  errors: DefinitionError[];
}

export interface ValidatedRepo {
  agents: Map<string, ValidatedFile<AgentDefinition>>;
  environments: Map<string, ValidatedFile<EnvironmentDefinition>>;
  /** Every error of every file, in path order. */
  errors: DefinitionError[];
}

class Check {
  readonly errors: DefinitionError[] = [];
  constructor(
    readonly parsed: ParsedFile | null,
    readonly path: string,
  ) {}

  fail(rule: RuleId, field: FieldPath, message: string, opts: { key?: boolean } = {}): void {
    const pos = this.parsed ? this.parsed.locate(field, opts) : { line: 1, column: 1 };
    this.errors.push({ file: this.path, ...pos, field: fieldName(field), rule, message });
  }

  /** A nested map; unknown keys are errors. Returns undefined when absent or not a map. */
  map(
    value: unknown,
    field: FieldPath,
    rule: RuleId,
    keys: readonly string[],
  ): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) {
      this.fail(rule, field, `${fieldName(field) || 'The file'} must be a map`);
      return undefined;
    }
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) {
        const where = fieldName(field);
        this.fail('unknown-field', [...field, key], `Unknown field "${key}"${where ? ` in ${where}` : ''}`, { key: true });
      }
    }
    return value;
  }

  int(value: unknown, field: FieldPath, rule: RuleId, min: number, max: number): void {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.fail(rule, field, `${fieldName(field)} must be a whole number from ${min} to ${max}`);
    }
  }

  bool(value: unknown, field: FieldPath, rule: RuleId): void {
    if (value !== undefined && typeof value !== 'boolean') this.fail(rule, field, `${fieldName(field)} must be true or false`);
  }

  oneOf(value: unknown, field: FieldPath, rule: RuleId, values: readonly string[]): void {
    if (value !== undefined && (typeof value !== 'string' || !values.includes(value))) {
      this.fail(rule, field, `${fieldName(field)} must be one of ${values.join(', ')}`);
    }
  }
}

const HEADER_KEYS = ['apiVersion', 'kind', 'name', 'description'] as const;
const AGENT_KEYS = [
  ...HEADER_KEYS,
  'harness',
  'model',
  'effort',
  'instructions',
  'instructionsFile',
  'options',
  'advanced',
] as const;
const ENV_KEYS = [
  ...HEADER_KEYS,
  'image',
  'dockerfile',
  'resources',
  'repos',
  'orchestrator',
  'agents',
  'limits',
  'policies',
  'git',
  'env',
  'secrets',
] as const;

function checkHeader(c: Check, v: Record<string, unknown>, def: DefinitionPath): void {
  if (v.apiVersion !== API_VERSION) c.fail('apiVersion', ['apiVersion'], `apiVersion must be "${API_VERSION}"`);
  if (v.kind !== def.kind) {
    c.fail('kind', ['kind'], `kind must be ${def.kind} for a file under ${DEFINITION_DIRS[def.kind]}/`);
  }
  if (typeof v.name !== 'string' || !NAME_RE.test(v.name)) {
    c.fail('name', ['name'], 'name must be 1-64 lowercase letters, digits and dashes, starting with a letter or digit');
  } else if (v.name !== def.fileName) {
    c.fail('name.file', ['name'], `name must equal the file name "${def.fileName}"`);
  }
  if (v.description !== undefined) {
    if (typeof v.description !== 'string') c.fail('description', ['description'], 'description must be a string');
    else if (v.description.length > LIMITS.description) {
      c.fail('description', ['description'], `description must be at most ${LIMITS.description} characters`);
    }
  }
}

function checkAgent(
  c: Check,
  v: Record<string, unknown>,
  snap: RepoSnapshot,
  harnesses: readonly HarnessDescriptor[],
): void {
  c.map(v, [], 'file.object', AGENT_KEYS);
  let harness: HarnessDescriptor | undefined;
  if (typeof v.harness === 'string') harness = harnesses.find((h) => h.id === v.harness);
  if (!harness) {
    c.fail('harness', ['harness'], `harness must be one of ${harnesses.map((h) => h.id).join(', ')}`);
  }
  if (v.model !== undefined && (typeof v.model !== 'string' || !v.model.trim())) {
    c.fail('model', ['model'], 'model must be a non-empty string');
  }
  if (v.effort !== undefined) {
    if (typeof v.effort !== 'string') c.fail('effort', ['effort'], 'effort must be a string');
    else if (harness && !harness.thinkingLevels.includes(v.effort)) {
      c.fail('effort', ['effort'], `effort must be one of ${harness.thinkingLevels.join(', ')} for ${harness.id}`);
    }
  }
  if (v.instructions !== undefined && v.instructionsFile !== undefined) {
    c.fail('instructions.one-of', ['instructionsFile'], 'Set instructions or instructionsFile, not both', { key: true });
  }
  if (v.instructions !== undefined) {
    if (typeof v.instructions !== 'string') c.fail('instructions', ['instructions'], 'instructions must be a string');
    else if (byteLength(v.instructions) > LIMITS.instructionsBytes) {
      c.fail('instructions', ['instructions'], 'instructions must be at most 64 KB');
    }
  }
  if (v.instructionsFile !== undefined) {
    const p = v.instructionsFile;
    if (typeof p !== 'string' || !isRepoRelativePath(p)) {
      c.fail('instructionsFile.path', ['instructionsFile'], 'instructionsFile must be a path relative to the repo root');
    } else if (!INSTRUCTIONS_EXT_RE.test(p)) {
      c.fail('instructionsFile.type', ['instructionsFile'], 'instructionsFile must be a .md or .txt file');
    } else if (!snap.tree[p]) {
      c.fail('instructionsFile.exists', ['instructionsFile'], `${p} does not exist at this commit`);
    } else if (
      snap.tree[p].size > LIMITS.instructionsBytes ||
      (snap.files[p] !== undefined && byteLength(snap.files[p]) > LIMITS.instructionsBytes)
    ) {
      c.fail('instructionsFile.size', ['instructionsFile'], `${p} must be at most 64 KB`);
    }
  }
  if (v.options !== undefined) {
    if (!isPlainObject(v.options)) c.fail('options', ['options'], 'options must be a map of option ids to values');
    else if (harness) {
      for (const err of checkSettings(harness.configOptions, v.options).errors) {
        const unknown = err.message.startsWith('unknown option');
        c.fail(
          'options',
          err.id ? ['options', err.id] : ['options'],
          unknown ? `Unknown ${harness.id} option "${err.id}"` : `options.${err.message}`,
          { key: unknown },
        );
      }
    }
  }
  if (v.advanced !== undefined && !isPlainObject(v.advanced)) {
    c.fail('advanced', ['advanced'], 'advanced must be a map');
  }
}

/**
 * The agent files as the environment checks see them, by file name. A file
 * that exists but did not parse still exists (its own errors make the
 * environment unstartable); its harness is then unknown.
 */
type AgentIndex = ReadonlyMap<string, { harness: unknown; readable: boolean }>;

function checkEnvironment(c: Check, v: Record<string, unknown>, snap: RepoSnapshot, agents: AgentIndex): void {
  c.map(v, [], 'file.object', ENV_KEYS);

  // Image or Dockerfile, exactly one.
  if (v.image !== undefined && v.dockerfile !== undefined) {
    c.fail('image.one-of', ['dockerfile'], 'Set image or dockerfile, not both', { key: true });
  } else if (v.image === undefined && v.dockerfile === undefined) {
    c.fail('image.one-of', [], 'Set image or dockerfile');
  }
  if (v.image !== undefined && (typeof v.image !== 'string' || !isDockerReference(v.image))) {
    c.fail('image', ['image'], 'image must be a Docker image reference such as node:22-bookworm');
  }
  if (v.dockerfile !== undefined) {
    if (typeof v.dockerfile !== 'string' || !isRepoRelativePath(v.dockerfile)) {
      c.fail('dockerfile.path', ['dockerfile'], 'dockerfile must be a path relative to the repo root');
    } else if (!snap.tree[v.dockerfile]) {
      c.fail('dockerfile.exists', ['dockerfile'], `${v.dockerfile} does not exist at this commit`);
    }
  }

  const resources = c.map(v.resources, ['resources'], 'resources', ['cpus', 'memory']);
  if (resources?.cpus !== undefined) {
    const cpus = resources.cpus;
    if (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus < 0.5 || cpus > 64) {
      c.fail('resources.cpus', ['resources', 'cpus'], 'resources.cpus must be a number from 0.5 to 64');
    }
  }
  if (resources?.memory !== undefined && (typeof resources.memory !== 'string' || !MEMORY_RE.test(resources.memory))) {
    c.fail('resources.memory', ['resources', 'memory'], 'resources.memory must be a size like 512m or 8g');
  }

  // Repos.
  if (!Array.isArray(v.repos) || v.repos.length < 1 || v.repos.length > LIMITS.repos) {
    c.fail('repos', ['repos'], `repos must list 1 to ${LIMITS.repos} repositories`);
  }
  const githubs = new Map<string, number>();
  const dirs = new Map<string, number>();
  (Array.isArray(v.repos) ? v.repos : []).forEach((item: unknown, i: number) => {
    const repo = c.map(item, ['repos', i], 'repos', ['github', 'dir', 'branch']);
    if (!repo) return;
    let dirDefault: string | undefined;
    if (typeof repo.github !== 'string' || !REPO_RE.test(repo.github)) {
      c.fail('repos.github', ['repos', i, 'github'], `repos[${i}].github must be owner/name`);
    } else {
      const key = repo.github.toLowerCase();
      if (githubs.has(key)) {
        c.fail('repos.github.unique', ['repos', i, 'github'], `${repo.github} is listed twice (also repos[${githubs.get(key)}])`);
      } else githubs.set(key, i);
      dirDefault = repo.github.split('/')[1];
    }
    let dir: string | undefined;
    if (repo.dir !== undefined) {
      if (typeof repo.dir !== 'string' || !NAME_RE.test(repo.dir)) {
        c.fail('repos.dir', ['repos', i, 'dir'], `repos[${i}].dir must be 1-64 lowercase letters, digits and dashes`);
      } else dir = repo.dir;
    } else if (dirDefault !== undefined) {
      if (NAME_RE.test(dirDefault)) dir = dirDefault;
      else {
        c.fail(
          'repos.dir',
          ['repos', i],
          `The repo name "${dirDefault}" is not a valid directory name; set repos[${i}].dir`,
        );
      }
    }
    if (dir !== undefined) {
      if (dirs.has(dir)) {
        c.fail('repos.dir.unique', ['repos', i, repo.dir !== undefined ? 'dir' : 'github'], `Directory "${dir}" is used twice (also repos[${dirs.get(dir)}])`);
      } else dirs.set(dir, i);
    }
    if (repo.branch !== undefined && (typeof repo.branch !== 'string' || !isValidRefName(repo.branch))) {
      c.fail('repos.branch', ['repos', i, 'branch'], `repos[${i}].branch must be a valid branch name`);
    }
  });

  // Orchestrator.
  if (v.orchestrator === undefined) c.fail('orchestrator', [], 'orchestrator is required');
  const orch = c.map(v.orchestrator, ['orchestrator'], 'orchestrator', ['agent', 'autoWake', 'maxAutoTurnsPerHour']);
  if (orch) {
    const ref = orch.agent;
    if (typeof ref !== 'string' || !NAME_RE.test(ref)) {
      c.fail('orchestrator.agent', ['orchestrator', 'agent'], 'orchestrator.agent must name an agent');
    } else if (!agents.has(ref)) {
      c.fail('orchestrator.agent', ['orchestrator', 'agent'], `No agent "${ref}" (agents/${ref}.yaml) at this commit`);
    } else if (agents.get(ref)?.readable && agents.get(ref)?.harness !== ORCHESTRATOR_HARNESS) {
      c.fail('orchestrator.harness', ['orchestrator', 'agent'], `The orchestrator agent "${ref}" must use harness ${ORCHESTRATOR_HARNESS}`);
    }
    c.bool(orch.autoWake, ['orchestrator', 'autoWake'], 'orchestrator.autoWake');
    c.int(orch.maxAutoTurnsPerHour, ['orchestrator', 'maxAutoTurnsPerHour'], 'orchestrator.maxAutoTurnsPerHour', 1, 200);
  }

  // Agent assignments.
  if (!Array.isArray(v.agents) || v.agents.length < 1) c.fail('agents', ['agents'], 'agents must list at least one agent');
  const assigned = new Map<string, number>();
  (Array.isArray(v.agents) ? v.agents : []).forEach((item: unknown, i: number) => {
    const a = c.map(item, ['agents', i], 'agents', ['agent', 'maxParallel', 'instructions']);
    if (!a) return;
    if (typeof a.agent !== 'string' || !NAME_RE.test(a.agent)) {
      c.fail('agents.agent', ['agents', i, 'agent'], `agents[${i}].agent must name an agent`);
    } else if (!agents.has(a.agent)) {
      c.fail('agents.agent', ['agents', i, 'agent'], `No agent "${a.agent}" (agents/${a.agent}.yaml) at this commit`);
    } else if (assigned.has(a.agent)) {
      c.fail('agents.unique', ['agents', i, 'agent'], `Agent "${a.agent}" is assigned twice (also agents[${assigned.get(a.agent)}])`);
    } else assigned.set(a.agent, i);
    c.int(a.maxParallel, ['agents', i, 'maxParallel'], 'agents.maxParallel', 1, 16);
    if (a.instructions !== undefined) {
      if (typeof a.instructions !== 'string') {
        c.fail('agents.instructions', ['agents', i, 'instructions'], `agents[${i}].instructions must be a string`);
      } else if (byteLength(a.instructions) > LIMITS.assignmentInstructionsBytes) {
        c.fail('agents.instructions', ['agents', i, 'instructions'], `agents[${i}].instructions must be at most 16 KB`);
      }
    }
  });

  const limits = c.map(v.limits, ['limits'], 'limits', ['maxWorkers', 'maxAttempts']);
  if (limits) {
    c.int(limits.maxWorkers, ['limits', 'maxWorkers'], 'limits.maxWorkers', 1, 64);
    c.int(limits.maxAttempts, ['limits', 'maxAttempts'], 'limits.maxAttempts', 1, 10);
  }

  const policies = c.map(v.policies, ['policies'], 'policies', ['asks', 'publish', 'draftPullRequests']);
  if (policies) {
    c.oneOf(policies.asks, ['policies', 'asks'], 'policies.asks', ['orchestrator-first', 'user']);
    c.oneOf(policies.publish, ['policies', 'publish'], 'policies.publish', ['manual', 'orchestrator']);
    c.bool(policies.draftPullRequests, ['policies', 'draftPullRequests'], 'policies.draftPullRequests');
  }

  const git = c.map(v.git, ['git'], 'git', ['userName', 'userEmail']);
  if (git) {
    for (const key of ['userName', 'userEmail'] as const) {
      const value = git[key];
      if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
        c.fail(`git.${key}`, ['git', key], `git.${key} must be a non-empty string`);
      }
    }
  }

  if (v.env !== undefined) {
    if (!isPlainObject(v.env)) c.fail('env', ['env'], 'env must be a map of names to string values');
    else {
      for (const [key, value] of Object.entries(v.env)) {
        if (!ENV_KEY_RE.test(key)) {
          c.fail('env.key', ['env', key], `"${key}" is not a valid variable name`, { key: true });
        } else if (key.startsWith(RESERVED_ENV_PREFIX)) {
          c.fail('env.reserved', ['env', key], `The ${RESERVED_ENV_PREFIX} prefix is reserved for Puck`, { key: true });
        }
        if (typeof value !== 'string') c.fail('env.value', ['env', key], `env.${key} must be a string (quote numbers and booleans)`);
      }
    }
  }

  if (v.secrets !== undefined) {
    if (!Array.isArray(v.secrets)) c.fail('secrets', ['secrets'], 'secrets must be a list of names');
    else {
      const seen = new Set<string>();
      v.secrets.forEach((name: unknown, i: number) => {
        if (typeof name !== 'string' || !ENV_KEY_RE.test(name) || name.startsWith(RESERVED_ENV_PREFIX)) {
          c.fail('secrets.name', ['secrets', i], `secrets[${i}] must be a variable name outside the ${RESERVED_ENV_PREFIX} prefix`);
        } else if (seen.has(name)) {
          c.fail('secrets.unique', ['secrets', i], `Secret ${name} is listed twice`);
        } else seen.add(name);
      });
    }
  }
}

/* ---------- The whole snapshot ---------- */

interface Loaded {
  def: DefinitionPath;
  check: Check;
  raw: Record<string, unknown> | null;
}

function load(def: DefinitionPath, index: number, snap: RepoSnapshot): Loaded {
  if (index >= LIMITS.files) {
    const check = new Check(null, def.path);
    check.fail('file.count', [], `The repo has more than ${LIMITS.files} definition files; this one was not read`);
    return { def, check, raw: null };
  }
  const text = snap.files[def.path];
  const size = Math.max(snap.tree[def.path]?.size ?? 0, text === undefined ? 0 : byteLength(text));
  if (size > LIMITS.fileBytes) {
    const check = new Check(null, def.path);
    check.fail('file.size', [], 'Definition files must be at most 256 KB');
    return { def, check, raw: null };
  }
  const parsed = parseDefinitionFile(def.path, text ?? '');
  const check = new Check(parsed, def.path);
  check.errors.push(...parsed.errors);
  if (parsed.errors.length) return { def, check, raw: null };
  if (!isPlainObject(parsed.value)) {
    check.fail('file.object', [], `A definition file must be a YAML map with apiVersion, kind and name`);
    return { def, check, raw: null };
  }
  return { def, check, raw: parsed.value };
}

/** Flags a declared name that another file of the same kind already owns. */
function checkUnique(files: Loaded[]): void {
  const owner = new Map<string, string>();
  for (const f of files) owner.set(f.def.fileName, f.def.path);
  const declared = new Map<string, string>();
  for (const f of files) {
    const name = f.raw?.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) continue;
    // The file named after it owns a name; otherwise the first file to declare it.
    const byFile = owner.get(name);
    const other = (byFile !== f.def.path ? byFile : undefined) ?? declared.get(name);
    if (other) {
      f.check.fail('name.unique', ['name'], `The name "${name}" is already used by ${other}`);
    } else if (!declared.has(name)) declared.set(name, f.def.path);
  }
}

export function validateSnapshot(
  snap: RepoSnapshot,
  harnesses: readonly HarnessDescriptor[] = harnessDescriptors,
): ValidatedRepo {
  const loaded = definitionPaths(Object.keys(snap.tree)).map((def, i) => load(def, i, snap));
  const agentFiles = loaded.filter((f) => f.def.kind === 'Agent');
  const envFiles = loaded.filter((f) => f.def.kind === 'Environment');

  const index = new Map<string, { harness: unknown; readable: boolean }>();
  for (const f of agentFiles) index.set(f.def.fileName, { harness: f.raw?.harness, readable: f.raw !== null });

  for (const f of loaded) if (f.raw) checkHeader(f.check, f.raw, f.def);
  checkUnique(agentFiles);
  checkUnique(envFiles);
  for (const f of agentFiles) if (f.raw) checkAgent(f.check, f.raw, snap, harnesses);
  for (const f of envFiles) if (f.raw) checkEnvironment(f.check, f.raw, snap, index);

  const agents = new Map<string, ValidatedFile<AgentDefinition>>();
  const environments = new Map<string, ValidatedFile<EnvironmentDefinition>>();
  for (const f of loaded) {
    const errors = f.check.errors.sort((a, b) => a.line - b.line || a.column - b.column);
    const base = { kind: f.def.kind, path: f.def.path, fileName: f.def.fileName, raw: f.raw, errors };
    if (f.def.kind === 'Agent') {
      agents.set(f.def.fileName, { ...base, definition: errors.length ? null : (f.raw as unknown as AgentDefinition) });
    } else {
      environments.set(f.def.fileName, {
        ...base,
        definition: errors.length ? null : (f.raw as unknown as EnvironmentDefinition),
      });
    }
  }
  return { agents, environments, errors: loaded.flatMap((f) => f.check.errors) };
}

/** Every agent an environment references: the orchestrator first, then each assignment. */
export function referencedAgents(env: EnvironmentDefinition): string[] {
  const names = [env.orchestrator.agent, ...env.agents.map((a) => a.agent)];
  return [...new Set(names)];
}

/** Startable: the environment and every agent it references are valid. */
export function isStartable(repo: ValidatedRepo, envName: string): boolean {
  const env = repo.environments.get(envName)?.definition;
  if (!env) return false;
  return referencedAgents(env).every((name) => !!repo.agents.get(name)?.definition);
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

export function summarize(repo: ValidatedRepo): { agents: AgentSummary[]; environments: EnvironmentSummary[] } {
  const agents = [...repo.agents.values()].map<AgentSummary>((f) => ({
    name: f.fileName,
    path: f.path,
    description: asString(f.raw?.description),
    harness: typeof f.raw?.harness === 'string' ? f.raw.harness : null,
    valid: f.definition !== null,
  }));
  const environments = [...repo.environments.values()].map<EnvironmentSummary>((f) => {
    const orch = isPlainObject(f.raw?.orchestrator) ? f.raw.orchestrator.agent : undefined;
    const list = Array.isArray(f.raw?.agents) ? f.raw.agents : [];
    return {
      name: f.fileName,
      path: f.path,
      description: asString(f.raw?.description),
      valid: f.definition !== null,
      startable: isStartable(repo, f.fileName),
      orchestrator: typeof orch === 'string' ? orch : null,
      agents: list.flatMap((a: unknown) => (isPlainObject(a) && typeof a.agent === 'string' ? [a.agent] : [])),
    };
  });
  return { agents, environments };
}
