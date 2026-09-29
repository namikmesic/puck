import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { LIMITS } from '../../src/harness/definitions/types';
import {
  isDockerReference,
  isRepoRelativePath,
  isStartable,
  isValidRefName,
  RULES,
  summarize,
  validateSnapshot,
  type RuleId,
} from '../../src/harness/definitions/validate';
import {
  AGENT,
  agentPatch,
  ENV,
  envPatch,
  exampleFiles,
  snapshotOf,
  type Files,
} from './definitions-fixtures';

type Edit = (files: Files) => void;

/**
 * One row per rule: `pass` must leave the whole example repo valid, `fail`
 * must produce an error of exactly that rule in `file` (default: the file
 * the edit touches). Rules shared by both kinds get a row per kind.
 */
interface Case {
  rule: RuleId;
  name: string;
  pass: Edit;
  fail: Edit;
  file?: string;
}

const noop: Edit = () => undefined;
const both =
  (...edits: Edit[]): Edit =>
  (files) =>
    edits.forEach((e) => e(files));
const add =
  (path: string, text: string): Edit =>
  (files) => {
    files[path] = text;
  };
const agentYaml = (name: string, extra: Record<string, unknown> = {}): string =>
  stringify({ apiVersion: 'puck/v1', kind: 'Agent', name, harness: 'claude-code', ...extra });
const repos = (n: number): Array<{ github: string; dir: string }> =>
  Array.from({ length: n }, (_, i) => ({ github: `acme/repo-${i}`, dir: `repo-${i}` }));
const kb = (n: number): string => 'x'.repeat(n * 1024);

