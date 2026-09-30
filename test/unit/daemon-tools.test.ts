import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { sdkTools } from '../../src/daemon/harness/claude';
import { JOURNAL_FAILING, JournalError } from '../../src/daemon/delivery/journal';
import { orchestratorTools, READ_TOOLS, type ToolDeps } from '../../src/daemon/tools';

// The orchestrator's tools go through the Agent SDK's own MCP server (the
// pinned SDK and zod, as in the container). A schema that server cannot
// convert makes it list no tools at all, silently: the CLI then connects to
// `puck` and shows the model nothing. List them through the real server.

type Handler = (request: unknown, extra: unknown) => Promise<unknown>;

function server() {
  const tools = orchestratorTools({} as ToolDeps);
  const srv = createSdkMcpServer({ name: 'puck', version: 'test', tools: sdkTools(tools, z) as never, alwaysLoad: true });
  const handlers = (srv.instance as unknown as { server: { _requestHandlers: Map<string, Handler> } }).server._requestHandlers;
  const extra = { signal: new AbortController().signal, sendNotification: async () => undefined, sendRequest: async () => undefined, requestId: 1 };
  return {
    tools,
    list: async () => (await defined(handlers.get('tools/list'))({ method: 'tools/list', params: {} }, extra)) as {
      tools: Array<{ name: string; inputSchema: { type: string; properties: Record<string, unknown> }; _meta?: Record<string, unknown> }>;
    },
    call: async (name: string, args: unknown) =>
      (await defined(handlers.get('tools/call'))({ method: 'tools/call', params: { name, arguments: args } }, extra)) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      },
  };
}

function defined<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}

describe('orchestrator tools through the SDK MCP server', () => {
  it('lists every tool with a JSON schema, always loaded', async () => {
    const s = server();
    const listed = await s.list();
    expect(listed.tools.map((t) => t.name)).toEqual(s.tools.map((t) => t.name));
    expect(listed.tools).toHaveLength(23);
    for (const tool of listed.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool._meta?.['anthropic/alwaysLoad']).toBe(true);
    }
    const answer = defined(listed.tools.find((t) => t.name === 'answer_worker'));
    expect(answer.inputSchema.properties.answers).toMatchObject({ type: 'object', additionalProperties: { type: 'string' } });
  });

  it('rejects bad arguments before a handler runs', async () => {
    const s = server();
    const out = await s.call('backlog_get', { item: 'item twelve' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/W-<number>/);
  });
});

describe('a failing delivery journal', () => {
  const MUTATING = [
    'backlog_create',
    'backlog_update',
    'backlog_move',
    'backlog_assign',
    'backlog_cancel',
    'work_retry',
    'work_accept',
    'work_request_changes',
    'work_publish',
    'ticket_link',
    'ticket_unlink',
    'answer_worker',
    'escalate_to_user',
    'issues_import',
    'ci_rerun',
  ];

  function fencedTools(failing: boolean) {
    const touched: string[] = [];
    // Every dependency a handler could reach records the reach and throws.
    const reach = new Proxy(
      {},
      {
        get: (_t, key) => {
          touched.push(String(key));
          throw new Error(`reached ${String(key)}`);
        },
      },
    );
    const tools = orchestratorTools({
      work: reach,
      backlog: reach,
      workflow: reach,
      definition: () => {
        touched.push('definition');
        throw new Error('reached definition');
      },
      instance: () => ({ name: 'Example', pin: null, sha: null }),
      running: () => ({}),
      github: reach,
      journalFailing: () => failing,
    } as unknown as ToolDeps);
    return { tools, touched };
  }

  it('classifies every tool: the read tools and the ones that change state, which are all the rest', () => {
    const { tools } = fencedTools(false);
    expect(tools.filter((t) => !READ_TOOLS.has(t.name)).map((t) => t.name)).toEqual(MUTATING);
    expect(tools.filter((t) => READ_TOOLS.has(t.name)).map((t) => t.name)).toEqual([...READ_TOOLS]);
  });

  it('refuses every tool that changes state before its handler reaches anything, with the socket’s error', () => {
    const { tools, touched } = fencedTools(true);
    for (const tool of tools.filter((t) => !READ_TOOLS.has(t.name))) {
      expect(() => tool.run({ item: 'W-1', title: 'T', agent: 'implementer', message: 'm', answers: {}, note: 'n', ref: 'octo/app#1' }), tool.name).toThrow(
        new JournalError('not-ready', JOURNAL_FAILING),
      );
    }
    expect(touched).toEqual([]);
  });

  it('keeps the read tools', async () => {
    const { tools, touched } = fencedTools(true);
    const info = defined(tools.find((t) => t.name === 'environment_info'));
    expect(() => info.run({})).not.toThrow(JournalError);
    // A read tool reaches its handler (here, a dependency that throws on purpose), never the journal fence.
    const list = defined(tools.find((t) => t.name === 'backlog_list'));
    expect(() => list.run({})).toThrow(/^reached /);
    expect(touched.length).toBeGreaterThan(0);
  });
});
