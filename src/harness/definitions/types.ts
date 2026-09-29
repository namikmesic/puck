/**
 * Agent and environment definitions: the versioned YAML files in the Puck
 * home (agents/<name>.yaml, environments/<name>.yaml, optional prompts/**),
 * the repo snapshot they are read from, and the resolved environment an
 * instance runs. Pure types and constants - no node:* or electron imports,
 * so the app, the renderer and the code inside environments share them.
 */

export const API_VERSION = 'puck/v1';

/** Definition names (and repo dirs): the same rule as ids in ipcguard.ts. */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Environment variable and secret names. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Env keys with this prefix belong to Puck itself. */
export const RESERVED_ENV_PREFIX = 'PUCK_';

export const LIMITS = {
  /** Definition files (agents plus environments) per repo. */
  files: 200,
  /** Bytes per definition file. */
  fileBytes: 256 * 1024,
  /** Bytes of an agent's instructions, inline or from instructionsFile. */
  instructionsBytes: 64 * 1024,
  /** Bytes of an assignment's extra instructions. */
  assignmentInstructionsBytes: 16 * 1024,
  /** Characters of a description. */
  description: 500,
  repos: 10,
} as const;

export type DefinitionKind = 'Agent' | 'Environment';

/** Where each kind lives in the Puck home (one file per definition). */
export const DEFINITION_DIRS: Readonly<Record<DefinitionKind, string>> = {
  Agent: 'agents',
  Environment: 'environments',
};

/** A position in a file, both 1-based. */
export interface SourcePos {
  line: number;
  column: number;
}

/** One problem in one file. `field` is a dotted path (`repos[0].dir`), empty for the whole file. */
export interface DefinitionError extends SourcePos {
  file: string;
  field: string;
  /** Stable id of the rule that failed (RULES in validate.ts). */
  rule: string;
  message: string;
}

/* ---------- Definitions as written (optional fields not yet defaulted) ---------- */

export interface AgentDefinition {
  apiVersion: typeof API_VERSION;
  kind: 'Agent';
  name: string;
  description?: string;
  /** A registered harness id: claude-code or codex. */
  harness: string;
  model?: string;
  effort?: string;
  instructions?: string;
  /** Repo-relative .md or .txt file, used instead of `instructions`. */
  instructionsFile?: string;
  /** Sparse overrides of the harness `configOptions`. */
  options?: Record<string, unknown>;
  /** Merged into the SDK options last. */
  advanced?: Record<string, unknown>;
}

export interface RepoSpec {
  /** `owner/name`. */
  github: string;
  /** Directory under /workspace; defaults to the repo name. */
  dir?: string;
  /** Base branch for worktrees and pull requests; defaults to the repo's default branch. */
  branch?: string;
}

export interface AgentAssignment {
  agent: string;
  maxParallel?: number;
  /** Appended to the agent's instructions in this environment. */
  instructions?: string;
}

export type AskPolicy = 'orchestrator-first' | 'user';
export type PublishPolicy = 'manual' | 'orchestrator';

/**
 * How an environment works with GitHub. Intake: open issues carrying
 * `intakeLabel` become work items, and `<intakeLabel>:<agent>` also assigns
 * them (when `agentLabels`). One status comment per linked issue. CI and
 * review results reach the orchestrator as notices; `fix` and `address`
 * also queue follow-ups to the item's worker. `allowCiRerun` lets the
 * orchestrator re-run failed CI jobs. Installation tokens carry the
 * Workflows permission only with `allowWorkflowEdits`, and Actions write
 * only with `allowCiRerun`.
 */
export interface GitHubPolicies {
  intake: 'off' | 'label';
  intakeLabel: string;
  agentLabels: boolean;
  statusComment: boolean;
  ci: 'notify' | 'fix';
  maxCiFixAttempts: number;
  reviews: 'notify' | 'address';
  allowWorkflowEdits: boolean;
  allowCiRerun: boolean;
}

export const DEFAULT_GITHUB_POLICIES: Readonly<GitHubPolicies> = {
  intake: 'off',
  intakeLabel: 'puck',
  agentLabels: true,
  statusComment: true,
  ci: 'notify',
  maxCiFixAttempts: 2,
  reviews: 'notify',
  allowWorkflowEdits: false,
  allowCiRerun: false,
};

/**
 * A GitHub label Puck can filter on and extend with `:<agent>`: 1-50
 * characters, no comma (the list separator in label queries), no colon, no
 * leading or trailing space.
 */
export const INTAKE_LABEL_RE = /^[^,:\s](?:[^,:]{0,48}[^,:\s])?$/;

export interface EnvironmentDefinition {
  apiVersion: typeof API_VERSION;
  kind: 'Environment';
  name: string;
  description?: string;
  image?: string;
  /** Repo-relative Dockerfile, built without a context. */
  dockerfile?: string;
  resources?: { cpus?: number; memory?: string };
  repos: RepoSpec[];
  orchestrator: { agent: string; autoWake?: boolean; maxAutoTurnsPerHour?: number };
  agents: AgentAssignment[];
  limits?: { maxWorkers?: number; maxAttempts?: number };
  policies?: { asks?: AskPolicy; publish?: PublishPolicy; draftPullRequests?: boolean; github?: Partial<GitHubPolicies> };
  git?: { userName?: string; userEmail?: string };
  env?: Record<string, string>;
  secrets?: string[];
}