const CASES: Case[] = [
  // Files and YAML
  {
    rule: 'file.count',
    name: 'at most 200 definition files',
    pass: (f) => {
      for (let i = 0; i < LIMITS.files - 4; i++) f[`agents/extra-${String(i).padStart(3, '0')}.yaml`] = agentYaml(`extra-${String(i).padStart(3, '0')}`);
    },
    fail: (f) => {
      for (let i = 0; i < LIMITS.files; i++) f[`agents/extra-${String(i).padStart(3, '0')}.yaml`] = agentYaml(`extra-${String(i).padStart(3, '0')}`);
    },
    // Files past the limit in path order are not read: here the example's own four.
  },
  {
    rule: 'file.size',
    name: 'at most 256 KB per file',
    pass: (f) => {
      f[AGENT] += `# ${'x'.repeat(LIMITS.fileBytes - Buffer.byteLength(f[AGENT]) - 3)}\n`;
    },
    fail: (f) => {
      f[AGENT] += `# ${'x'.repeat(LIMITS.fileBytes)}\n`;
    },
    file: AGENT,
  },
  { rule: 'file.object', name: 'a YAML map', pass: noop, fail: add(AGENT, '- a\n- b\n'), file: AGENT },
  { rule: 'yaml.syntax', name: 'parses', pass: noop, fail: add(AGENT, 'name: [1,\n'), file: AGENT },
  { rule: 'yaml.syntax', name: 'one document per file', pass: noop, fail: (f) => (f[AGENT] += '---\nname: other\n'), file: AGENT },
  { rule: 'yaml.duplicate-key', name: 'no duplicate keys', pass: noop, fail: (f) => (f[AGENT] += 'model: auto\n'), file: AGENT },
  {
    rule: 'yaml.tag',
    name: 'no tags',
    pass: (f) => (f[AGENT] = f[AGENT].replace('model: auto', 'model: "auto"')),
    fail: (f) => (f[AGENT] = f[AGENT].replace('model: auto', 'model: !!str auto')),
    file: AGENT,
  },
  { rule: 'unknown-field', name: 'agent: no unknown fields', pass: noop, fail: agentPatch({ maxParalel: 2 }), file: AGENT },
  { rule: 'unknown-field', name: 'environment: no unknown nested fields', pass: noop, fail: envPatch({ limits: { maxWorker: 2 } }), file: ENV },

  // Both kinds
  { rule: 'apiVersion', name: 'agent', pass: noop, fail: agentPatch({ apiVersion: 'puck/v2' }), file: AGENT },
  { rule: 'apiVersion', name: 'environment', pass: noop, fail: envPatch({ apiVersion: undefined }), file: ENV },
  { rule: 'kind', name: 'agent', pass: noop, fail: agentPatch({ kind: 'Environment' }), file: AGENT },
  { rule: 'kind', name: 'environment', pass: noop, fail: envPatch({ kind: 'Agent' }), file: ENV },
  { rule: 'name', name: 'agent name rule', pass: noop, fail: agentPatch({ name: 'Implementer' }), file: AGENT },
  { rule: 'name', name: 'environment name rule', pass: noop, fail: envPatch({ name: '-example' }), file: ENV },
  { rule: 'name.file', name: 'agent', pass: noop, fail: agentPatch({ name: 'builder' }), file: AGENT },
  { rule: 'name.file', name: 'environment', pass: noop, fail: envPatch({ name: 'other' }), file: ENV },
  {
    rule: 'name.unique',
    name: 'agent names are unique',
    pass: add('agents/implementer-2.yaml', agentYaml('implementer-2')),
    fail: add('agents/implementer-2.yaml', agentYaml('implementer')),
    file: 'agents/implementer-2.yaml',
  },
  {
    rule: 'description',
    name: 'agent: at most 500 characters',
    pass: agentPatch({ description: 'x'.repeat(500) }),
    fail: agentPatch({ description: 'x'.repeat(501) }),
    file: AGENT,
  },
  {
    rule: 'description',
    name: 'environment: a string',
    pass: envPatch({ description: undefined }),
    fail: envPatch({ description: ['a list'] }),
    file: ENV,
  },

  // Agent
  { rule: 'harness', name: 'a registered harness', pass: noop, fail: agentPatch({ harness: 'gpt-agent' }), file: AGENT },
  { rule: 'harness', name: 'required', pass: noop, fail: agentPatch({ harness: undefined }), file: AGENT },
  {
    rule: 'model',
    name: 'non-empty; the model list is advisory',
    pass: agentPatch({ model: 'some-future-model' }),
    fail: agentPatch({ model: ' ' }),
    file: AGENT,
  },
  {
    rule: 'effort',
    name: "one of the harness's levels",
    pass: agentPatch({ effort: 'xhigh' }),
    fail: agentPatch({ effort: 'minimal' }), // a Codex level, not a Claude one
    file: AGENT,
  },
  {
    rule: 'instructions',
    name: 'at most 64 KB',
    pass: agentPatch({ instructions: kb(64) }),
    fail: agentPatch({ instructions: `${kb(64)}x` }),
    file: AGENT,
  },
  {
    rule: 'instructions.one-of',
    name: 'instructions or instructionsFile, not both (neither is allowed)',
    pass: agentPatch({ instructions: undefined }),
    fail: agentPatch({ instructionsFile: 'prompts/lead.md' }),
    file: AGENT,
  },
  {
    rule: 'instructionsFile.path',
    name: 'repo-relative',
    pass: agentPatch({ instructions: undefined, instructionsFile: 'prompts/lead.md' }),
    fail: agentPatch({ instructions: undefined, instructionsFile: '../prompts/lead.md' }),
    file: AGENT,
  },
  {
    rule: 'instructionsFile.type',
    name: '.md or .txt',
    pass: both(add('prompts/plain.txt', 'Be brief.\n'), agentPatch({ instructions: undefined, instructionsFile: 'prompts/plain.txt' })),
    fail: agentPatch({ instructions: undefined, instructionsFile: 'puck.schema.json' }),
    file: AGENT,
  },
  {
    rule: 'instructionsFile.exists',
    name: 'exists at the same commit',
    pass: agentPatch({ instructions: undefined, instructionsFile: 'prompts/reviewer.md' }),
    fail: agentPatch({ instructions: undefined, instructionsFile: 'prompts/missing.md' }),
    file: AGENT,
  },
  {
    rule: 'instructionsFile.size',
    name: 'at most 64 KB',
    pass: both(add('prompts/big.md', kb(64)), agentPatch({ instructions: undefined, instructionsFile: 'prompts/big.md' })),
    fail: both(add('prompts/big.md', `${kb(64)}x`), agentPatch({ instructions: undefined, instructionsFile: 'prompts/big.md' })),
    file: AGENT,
  },
  {
    rule: 'options',
    name: 'unknown ids are errors',
    pass: agentPatch({ options: { maxTurns: 10, 'tool.Bash': false } }),
    fail: agentPatch({ options: { maxTurn: 10 } }),
    file: AGENT,
  },
  {
    rule: 'options',
    name: 'wrong types are errors',
    pass: agentPatch({ options: { permissionMode: 'plan' } }),
    fail: agentPatch({ options: { maxTurns: '10' } }),
    file: AGENT,
  },
  {
    rule: 'options',
    name: "checked against the agent's own harness",
    pass: agentPatch({ harness: 'codex', effort: 'high', options: { sandbox_mode: 'workspace-write' } }, 'agents/reviewer.yaml'),
    fail: agentPatch({ harness: 'codex', effort: 'high' }, 'agents/reviewer.yaml'), // Claude tool toggles
    file: 'agents/reviewer.yaml',
  },
  {
    rule: 'advanced',
    name: 'a plain object',
    pass: agentPatch({ advanced: { settingSources: ['project'] } }),
    fail: agentPatch({ advanced: ['settingSources'] }),
    file: AGENT,
  },

  // Environment
  {
    rule: 'image',
    name: 'a Docker reference',
    pass: envPatch({ image: `ghcr.io/acme/base:1.2@sha256:${'a'.repeat(64)}` }),
    fail: envPatch({ image: 'Not An Image' }),
    file: ENV,
  },
  { rule: 'image', name: 'never starts with -', pass: noop, fail: envPatch({ image: '--privileged' }), file: ENV },
  {
    rule: 'image.one-of',
    name: 'image or dockerfile, not both',
    pass: both(add('docker/dev.Dockerfile', 'FROM node:22\n'), envPatch({ image: undefined, dockerfile: 'docker/dev.Dockerfile' })),
    fail: both(add('docker/dev.Dockerfile', 'FROM node:22\n'), envPatch({ dockerfile: 'docker/dev.Dockerfile' })),
    file: ENV,
  },
  { rule: 'image.one-of', name: 'one is required', pass: noop, fail: envPatch({ image: undefined }), file: ENV },
  {
    rule: 'dockerfile.path',
    name: 'repo-relative',
    pass: both(add('Dockerfile', 'FROM node:22\n'), envPatch({ image: undefined, dockerfile: 'Dockerfile' })),
    fail: envPatch({ image: undefined, dockerfile: '/etc/Dockerfile' }),
    file: ENV,
  },
  {
    rule: 'dockerfile.exists',
    name: 'exists at the same commit',
    pass: both(add('Dockerfile', 'FROM node:22\n'), envPatch({ image: undefined, dockerfile: 'Dockerfile' })),
    fail: envPatch({ image: undefined, dockerfile: 'docker/missing.Dockerfile' }),
    file: ENV,
  },
  { rule: 'resources', name: 'a map', pass: envPatch({ resources: undefined }), fail: envPatch({ resources: 4 }), file: ENV },
  {
    rule: 'resources.cpus',
    name: '0.5 to 64',
    pass: envPatch({ resources: { cpus: 0.5, memory: '512m' } }),
    fail: envPatch({ resources: { cpus: 65 } }),
    file: ENV,
  },
  {
    rule: 'resources.memory',
    name: 'like 512m or 8g',
    pass: envPatch({ resources: { memory: '16G' } }),
    fail: envPatch({ resources: { memory: '8GB' } }),
    file: ENV,
  },
  { rule: 'repos', name: 'at least one', pass: noop, fail: envPatch({ repos: [] }), file: ENV },
  { rule: 'repos', name: 'entries are maps', pass: noop, fail: envPatch({ repos: [null] }), file: ENV },
  { rule: 'agents', name: 'entries are maps', pass: noop, fail: envPatch({ agents: ['implementer'] }), file: ENV },
  { rule: 'repos', name: 'at most 10', pass: envPatch({ repos: repos(10) }), fail: envPatch({ repos: repos(11) }), file: ENV },
  {
    rule: 'repos.github',
    name: 'owner/name',
    pass: envPatch({ repos: [{ github: 'acme/web' }] }),
    fail: envPatch({ repos: [{ github: 'acme', dir: 'web' }] }),
    file: ENV,
  },
  {
    rule: 'repos.github.unique',
    name: 'unique (GitHub names ignore case)',
    pass: envPatch({ repos: [{ github: 'acme/web' }, { github: 'acme/api' }] }),
    fail: envPatch({ repos: [{ github: 'acme/web' }, { github: 'Acme/Web', dir: 'web-2' }] }),
    file: ENV,
  },
  {
    rule: 'repos.dir',
    name: 'name rule',
    pass: envPatch({ repos: [{ github: 'acme/web', dir: 'web-2' }] }),
    fail: envPatch({ repos: [{ github: 'acme/web', dir: 'Web' }] }),
    file: ENV,
  },
  {
    rule: 'repos.dir',
    name: 'the default (the repo name) must follow the name rule too',
    pass: envPatch({ repos: [{ github: 'octocat/Hello-World', dir: 'hello-world' }] }),
    fail: envPatch({ repos: [{ github: 'octocat/Hello-World' }] }),
    file: ENV,
  },
  {
    rule: 'repos.dir.unique',
    name: 'unique, defaults included',
    pass: envPatch({ repos: [{ github: 'acme/web' }, { github: 'other/web', dir: 'other-web' }] }),
    fail: envPatch({ repos: [{ github: 'acme/web' }, { github: 'other/web' }] }),
    file: ENV,
  },
  {
    rule: 'repos.branch',
    name: 'a valid branch name',
    pass: envPatch({ repos: [{ github: 'acme/web', branch: 'release/1.x' }] }),
    fail: envPatch({ repos: [{ github: 'acme/web', branch: 'feature..x' }] }),
    file: ENV,
  },
  { rule: 'orchestrator', name: 'required', pass: noop, fail: envPatch({ orchestrator: undefined }), file: ENV },
  {
    rule: 'orchestrator.agent',
    name: 'an existing agent',
    pass: envPatch({ orchestrator: { agent: 'implementer' } }),
    fail: envPatch({ orchestrator: { agent: 'nobody' } }),
    file: ENV,
  },
  {
    rule: 'orchestrator.harness',
    name: 'whose harness is claude-code',
    pass: agentPatch({ harness: 'codex', effort: 'high', options: undefined }),
    fail: both(agentPatch({ harness: 'codex', effort: 'high', options: undefined }), envPatch({ orchestrator: { agent: 'implementer' } })),
    file: ENV,
  },
  {
    rule: 'orchestrator.autoWake',
    name: 'a boolean',
    pass: envPatch({ orchestrator: { agent: 'lead', autoWake: false } }),
    fail: envPatch({ orchestrator: { agent: 'lead', autoWake: 'no' } }),
    file: ENV,
  },
  {
    rule: 'orchestrator.maxAutoTurnsPerHour',
    name: '1 to 200',
    pass: envPatch({ orchestrator: { agent: 'lead', maxAutoTurnsPerHour: 200 } }),
    fail: envPatch({ orchestrator: { agent: 'lead', maxAutoTurnsPerHour: 0 } }),
    file: ENV,
  },
  {
    rule: 'orchestrator.maxAutoTurnsPerHour',
    name: 'whole numbers only',
    pass: envPatch({ orchestrator: { agent: 'lead', maxAutoTurnsPerHour: 1 } }),
    fail: envPatch({ orchestrator: { agent: 'lead', maxAutoTurnsPerHour: 1.5 } }),
    file: ENV,
  },
  { rule: 'agents', name: 'at least one', pass: noop, fail: envPatch({ agents: [] }), file: ENV },
  {
    rule: 'agents.agent',
    name: 'an existing agent file; the orchestrator may also be a worker',
    pass: envPatch({ agents: [{ agent: 'lead' }, { agent: 'implementer' }] }),
    fail: envPatch({ agents: [{ agent: 'ghost' }] }),
    file: ENV,
  },
  {
    rule: 'agents.unique',
    name: 'unique refs',
    pass: noop,
    fail: envPatch({ agents: [{ agent: 'implementer' }, { agent: 'implementer', maxParallel: 2 }] }),
    file: ENV,
  },
  {
    rule: 'agents.maxParallel',
    name: '1 to 16',
    pass: envPatch({ agents: [{ agent: 'implementer', maxParallel: 16 }] }),
    fail: envPatch({ agents: [{ agent: 'implementer', maxParallel: 17 }] }),
    file: ENV,
  },
  {
    rule: 'agents.instructions',
    name: 'at most 16 KB',
    pass: envPatch({ agents: [{ agent: 'implementer', instructions: kb(16) }] }),
    fail: envPatch({ agents: [{ agent: 'implementer', instructions: `${kb(16)}x` }] }),
    file: ENV,
  },
  { rule: 'limits', name: 'a map', pass: envPatch({ limits: undefined }), fail: envPatch({ limits: 'none' }), file: ENV },
  {
    rule: 'limits.maxWorkers',
    name: '1 to 64',
    pass: envPatch({ limits: { maxWorkers: 64 } }),
    fail: envPatch({ limits: { maxWorkers: 65 } }),
    file: ENV,
  },
  {
    rule: 'limits.maxAttempts',
    name: '1 to 10',
    pass: envPatch({ limits: { maxAttempts: 10 } }),
    fail: envPatch({ limits: { maxAttempts: 11 } }),
    file: ENV,
  },
  { rule: 'policies', name: 'a map', pass: envPatch({ policies: {} }), fail: envPatch({ policies: ['user'] }), file: ENV },
  {
    rule: 'policies.asks',
    name: 'orchestrator-first or user',
    pass: envPatch({ policies: { asks: 'user' } }),
    fail: envPatch({ policies: { asks: 'always' } }),
    file: ENV,
  },
  {
    rule: 'policies.publish',
    name: 'manual or orchestrator',
    pass: envPatch({ policies: { publish: 'manual' } }),
    fail: envPatch({ policies: { publish: 'auto' } }),
    file: ENV,
  },
  {
    rule: 'policies.draftPullRequests',
    name: 'a boolean',
    pass: envPatch({ policies: { draftPullRequests: false } }),
    fail: envPatch({ policies: { draftPullRequests: 'false' } }),
    file: ENV,
  },
  {
    rule: 'policies.github',
    name: 'a map of known keys',
    pass: envPatch({ policies: { github: { intake: 'label' } } }),
    fail: envPatch({ policies: { github: 'label' } }),
    file: ENV,
  },
  {
    rule: 'policies.github.intake',
    name: 'off or label',
    pass: envPatch({ policies: { github: { intake: 'off' } } }),
    fail: envPatch({ policies: { github: { intake: 'assign' } } }),
    file: ENV,
  },
  {
    rule: 'policies.github.intakeLabel',
    name: 'a label without commas or colons',
    pass: envPatch({ policies: { github: { intakeLabel: 'agent work' } } }),
    fail: envPatch({ policies: { github: { intakeLabel: 'puck:web' } } }),
    file: ENV,
  },
  {
    rule: 'policies.github.agentLabels',
    name: 'a boolean',
    pass: envPatch({ policies: { github: { agentLabels: false } } }),
    fail: envPatch({ policies: { github: { agentLabels: 'no' } } }),
    file: ENV,
  },
  {
    rule: 'policies.github.statusComment',
    name: 'a boolean',
    pass: envPatch({ policies: { github: { statusComment: false } } }),
    fail: envPatch({ policies: { github: { statusComment: 1 } } }),
    file: ENV,
  },
  {
    rule: 'policies.github.ci',
    name: 'notify or fix',
    pass: envPatch({ policies: { github: { ci: 'fix' } } }),
    fail: envPatch({ policies: { github: { ci: 'rerun' } } }),
    file: ENV,
  },
  {
    rule: 'policies.github.maxCiFixAttempts',
    name: '1 to 5',
    pass: envPatch({ policies: { github: { maxCiFixAttempts: 5 } } }),
    fail: envPatch({ policies: { github: { maxCiFixAttempts: 6 } } }),
    file: ENV,
  },
  {
    rule: 'policies.github.reviews',
    name: 'notify or address',
    pass: envPatch({ policies: { github: { reviews: 'address' } } }),
    fail: envPatch({ policies: { github: { reviews: 'resolve' } } }),
    file: ENV,
  },
  {
    rule: 'policies.github.allowWorkflowEdits',
    name: 'a boolean',
    pass: envPatch({ policies: { github: { allowWorkflowEdits: true } } }),
    fail: envPatch({ policies: { github: { allowWorkflowEdits: 'yes' } } }),
    file: ENV,
  },
  { rule: 'git', name: 'a map', pass: envPatch({ git: {} }), fail: envPatch({ git: 'Puck Agent' }), file: ENV },
  {
    rule: 'git.userName',
    name: 'non-empty',
    pass: envPatch({ git: { userName: 'Puck Agent' } }),
    fail: envPatch({ git: { userName: '  ' } }),
    file: ENV,
  },
  {
    rule: 'git.userEmail',
    name: 'non-empty',
    pass: envPatch({ git: { userEmail: 'puck-agent@users.noreply.github.com' } }),
    fail: envPatch({ git: { userEmail: '' } }),
    file: ENV,
  },
  { rule: 'env', name: 'a map', pass: envPatch({ env: {} }), fail: envPatch({ env: ['NODE_ENV=dev'] }), file: ENV },
  {
    rule: 'env.key',
    name: 'variable names',
    pass: envPatch({ env: { _PRIVATE: 'x', Mixed_Case9: 'y' } }),
    fail: envPatch({ env: { '9LIVES': 'x' } }),
    file: ENV,
  },
  {
    rule: 'env.reserved',
    name: 'PUCK_ is reserved',
    pass: envPatch({ env: { PUCKISH: 'x' } }),
    fail: envPatch({ env: { PUCK_HOME: '/tmp' } }),
    file: ENV,
  },
  {
    rule: 'env.value',
    name: 'string values',
    pass: envPatch({ env: { PORT: '3000' } }),
    fail: envPatch({ env: { PORT: 3000 } }),
    file: ENV,
  },
  { rule: 'secrets', name: 'a list', pass: envPatch({ secrets: [] }), fail: envPatch({ secrets: 'NPM_TOKEN' }), file: ENV },
  {
    rule: 'secrets.name',
    name: 'the env key rule',
    pass: envPatch({ secrets: ['NPM_TOKEN'] }),
    fail: envPatch({ secrets: ['npm-token'] }),
    file: ENV,
  },
  { rule: 'secrets.name', name: 'PUCK_ is reserved', pass: noop, fail: envPatch({ secrets: ['PUCK_TOKEN'] }), file: ENV },
  {
    rule: 'secrets.unique',
    name: 'unique',
    pass: envPatch({ secrets: ['A', 'B'] }),
    fail: envPatch({ secrets: ['A', 'A'] }),
    file: ENV,
  },
];

