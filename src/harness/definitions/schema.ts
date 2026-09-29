/**
 * The JSON Schema (draft-07) for definition files, generated from the field
 * tables and the registered harness descriptors. Editors and config-repo CI
 * validate single files against it; the cross-file rules (names equal file
 * names, references exist, the orchestrator's harness, sizes in bytes) run
 * only in Puck. Per-harness `effort` and `options` sit under if/then on
 * `harness`, so editors autocomplete option ids.
 *
 * `npm run schema` writes schemaText() to schema/puck.schema.json and the
 * example config repo; a unit test and CI fail when a committed copy drifts.
 * The `$id` ends in a hash of the schema body, so it changes exactly when
 * the schema does and a stale copy in a config repo is detectable.
 */

import type { ProviderOption } from '../options';
import { harnessDescriptors, type HarnessDescriptor } from '../providers';
import { API_VERSION, DEFAULT_GITHUB_POLICIES as GH, ENV_KEY_RE, INTAKE_LABEL_RE, LIMITS, NAME_RE, RESERVED_ENV_PREFIX } from './types';
import { DOCKER_REF_PATTERN, ORCHESTRATOR_HARNESS, REPO_PATH_PATTERN, REPO_RE } from './validate';

export type JsonSchema = Record<string, unknown>;

export const SCHEMA_DRAFT = 'http://json-schema.org/draft-07/schema#';
const ID_PREFIX = 'urn:puck:definitions:v1:';

