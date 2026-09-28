import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Snapshot } from '../../src/harness/daemon-protocol';
import { copyIn, exec, must, startEnv, turnEvents, waitReady, type Env } from './helpers';

// Opt-in (PUCK_DOCKER_REAL_CLAUDE=1): the real Claude Code CLI and Agent
// SDK, installed at their pinned versions by provisioning, drive one
// orchestrator turn against a stand-in for the Messages API inside the
// container (no account, no network beyond the npm registry). The stand-in
// asks the model's way for two tools: Bash `id -u`, which the CLI runs as a
// child of itself, and `mcp__puck__environment_info`, which the SDK routes
// to the daemon's in-process tool server. That pins down the privilege
// split: the CLI (and every agent tool call) runs as puck, uid 10001, while
// the orchestrator's tools execute inside the root daemon.

const enabled = process.env.PUCK_DOCKER_REAL_CLAUDE === '1';

/** Minimal Messages API: streams tool calls in a fixed order, then a closing text. */
const FAKE_ANTHROPIC = `
const http = require('http');
const fs = require('fs');
const log = (entry) => fs.appendFileSync('/srv/anthropic.log', JSON.stringify(entry) + '\\n');
function reply(res, body, content, stop) {
  const model = body.model || 'claude-test';
  const usage = { input_tokens: 10, output_tokens: 5 };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (type, data) => res.write('event: ' + type + '\\ndata: ' + JSON.stringify(Object.assign({ type }, data)) + '\\n\\n');
  send('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  send('message_stop', {});
  res.end();
}
http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    if (req.method !== 'POST' || !url.pathname.startsWith('/v1/messages')) {
      log({ other: req.method + ' ' + req.url });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname.endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    const tools = (body.tools || []).map((t) => t.name);
    const results = new Set();
    for (const m of body.messages || []) for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'tool_result') results.add(b.tool_use_id);
    log({ tools, results: [...results] });
    if (!tools.includes('mcp__puck__environment_info')) return reply(res, body, [{ type: 'text', text: 'ok' }], 'end_turn');
    if (!results.has('toolu_bash')) return reply(res, body, [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'id -u', description: 'Print the user id' } }], 'tool_use');
    if (!results.has('toolu_puck')) return reply(res, body, [{ type: 'tool_use', id: 'toolu_puck', name: 'mcp__puck__environment_info', input: {} }], 'tool_use');
    reply(res, body, [{ type: 'text', text: 'Both checks done.' }], 'end_turn');
  });
}).listen(8788, '127.0.0.1');
`;

let env: Env;
let client: Awaited<ReturnType<typeof waitReady>>;

describe.skipIf(!enabled)('real Claude CLI: tools in the root daemon, the CLI as puck', () => {
  beforeAll(async () => {
    env = await startEnv(
      {},
      {
        installPackages: true,
        env: { PUCK_TEST_REAL_CLAUDE: '1' },
        definition: {
          name: 'example',
          repos: [{ github: 'octo/app', dir: 'app', branch: 'main' }],
          orchestrator: { agent: 'lead', autoWake: false },
          agents: [{ agent: 'implementer', maxParallel: 1 }],
          agentDefinitions: {
            lead: { harness: 'claude-code', instructions: 'Lead.' },
            implementer: { harness: 'claude-code', instructions: 'Implement.' },
          },
          env: {
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788',
            ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key',
            DISABLE_TELEMETRY: '1',
            DISABLE_AUTOUPDATER: '1',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
        },
      },
    );
    await copyIn(env.container, FAKE_ANTHROPIC, '/srv/fake-anthropic.js');
    await must(['exec', '-d', env.container, 'node', '/srv/fake-anthropic.js']);
    client = await waitReady(env.container, 15 * 60_000);
  }, 16 * 60_000);
  afterAll(async () => {
    client?.close();
    await env?.remove();
  });

  it('runs Bash as uid 10001 and the puck tool handler as uid 0 in the daemon', async () => {
    const snap = await client.cmd<Snapshot>('snapshot.get');
    const sent = await client.cmd<{ turnId: string }>('chat.send', { sessionId: snap.orchestratorSessionId, text: 'Check the environment.' });
    await client.untilEvent('turn.end', (ev) => ev.turnId === sent.turnId, 180_000);
    const events = turnEvents(client.events(), sent.turnId);
    const errors = events.filter((e) => e.kind === 'error');
    expect(errors).toEqual([]);
    const starts = events.filter((e): e is Extract<typeof e, { kind: 'tool-start' }> => e.kind === 'tool-start');
    const ends = events.filter((e): e is Extract<typeof e, { kind: 'tool-end' }> => e.kind === 'tool-end');
    expect(starts.map((e) => e.tool)).toEqual(['Bash', 'mcp__puck__environment_info']);
    const bash = ends.find((e) => e.toolId === starts[0].toolId);
    expect(bash?.output.trim()).toBe('10001');
    const puck = ends.find((e) => e.toolId === starts[1].toolId);
    expect(puck?.ok).toBe(true);
    expect(JSON.parse(puck?.output ?? '{}')).toMatchObject({ name: 'Example', repos: [{ dir: 'app', github: 'octo/app' }] });
    const text = events.flatMap((e) => (e.kind === 'text-delta' ? [e.text] : [])).join('');
    expect(text).toContain('Both checks done.');

    // The handler ran in the daemon process, as root.
    const logs = await client.cmd<{ text: string }>('logs.tail', { lines: 500 });
    expect(logs.text).toContain('tool.call {"tool":"environment_info","ok":true,"uid":0}');
    // The CLI saw the puck tools up front (alwaysLoad), not behind tool search.
    const seen = await exec(env.container, ['cat', '/srv/anthropic.log']);
    expect(seen.stdout).toContain('mcp__puck__backlog_create');
  }, 240_000);
});