function run(edit: Edit) {
  const files = exampleFiles();
  edit(files);
  return validateSnapshot(snapshotOf(files));
}

describe('the example config repo', () => {
  it('validates with no errors, and its environment is startable', () => {
    const repo = run(noop);
    expect(repo.errors).toEqual([]);
    expect([...repo.agents.keys()].sort()).toEqual(['implementer', 'lead', 'reviewer']);
    expect([...repo.environments.keys()]).toEqual(['example']);
    expect(isStartable(repo, 'example')).toBe(true);
  });
});

describe('definition field rules', () => {
  it('every rule has a passing and a failing case', () => {
    const covered = new Set(CASES.map((c) => c.rule));
    expect(RULES.filter((r) => !covered.has(r))).toEqual([]);
  });

  for (const c of CASES) {
    describe(`${c.rule}: ${c.name}`, () => {
      it('passes', () => {
        expect(run(c.pass).errors).toEqual([]);
      });

      it('fails with the rule, file, line and column', () => {
        const errors = run(c.fail).errors.filter((e) => e.rule === c.rule);
        expect(errors.length, JSON.stringify(run(c.fail).errors.map((e) => e.rule))).toBeGreaterThan(0);
        for (const e of errors) {
          if (c.file) expect(e.file).toBe(c.file);
          expect(e.line).toBeGreaterThanOrEqual(1);
          expect(e.column).toBeGreaterThanOrEqual(1);
          expect(e.message).not.toBe('');
        }
      });
    });
  }
});