/** FNV-1a (32-bit) as 8 hex digits. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function optionSchema(opt: ProviderOption): JsonSchema {
  const base = { description: opt.description };
  switch (opt.kind) {
    case 'boolean':
      return { ...base, type: 'boolean', default: opt.default };
    case 'enum':
      return { ...base, type: 'string', enum: [...opt.values], default: opt.default };
    case 'number': {
      const onGrid = Number.isInteger(opt.min / opt.step);
      const out: JsonSchema = { ...base, type: opt.step === 1 && Number.isInteger(opt.min) ? 'integer' : 'number' };
      out.minimum = opt.min;
      out.maximum = opt.max;
      if (onGrid && opt.step !== 1) out.multipleOf = opt.step;
      return out;
    }
    case 'string':
      return { ...base, type: 'string', default: opt.default };
    case 'string-list':
      return { ...base, type: 'array', items: { type: 'string' }, default: [...opt.default] };
  }
}

function harnessRule(h: HarnessDescriptor): JsonSchema {
  return {
    if: { type: 'object', properties: { harness: { const: h.id } }, required: ['harness'] },
    then: {
      type: 'object',
      properties: {
        effort: { type: 'string', enum: [...h.thinkingLevels] },
        options: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(h.configOptions.map((o) => [o.id, optionSchema(o)])),
        },
      },
    },
  };
}

const text = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', description, ...extra });
const int = (description: string, minimum: number, maximum: number): JsonSchema => ({
  type: 'integer',
  description,
  minimum,
  maximum,
});
const map = (properties: Record<string, JsonSchema>, extra: JsonSchema = {}): JsonSchema => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...extra,
});

function header(kind: 'Agent' | 'Environment'): Record<string, JsonSchema> {
  return {
    apiVersion: { const: API_VERSION, description: 'Definition format version.' },
    kind: { const: kind },
    name: { $ref: '#/definitions/name', description: 'Must equal the file name without .yaml.' },
    description: text('Shown in Puck and to the orchestrator.', { maxLength: LIMITS.description }),
  };
}

function agentSchema(harnesses: readonly HarnessDescriptor[]): JsonSchema {
  return map(
    {
      ...header('Agent'),
      harness: { type: 'string', enum: harnesses.map((h) => h.id), description: 'The harness that runs this agent.' },
      model: text('Model id, or auto for the harness default.', { minLength: 1, pattern: '\\S', default: 'auto' }),
      effort: text("One of the harness's effort levels.", { default: 'auto' }),
      instructions: text('The agent\'s instructions (at most 64 KB). Use this or instructionsFile.', {
        maxLength: LIMITS.instructionsBytes,
      }),
      instructionsFile: text('A .md or .txt file in this repo holding the instructions (at most 64 KB).', {
        allOf: [{ pattern: REPO_PATH_PATTERN }, { pattern: '\\.(md|txt)$' }],
      }),
      options: { type: 'object', description: 'Overrides of the harness options; only listed ids are allowed.' },
      advanced: { type: 'object', description: 'Merged into the SDK options last.' },
    },
    {
      required: ['apiVersion', 'kind', 'name', 'harness'],
      not: { required: ['instructions', 'instructionsFile'] },
      allOf: harnesses.map(harnessRule),
    },
  );
}

function environmentSchema(): JsonSchema {
  const noReserved = { not: { pattern: `^${RESERVED_ENV_PREFIX}` } };
  return map(
    {
      ...header('Environment'),
      image: text('Docker image reference. Use this or dockerfile.', { pattern: DOCKER_REF_PATTERN }),
      dockerfile: text('A Dockerfile in this repo, built without a context. Use this or image.', {
        pattern: REPO_PATH_PATTERN,
      }),
      resources: map({
        cpus: { type: 'number', minimum: 0.5, maximum: 64, description: 'CPU limit.' },
        memory: text('Memory limit, like 512m or 8g.', { pattern: '^[1-9][0-9]*[bkmgBKMG]$' }),
      }),
      repos: {
        type: 'array',
        minItems: 1,
        maxItems: LIMITS.repos,
        items: map(
          {
            github: text('owner/name on GitHub.', { pattern: REPO_RE.source }),
            dir: { $ref: '#/definitions/name', description: 'Directory under /workspace (default: the repo name).' },
            branch: text('Base branch for worktrees and pull requests (default: the repo default branch).', {
              minLength: 1,
            }),
          },
          { required: ['github'] },
        ),
      },
      orchestrator: map(
        {
          agent: { $ref: '#/definitions/name', description: `The orchestrator agent; its harness must be ${ORCHESTRATOR_HARNESS}.` },
          autoWake: { type: 'boolean', default: true, description: 'Start an orchestrator turn when notices arrive.' },
          maxAutoTurnsPerHour: { ...int('Cap on automatic orchestrator turns.', 1, 200), default: 30 },
        },
        { required: ['agent'] },
      ),
      agents: {
        type: 'array',
        minItems: 1,
        items: map(
          {
            agent: { $ref: '#/definitions/name', description: 'An agent file in agents/.' },
            maxParallel: { ...int('Concurrent work items for this agent.', 1, 16), default: 1 },
            instructions: text("Appended to the agent's instructions in this environment.", {
              maxLength: LIMITS.assignmentInstructionsBytes,
            }),
          },
          { required: ['agent'] },
        ),
      },
      limits: map({
        maxWorkers: int('Environment-wide cap on concurrent worker turns (default: the sum of maxParallel).', 1, 64),
        maxAttempts: { ...int('Automatic requeues before an item fails.', 1, 10), default: 2 },
      }),
      policies: map({
        asks: { type: 'string', enum: ['orchestrator-first', 'user'], default: 'orchestrator-first' },
        publish: { type: 'string', enum: ['manual', 'orchestrator'], default: 'orchestrator' },
        draftPullRequests: { type: 'boolean', default: true },
        github: map({
          intake: { type: 'string', enum: ['off', 'label'], default: GH.intake, description: 'Take in open issues carrying intakeLabel as work items.' },
          intakeLabel: {
            type: 'string',
            pattern: INTAKE_LABEL_RE.source,
            default: GH.intakeLabel,
            description: 'The intake label; <intakeLabel>:<agent> also assigns the item.',
          },
          agentLabels: { type: 'boolean', default: GH.agentLabels, description: 'Honor <intakeLabel>:<agent> labels.' },
          statusComment: { type: 'boolean', default: GH.statusComment, description: "Keep one Puck status comment on each linked issue." },
          ci: { type: 'string', enum: ['notify', 'fix'], default: GH.ci, description: 'fix also queues failing CI to the worker.' },
          maxCiFixAttempts: { ...int('Automatic CI fix follow-ups per item.', 1, 5), default: GH.maxCiFixAttempts },
          reviews: {
            type: 'string',
            enum: ['notify', 'address'],
            default: GH.reviews,
            description: 'address also queues review feedback from people with write access to the worker.',
          },
          allowWorkflowEdits: {
            type: 'boolean',
            default: GH.allowWorkflowEdits,
            description: "Give the environment's GitHub tokens the Workflows permission.",
          },
          allowCiRerun: {
            type: 'boolean',
            default: GH.allowCiRerun,
            description: "Let the orchestrator re-run failed CI jobs (gives the environment's GitHub tokens Actions write).",
          },
        }),
      }),
      git: map({
        userName: text('Commit author name (default: the GitHub login).', { minLength: 1, pattern: '\\S' }),
        userEmail: text('Commit author email (default: the GitHub noreply address).', { minLength: 1, pattern: '\\S' }),
      }),
      env: {
        type: 'object',
        description: `Environment variables; the ${RESERVED_ENV_PREFIX} prefix is reserved.`,
        propertyNames: { pattern: ENV_KEY_RE.source, ...noReserved },
        additionalProperties: { type: 'string' },
      },
      secrets: {
        type: 'array',
        description: 'Names of secrets whose values are entered in Puck, never written here.',
        uniqueItems: true,
        items: { type: 'string', pattern: ENV_KEY_RE.source, ...noReserved },
      },
    },
    {
      required: ['apiVersion', 'kind', 'name', 'repos', 'orchestrator', 'agents'],
      oneOf: [{ required: ['image'] }, { required: ['dockerfile'] }],
    },
  );
}

export function definitionSchema(harnesses: readonly HarnessDescriptor[] = harnessDescriptors): JsonSchema {
  const body: JsonSchema = {
    title: 'Puck definition',
    description: 'A Puck agent (agents/<name>.yaml) or environment (environments/<name>.yaml) definition.',
    type: 'object',
    required: ['apiVersion', 'kind'],
    properties: {
      apiVersion: { const: API_VERSION },
      kind: { enum: ['Agent', 'Environment'] },
    },
    allOf: [
      { if: { type: 'object', properties: { kind: { const: 'Agent' } }, required: ['kind'] }, then: { $ref: '#/definitions/agent' } },
      {
        if: { type: 'object', properties: { kind: { const: 'Environment' } }, required: ['kind'] },
        then: { $ref: '#/definitions/environment' },
      },
    ],
    definitions: {
      name: { type: 'string', pattern: NAME_RE.source },
      agent: agentSchema(harnesses),
      environment: environmentSchema(),
    },
  };
  return { $schema: SCHEMA_DRAFT, $id: `${ID_PREFIX}${fnv1a(JSON.stringify(body))}`, ...body };
}

/** The schema file as committed: two-space JSON with a trailing newline. */
export function schemaText(harnesses: readonly HarnessDescriptor[] = harnessDescriptors): string {
  return `${JSON.stringify(definitionSchema(harnesses), null, 2)}\n`;
}
