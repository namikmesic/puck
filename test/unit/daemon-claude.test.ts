import { createRequire } from 'node:module';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AskQuestion, HarnessEvent } from '../../src/harness/types';
import { runClaude, type ClaudeSdk } from '../../src/daemon/harness/claude';
import { claudeSpawner, harnessEnv } from '../../src/daemon/harness/spawn';
import type { AdapterContext, AdapterRequest } from '../../src/daemon/harness/types';
import { nullLogger } from '../../src/daemon/log';
import { claudeHarness } from '../../src/harness/providers';
import fixture from '../fixtures/claude-events.json';

// The Claude adapter is a port of the container runner's runClaude. The
// port is checked two ways: directly against a scripted SDK stream, and
// differentially against runner.js itself on the same stream, so "kept
// exactly" is a test, not a promise.
const requireCjs = createRequire(path.join(process.cwd(), 'package.json'));
const runner = requireCjs('./src/main/runner/runner.js') as {
  runClaude(req: unknown, sdk: unknown, ctx: unknown): Promise<void>;
};

type Script = Array<Record<string, unknown>>;

/** A Claude Agent SDK stand-in that streams the script and calls canUseTool for `$ask` entries. */
function scriptedSdk(script: Script) {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const permissions: unknown[] = [];
  const sdk = {
    query({ prompt, options }: { prompt: string; options: Record<string, unknown> }) {
      calls.push({ prompt, options });
      const canUseTool = options.canUseTool as (name: string, input: unknown) => Promise<unknown>;
      const gen = (async function* () {
        for (const msg of script) {
          if ('$ask' in msg) {
            permissions.push(await canUseTool('AskUserQuestion', { questions: msg.$ask }));
            continue;
          }
          yield msg;
        }
      })();
      return Object.assign(gen, { interrupt: vi.fn() });
    },
    createSdkMcpServer: vi.fn((opts: { name: string }) => ({ type: 'sdk', name: opts.name, instance: {} })),
  };
  return { sdk, calls, permissions };
}

function request(over: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    sessionId: 'ses_1',
    turnId: 'trn_1',
    prompt: 'check deps',
    resumeId: null,
    cwd: '/workspace',
    agent: {
      name: 'lead',
      description: '',
      harness: 'claude-code',
      model: 'claude-opus-5',
      effort: 'high',
      instructions: 'Be brief.',
      options: {},
      advanced: { maxTurns: 7 },
    },
    settings: { disallowedTools: ['WebSearch'] },
    tools: null,
    env: { PATH: '/usr/bin', HOME: '/puck/home' },
    ...over,
  };
}

async function drive(script: Script, over: Partial<AdapterRequest> = {}, answers: Record<string, string> | null = { 'Upgrade them?': 'Yes' }) {
  const events: HarnessEvent[] = [];
  const sessions: string[] = [];
  const asked: AskQuestion[][] = [];
  const ctx: AdapterContext = {
    emit: (e) => events.push(e),
    reportSession: (id) => sessions.push(id),
    onInterrupt: () => undefined,
    askUser: async (qs) => {
      asked.push(qs);
      return answers;
    },
    signal: new AbortController().signal,
  };
  const s = scriptedSdk(script);
  const tools = [{ name: 'backlog_list' }];
  const spawner = (): never => {
    throw new Error('not spawned in tests');
  };
  await runClaude(request(over), s.sdk as unknown as ClaudeSdk, ctx, {
    spawner,
    orchestratorTools: () => tools,
    daemonVersion: '0.0.1+abc',
  });
  return { events, sessions, asked, spawner, ...s };
}

/** The same script through runner.js, with the runner's context shape. */
async function driveRunner(script: Script) {
  const events: HarnessEvent[] = [];
  const sessions: string[] = [];
  let thinking = false;
  let session: string | null = null;
  const ctx = {
    emit: (e: HarnessEvent) => events.push(e),
    thinkingOn: () => {
      if (!thinking) {
        thinking = true;
        events.push({ kind: 'thinking', active: true });
      }
    },
    thinkingOff: () => {
      if (thinking) {
        thinking = false;
        events.push({ kind: 'thinking', active: false });
      }
    },
    session: (id: string) => {
      session = id;
      sessions.push(id);
    },
    setSession: (id: string) => (session = id),
    sessionId: () => session,
    endTurn: (stats: unknown) => events.push({ kind: 'turn-end', stats } as HarnessEvent),
    onInterrupt: () => undefined,
    askUser: async () => ({ 'Upgrade them?': 'Yes' }),
    cancelAsks: () => undefined,
  };
  const s = scriptedSdk(script);
  await runner.runClaude(
    {
      id: 't1',
      provider: 'claude-code',
      model: 'claude-opus-5',
      systemPrompt: 'Be brief.',
      thinking: 'high',
      settings: JSON.stringify({ disallowedTools: ['WebSearch'] }),
      advanced: JSON.stringify({ maxTurns: 7 }),
      resume: null,
      prompt: 'check deps',
    },
    s.sdk,
    ctx,
  );
  return { events, sessions, ...s };
}