describe('error positions', () => {
  it('points at the offending value, and at the key for unknown fields and ids', () => {
    const files = exampleFiles();
    files[ENV] = files[ENV].replace('env: { NODE_ENV: development }', 'env:\n  NODE_ENV: development\n  PORT: 3000\n  PUCK_X: y');
    files[AGENT] = files[AGENT].replace('  maxTurns: 150', '  maxTurns: 150\n  maxTurn: 3');
    const { errors } = validateSnapshot(snapshotOf(files));
    const lines = files[ENV].split('\n');
    const port = errors.find((e) => e.rule === 'env.value');
    expect(port).toMatchObject({ file: ENV, field: 'env.PORT', line: lines.indexOf('  PORT: 3000') + 1, column: 9 });
    const reserved = errors.find((e) => e.rule === 'env.reserved');
    expect(reserved).toMatchObject({ field: 'env.PUCK_X', line: lines.indexOf('  PUCK_X: y') + 1, column: 3 });
    const unknown = errors.find((e) => e.rule === 'options');
    const agentLines = files[AGENT].split('\n');
    expect(unknown).toMatchObject({ file: AGENT, field: 'options.maxTurn', line: agentLines.indexOf('  maxTurn: 3') + 1, column: 3 });
  });

  it('a missing required field points at the map it belongs in', () => {
    const files = exampleFiles();
    files[ENV] = files[ENV].replace(/^orchestrator:\n(?: {2}.*\n)+/m, '');
    const err = validateSnapshot(snapshotOf(files)).errors.find((e) => e.rule === 'orchestrator');
    expect(err).toMatchObject({ file: ENV, field: '', line: 2, column: 1 });
  });
});

