import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { sdkTools } from '../../src/daemon/harness/claude';
import { orchestratorTools, type ToolDeps } from '../../src/daemon/tools';

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
    expect(listed.tools).toHaveLength(16);
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