const script = fixture as Script;
const strip = (events: HarnessEvent[]) =>
  events.map((e) => (e.kind === 'turn-end' ? { ...e, stats: { ...e.stats, durationMs: 0 } } : e));

describe('daemon Claude adapter', () => {
  it('emits exactly what the container runner emitted for the same SDK stream', async () => {
    const ported = await drive(script);
    const original = await driveRunner(script);
    expect(strip(ported.events)).toEqual(strip(original.events));
    expect(ported.sessions).toEqual(original.sessions);
    expect(ported.permissions).toEqual(original.permissions);
  });

  it('translates text, tools, sub-agents, and strips sub-agent plumbing', async () => {
    const { events, sessions } = await drive(script);
    expect(sessions).toEqual(['sess-claude-1']);
    expect(events.filter((e) => e.kind === 'thinking')).toEqual([
      { kind: 'thinking', active: true },
      { kind: 'thinking', active: false },
    ]);
    const parentText = events.filter((e) => e.kind === 'text-delta' && !e.parentId).map((e) => (e as { text: string }).text);
    expect(parentText.join('')).toBe('Let me check the tests. Done.');
    const starts = events.filter((e): e is Extract<HarnessEvent, { kind: 'tool-start' }> => e.kind === 'tool-start');
    expect(starts.map((e) => [e.toolId, e.tool, e.summary, e.parentId ?? null, e.agent ?? false])).toEqual([
      ['toolu_bash', 'Bash', 'npm test', null, false],
      ['toolu_read', 'Read', '/workspace/app/README.md', null, false],
      ['toolu_mcp', 'mcp__puck__backlog_list', '{"limit":5}', null, false],
      ['toolu_task', 'Agent', 'Audit dependencies - general-purpose', null, true],
      ['toolu_sub_grep', 'Grep', '"dependencies"', 'toolu_task', false],
    ]);
    const child = events.find((e) => e.kind === 'text-delta' && e.parentId === 'toolu_task');
    expect(child).toEqual({ kind: 'text-delta', text: 'Checking package.json\n\n', parentId: 'toolu_task' });
    const ends = events.filter((e): e is Extract<HarnessEvent, { kind: 'tool-end' }> => e.kind === 'tool-end');
    expect(ends.find((e) => e.toolId === 'toolu_task')?.output).toBe('Two deps are outdated.');
    expect(ends.find((e) => e.toolId === 'toolu_mcp')).toMatchObject({ ok: false, output: '(no output)' });
    // AskUserQuestion's raw cards stay hidden.
    expect(events.some((e) => (e.kind === 'tool-start' || e.kind === 'tool-end') && e.toolId === 'toolu_ask')).toBe(false);
    expect(events[events.length - 1]).toMatchObject({
      kind: 'turn-end',
      stats: { inputTokens: 1050, outputTokens: 70, costUsd: 0.042 },
    });
  });

  it('bridges AskUserQuestion through askUser, allowing with answers or denying on dismissal', async () => {
    const answered = await drive(script);
    expect(answered.asked).toEqual([
      [
        {
          question: 'Upgrade them?',
          header: 'Deps',
          multiSelect: false,
          options: [
            { label: 'Yes', description: 'Bump both' },
            { label: 'No', description: '' },
          ],
        },
      ],
    ]);
    expect(answered.permissions[0]).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Upgrade them?': 'Yes' } } });
    const dismissed = await drive(script, {}, null);
    expect(dismissed.permissions[0]).toMatchObject({ behavior: 'deny' });
  });

  it('builds SDK options from the session: cwd, allowlisted env, spawn hook, overrides last', async () => {
    const { calls } = await drive(script, { resumeId: 'sess-old', cwd: '/workspace/.puck/worktrees/W-1' });
    const options = calls[0].options;
    expect(options).toMatchObject({
      cwd: '/workspace/.puck/worktrees/W-1',
      env: { PATH: '/usr/bin', HOME: '/puck/home' },
      model: 'claude-opus-5',
      resume: 'sess-old',
      effort: 'high',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Be brief.' },
      disallowedTools: ['WebSearch'],
      maxTurns: 7,
    });
    expect(typeof options.spawnClaudeCodeProcess).toBe('function');
    expect(options.mcpServers).toBeUndefined(); // workers get no orchestrator tools
  });

  it('keeps the puck-user spawn, cwd, and allowlisted env when advanced overrides them', async () => {
    for (const spawnClaudeCodeProcess of [null, false]) {
      const { calls, spawner } = await drive([{ type: 'result', subtype: 'success', result: 'ok', usage: {} }], {
        cwd: '/workspace/.puck/worktrees/W-1',
        env: { PATH: '/usr/bin', HOME: '/puck/home' },
        agent: {
          ...request().agent,
          advanced: {
            maxTurns: 3,
            spawnClaudeCodeProcess,
            env: { PATH: '/tmp/evil', HOME: '/root' },
            cwd: '/root',
          },
        },
      });
      const options = calls[0].options;
      expect(options.spawnClaudeCodeProcess).toBe(spawner);
      expect(options.cwd).toBe('/workspace/.puck/worktrees/W-1');
      expect(options.env).toEqual({ PATH: '/usr/bin', HOME: '/puck/home' });
      expect(options.maxTurns).toBe(3);
    }
  });

  it('gives the orchestrator session the in-process puck MCP server', async () => {
    const { calls, sdk } = await drive(script, { tools: 'orchestrator' });
    expect(sdk.createSdkMcpServer).toHaveBeenCalledWith({
      name: 'puck',
      version: '0.0.1+abc',
      tools: [{ name: 'backlog_list' }],
      alwaysLoad: true,
    });
    expect(Object.keys(calls[0].options.mcpServers as object)).toEqual(['puck']);
  });

  it('reports an early end with the result text', async () => {
    const { events } = await drive([
      { type: 'result', subtype: 'error_max_turns', result: 'stopped after 7 turns', usage: {} },
    ]);
    expect(events[0]).toEqual({ kind: 'error', message: 'Claude Code turn ended early: error_max_turns - stopped after 7 turns' });
  });

  it('never lets compileSettings disable the orchestrator tools', () => {
    const everythingOff = Object.fromEntries(
      claudeHarness.configOptions.filter((o) => o.id.startsWith('tool.')).map((o) => [o.id, false]),
    );
    const compiled = claudeHarness.compileSettings(everythingOff) as { disallowedTools?: string[] };
    expect(compiled.disallowedTools?.length).toBeGreaterThan(0);
    expect(compiled.disallowedTools?.some((t) => t.startsWith('mcp__puck__'))).toBe(false);
  });
});