describe('startability and summaries', () => {
  it('an environment with an invalid agent is valid but not startable', () => {
    const repo = run(agentPatch({ effort: 'ludicrous' }));
    const { environments, agents } = summarize(repo);
    expect(environments).toEqual([
      expect.objectContaining({
        name: 'example',
        valid: true,
        startable: false,
        orchestrator: 'lead',
        agents: ['implementer', 'reviewer'],
        secrets: [],
        resources: { cpus: 4, memory: '8g' },
      }),
    ]);
    expect(agents.find((a) => a.name === 'implementer')).toMatchObject({ valid: false, harness: 'claude-code' });
  });

  it('an agent file that does not parse still exists: only its own error, and no startable env', () => {
    const repo = run(add('agents/reviewer.yaml', 'name: [\n'));
    expect(repo.errors.map((e) => [e.file, e.rule])).toEqual([['agents/reviewer.yaml', 'yaml.syntax']]);
    expect(isStartable(repo, 'example')).toBe(false);
  });

  it('an agent nobody references does not affect startability', () => {
    const repo = run(add('agents/spare.yaml', agentYaml('spare', { harness: 'nope' })));
    expect(isStartable(repo, 'example')).toBe(true);
    expect(repo.errors.map((e) => e.file)).toEqual(['agents/spare.yaml']);
  });

  it('ignores every path outside agents/*.yaml and environments/*.yaml', () => {
    const repo = run(
      both(add('agents/nested/x.yaml', 'nonsense: ['), add('agents/x.yml', 'nonsense: ['), add('environments/README.md', '# hi')),
    );
    expect(repo.errors).toEqual([]);
  });
});