/* ---------- Refs and pins ---------- */

export type PinKind = 'tag' | 'branch' | 'commit';

/** What the user picks: a tag, a branch, or a commit SHA. */
export interface PinSpec {
  kind: PinKind;
  name: string;
}

/** A pin resolved to the commit it currently names. */
export interface Pin extends PinSpec {
  sha: string;
}

export interface RefInfo {
  name: string;
  sha: string;
}

/** The Puck home's refs for the pin picker. */
export interface DefinitionRefs {
  /** The home's default branch: "Edit on GitHub" links there. */
  defaultBranch: string;
  /** Semver tags newest first, then the other tags by name. */
  tags: RefInfo[];
  branches: RefInfo[];
  /** Default pin: the highest semver release, else the highest prerelease. Null when no semver tag exists. */
  defaultTag: string | null;
}

/* ---------- The repo at one commit ---------- */

export interface TreeBlob {
  size: number;
  /** Git blob sha: content identity, e.g. for a Dockerfile that is not fetched. */
  sha: string;
}

/** One commit of the Puck home. `tree` omits symlink entries; `files` holds the texts Puck read. */
export interface RepoSnapshot {
  sha: string;
  tree: Record<string, TreeBlob>;
  /** Definition files and referenced instructions files, by repo path. */
  files: Record<string, string>;
}

/* ---------- Resolution ---------- */

export const RESOLVER_VERSION = 1;

/** An agent with its defaults applied and `instructionsFile` inlined. */
export interface ResolvedAgent {
  name: string;
  description: string;
  harness: string;
  model: string;
  effort: string;
  instructions: string;
  /** Where `instructions` came from, null when written inline. */
  instructionsFile: string | null;
  options: Record<string, unknown>;
  advanced: Record<string, unknown>;
}

/**
 * The only definition input the daemon receives: one environment at one
 * commit with its defaults applied and every agent it references embedded.
 * Defaults that need runtime data stay null here and are filled at start:
 * `repos[].branch` (the repo's default branch) and `git` (the GitHub login
 * and noreply address).
 */
export interface ResolvedEnvironment {
  resolverVersion: typeof RESOLVER_VERSION;
  source: { repo: string; pin: Pin; path: string };
  name: string;
  description: string;
  image: string | null;
  dockerfile: { path: string; blob: string } | null;
  resources: { cpus: number | null; memory: string | null };
  repos: Array<{ github: string; dir: string; branch: string | null }>;
  orchestrator: { agent: string; autoWake: boolean; maxAutoTurnsPerHour: number };
  agents: Array<{ agent: string; maxParallel: number; instructions: string }>;
  limits: { maxWorkers: number; maxAttempts: number };
  policies: { asks: AskPolicy; publish: PublishPolicy; draftPullRequests: boolean; github: GitHubPolicies };
  git: { userName: string | null; userEmail: string | null };
  env: Record<string, string>;
  secrets: string[];
  /** Every referenced agent (the orchestrator's and each assignment's), by name. */
  agentDefinitions: Record<string, ResolvedAgent>;
}

/* ---------- Updates ---------- */

/**
 * How a definition change reaches a running instance. Hot: the next turn,
 * nothing interrupted. Reprovision: provisioning re-runs in place once
 * running turns and in-flight worktree prepares finish. Rebuild: the
 * container is recreated with the same volumes; running turns are
 * interrupted and requeued.
 */
export type UpdateClass = 'hot' | 'reprovision' | 'rebuild';

export interface DefinitionChange {
  /** Dotted field path, e.g. `repos[acme/web].branch` or `agentDefinitions.lead.harness`. */
  field: string;
  class: UpdateClass;
  /** One line for the apply dialog. */
  summary: string;
}

/* ---------- What the app lists at a pin ---------- */

export interface AgentSummary {
  name: string;
  path: string;
  description: string;
  harness: string | null;
  valid: boolean;
}

export interface EnvironmentSummary {
  name: string;
  path: string;
  description: string;
  /** The file itself has no errors. */
  valid: boolean;
  /** Valid, and so is every agent it references. */
  startable: boolean;
  orchestrator: string | null;
  agents: string[];
  /** Secret names the start form asks for. Empty when the file did not validate. */
  secrets: string[];
  /** What placement checks against a runner. Nulls when the file did not validate. */
  resources: { cpus: number | null; memory: string | null };
}

export interface ListedError extends DefinitionError {
  /** "Open in GitHub": the file at the listed commit, anchored at the line. */
  url: string;
}

export interface DefinitionListing {
  /** `owner/name` of the Puck home. */
  repo: string;
  pin: Pin;
  sha: string;
  environments: EnvironmentSummary[];
  agents: AgentSummary[];
  errors: ListedError[];
}

/** A newer commit for an instance's pin. */
export interface UpdateInfo {
  pin: Pin;
}