describe('launching the Claude CLI as the puck user', () => {
  it('spawns with uid/gid 10001, the SDK-provided argv, cwd and env, minus PUCK_* keys', () => {
    const spawnFn = vi.fn(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        exitCode: null,
        kill: () => true,
      });
      return child as never;
    });
    const log = { ...nullLogger, warn: vi.fn() };
    const spawn = claudeSpawner(log, { spawnFn });
    const signal = new AbortController().signal;
    const child = spawn({
      command: '/opt/puck/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude',
      args: ['--output-format', 'stream-json'],
      cwd: '/workspace',
      env: { HOME: '/puck/home', PUCK_SECRET: 'x', UNSET: undefined },
      signal,
    });
    expect(spawnFn).toHaveBeenCalledWith(
      '/opt/puck/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude',
      ['--output-format', 'stream-json'],
      { cwd: '/workspace', env: { HOME: '/puck/home' }, signal, uid: 10001, gid: 10001, stdio: 'pipe' },
    );
    (child as unknown as { stderr: PassThrough }).stderr.write('warning: slow disk\npartial');
    expect(log.warn).toHaveBeenCalledWith('claude.stderr', { line: 'warning: slow disk' });
  });

  it('builds the harness environment from an allowlist', () => {
    const env = harnessEnv({
      home: '/puck/home',
      definitionEnv: { NODE_ENV: 'development', PUCK_DEBUG: '1' },
      secrets: { NPM_TOKEN: 'secret' },
    });
    expect(env).toEqual({
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: '/puck/home',
      USER: 'puck',
      LANG: 'C.UTF-8',
      NODE_ENV: 'development',
      NPM_TOKEN: 'secret',
    });
  });
});