describe('tree lookups', () => {
  it('never treat Object.prototype names as files at the commit', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const errors = run(envPatch({ image: undefined, dockerfile: name })).errors;
      expect(errors.map((e) => e.rule), name).toEqual(['dockerfile.exists']);
    }
  });
});

describe('pure checks', () => {
  it('ref names follow git check-ref-format', () => {
    for (const ok of ['main', 'release/1.x', 'v1.2.3', 'feat_x-y']) expect(isValidRefName(ok), ok).toBe(true);
    for (const bad of ['', '-x', 'a..b', 'a b', 'a~1', 'a^', 'a:b', 'x.lock', '.hidden', 'a/', 'a//b', 'a@{1}', '@', 'HEAD', 'a\\b']) {
      expect(isValidRefName(bad), bad).toBe(false);
    }
  });

  it('repo-relative paths', () => {
    const max = 'a'.repeat(1024);
    for (const ok of ['a.md', 'prompts/a/b.md', '.github/x.yml', max, `${'a'.repeat(1022)}/b`]) {
      expect(isRepoRelativePath(ok), ok).toBe(true);
    }
    for (const bad of ['', '/a', 'a/../b', './a', 'a//b', 'a\\b', 'a/', 'a\0b', `${max}x`, 'a/./b', '.', '..', 'docker/Dev/']) {
      expect(isRepoRelativePath(bad), bad).toBe(false);
    }
  });

  it('Docker references', () => {
    for (const ok of ['node:22-bookworm', 'ubuntu', 'ghcr.io/acme/app:1.0', 'localhost:5000/x', `a/b@sha256:${'f'.repeat(64)}`]) {
      expect(isDockerReference(ok), ok).toBe(true);
    }
    for (const bad of ['-x', 'Node:22', 'a b', 'x:', '', 'x@sha256:12']) expect(isDockerReference(bad), bad).toBe(false);
  });
});
