import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { harnessDescriptors } from '../../src/harness/providers';
import { definitionSchema, schemaText } from '../../src/harness/definitions/schema';
import { definitionPaths, isRepoRelativePath } from '../../src/harness/definitions/validate';
import { exampleFiles } from './definitions-fixtures';

const root = join(__dirname, '..', '..');

// ajv's defaults (strict mode on) so the schema works in the widest set of validators.
const validate = new Ajv().compile(definitionSchema());

const agent = (extra: Record<string, unknown>) => ({ apiVersion: 'puck/v1', kind: 'Agent', name: 'a', harness: 'claude-code', ...extra });
const environment = (extra: Record<string, unknown> = {}) => ({
  apiVersion: 'puck/v1',
  kind: 'Environment',
  name: 'e',
  image: 'node:22-bookworm',
  repos: [{ github: 'acme/web' }],
  orchestrator: { agent: 'lead' },
  agents: [{ agent: 'lead' }],
  ...extra,
});

describe('the generated JSON Schema', () => {
  it('is committed, current, in both places (npm run schema regenerates it)', () => {
    const text = schemaText();
    expect(readFileSync(join(root, 'schema/puck.schema.json'), 'utf8')).toBe(text);
    expect(readFileSync(join(root, 'docs/examples/config-repo/puck.schema.json'), 'utf8')).toBe(text);
  });

  it('accepts every definition file of the example config repo', () => {
    const files = exampleFiles();
    const defs = definitionPaths(Object.keys(files));
    expect(defs).toHaveLength(4);
    for (const def of defs) {
      const ok = validate(parse(files[def.path]));
      expect(ok, `${def.path}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it('checks options per harness', () => {
    expect(validate(agent({ options: { maxTurns: 10, 'tool.Bash': false } }))).toBe(true);
    expect(validate(agent({ options: { maxTurn: 10 } }))).toBe(false);
    expect(validate(agent({ options: { maxTurns: '10' } }))).toBe(false);
    expect(validate(agent({ harness: 'codex', options: { sandbox_mode: 'read-only' } }))).toBe(true);
    expect(validate(agent({ harness: 'codex', options: { 'tool.Bash': false } }))).toBe(false);
    expect(validate(agent({ effort: 'max' }))).toBe(true);
    expect(validate(agent({ harness: 'codex', effort: 'max' }))).toBe(false);
  });

  it('accepts a repo path exactly when the validator does', () => {
    const max = 'a'.repeat(1024);
    const paths = [
      'a.md',
      'prompts/a/b.md',
      '.github/x.md',
      'prompts/lead.md',
      'Dockerfile',
      'docker/Dev',
      '...md',
      'foo./x.md',
      'a/..b.md',
      '.hidden/x.md',
      max,
      'prompts//lead.md',
      'prompts/lead.md/',
      'docker/Dev/',
      '/prompts/lead.md',
      'a/../b.md',
      './a.md',
      '../a.md',
      'a/./b.md',
      'a\\b.md',
      'prompts/a\0.md',
      `${max}x`,
      '',
      '.',
      '..',
      'a//b',
      'a/',
    ];
    const dockerfileOnly = (dockerfile: string) => ({
      apiVersion: 'puck/v1',
      kind: 'Environment',
      name: 'e',
      dockerfile,
      repos: [{ github: 'acme/web' }],
      orchestrator: { agent: 'lead' },
      agents: [{ agent: 'lead' }],
    });
    for (const p of paths) {
      expect(validate(dockerfileOnly(p)), `dockerfile ${JSON.stringify(p)}`).toBe(isRepoRelativePath(p));
      const fileOk = isRepoRelativePath(p) && /\.(md|txt)$/.test(p);
      expect(validate(agent({ instructionsFile: p })), `instructionsFile ${JSON.stringify(p)}`).toBe(fileOk);
    }
  });

  it('rejects single-file mistakes', () => {
    expect(validate(agent({ instructions: 'x', instructionsFile: 'prompts/x.md' }))).toBe(false);
    expect(validate(agent({ instructionsFile: '../x.md' }))).toBe(false);
    expect(validate(agent({ instructionsFile: 'prompts/x.json' }))).toBe(false);
    expect(validate(agent({ name: 'Bad' }))).toBe(false);
    expect(validate(agent({ unknown: 1 }))).toBe(false);
    expect(validate({ ...agent({}), apiVersion: 'puck/v2' })).toBe(false);
    expect(validate(environment())).toBe(true);
    expect(validate(environment({ image: undefined }))).toBe(false);
    expect(validate(environment({ dockerfile: 'Dockerfile' }))).toBe(false);
    expect(validate(environment({ image: '--privileged' }))).toBe(false);
    expect(validate(environment({ repos: [] }))).toBe(false);
    expect(validate(environment({ agents: [{ agent: 'lead', maxParallel: 17 }] }))).toBe(false);
    expect(validate(environment({ env: { PUCK_HOME: 'x' } }))).toBe(false);
    expect(validate(environment({ env: { PORT: 3000 } }))).toBe(false);
    expect(validate(environment({ secrets: ['A', 'A'] }))).toBe(false);
    expect(validate(environment({ resources: { memory: '8GB' } }))).toBe(false);
    expect(validate({ apiVersion: 'puck/v1', kind: 'Widget', name: 'x' })).toBe(false);
  });

  it('round-trips YAML the way editors see it', () => {
    expect(validate(parse(stringify(environment({ policies: { asks: 'user' } }))))).toBe(true);
  });

  it('$id changes exactly when the schema body does', () => {
    const id = definitionSchema().$id as string;
    expect(id).toMatch(/^urn:puck:definitions:v1:[0-9a-f]{8}$/);
    expect(definitionSchema().$id).toBe(id);
    expect(definitionSchema(harnessDescriptors.slice(0, 1)).$id).not.toBe(id);
  });
});
