/**
 * PUCK_FAKE_ADAPTER: a scripted harness for the Docker suite, compiled
 * into test bundles only (never into the shipped daemon). It reports a
 * stable resume id, runs the directive lines of the prompt in order, and
 * echoes the prompt's last line unless that line is a directive:
 *
 *   !exec <command>        run `sh -c <command>` exactly the way the Claude
 *                          CLI is launched (as the puck user, allowlisted
 *                          env, the session's cwd) and return its output in
 *                          a tool card
 *   !ask                   ask one question and echo the answer
 *   !sleep <ms>            wait (interruptible)
 *   !tool <name> <json>    call an orchestrator tool in process (orchestrator
 *                          sessions only), the way the SDK's MCP server does
 *   !fail <message>        report a turn error
 *
 * With PUCK_TEST_REAL_CLAUDE=1 in the daemon's environment, claude-code
 * keeps its real adapter (the Docker suite's opt-in check of the real CLI
 * against a stand-in Messages API).
 */

import { claudeSpawner } from './spawn';
import { harnessDescriptors } from '../../harness/providers';
import type { Logger } from '../log';
import { invokeTool, type AdapterContext, type AdapterRequest, type HarnessAdapter, type OrchestratorTool } from './types';

export const FAKE_ADAPTER_MARKER = 'PUCK_FAKE_ADAPTER';

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

function execAsPuck(log: Logger, req: AdapterRequest, command: string): Promise<string> {
  const spawn = claudeSpawner(log);
  return new Promise((resolve) => {
    const child = spawn({ command: '/bin/sh', args: ['-c', command], cwd: req.cwd, env: req.env, signal: new AbortController().signal });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    // stderr is forwarded to the daemon log by the spawner; mirror it here too.
    (child as unknown as { stderr: NodeJS.ReadableStream }).stderr.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', (err) => resolve(`spawn error: ${err.message}`));
    child.on('exit', (code) => setTimeout(() => resolve(`${out}exit=${code}`), 20));
    child.stdin.end();
  });
}

const DIRECTIVE = /^!(exec|ask|sleep|tool|fail)\b/;

async function runFake(log: Logger, tools: () => OrchestratorTool[], req: AdapterRequest, ctx: AdapterContext): Promise<void> {
  const started = Date.now();
  ctx.reportSession(req.resumeId ?? `fake-${req.sessionId}`);
  ctx.emit({ kind: 'thinking', active: true });
  const prompt = req.prompt.trim();
  const lines = prompt.split('\n');
  const lastLine = lines[lines.length - 1] ?? '';
  let n = 0;
  for (const line of lines) {
    if (ctx.signal.aborted) break;
    if (!DIRECTIVE.test(line)) continue;
    const id = `${req.turnId}-${++n}`;
    if (line.startsWith('!exec ')) {
      const command = line.slice(6);
      ctx.emit({ kind: 'thinking', active: false });
      ctx.emit({ kind: 'tool-start', toolId: id, tool: 'Bash', summary: command, input: command });
      const output = await execAsPuck(log, req, command);
      ctx.emit({ kind: 'tool-end', toolId: id, ok: true, output });
    } else if (line === '!ask') {
      const answers = await ctx.askUser([
        { question: 'Continue?', header: 'Fake', multiSelect: false, options: [{ label: 'Yes', description: '' }] },
      ]);
      ctx.emit({ kind: 'thinking', active: false });
      ctx.emit({ kind: 'text-delta', text: `answer: ${answers ? JSON.stringify(answers) : 'dismissed'}` });
    } else if (line.startsWith('!sleep ')) {
      await delay(Number(line.slice(7)) || 0, ctx.signal);
      ctx.emit({ kind: 'thinking', active: false });
    } else if (line.startsWith('!tool ')) {
      const [, name, json] = /^!tool (\S+)\s*(.*)$/.exec(line) ?? [];
      const tool = req.tools === 'orchestrator' ? tools().find((t) => t.name === name) : undefined;
      ctx.emit({ kind: 'tool-start', toolId: id, tool: `mcp__puck__${name}`, summary: json ?? '', input: json ?? '' });
      let args: unknown = {};
      try {
        args = json ? JSON.parse(json) : {};
      } catch {
        args = null;
      }
      const result = !tool
        ? { content: [{ type: 'text' as const, text: `No such tool: ${name}` }], isError: true }
        : args === null
          ? { content: [{ type: 'text' as const, text: 'Arguments are not JSON.' }], isError: true }
          : await invokeTool(tool, args, (tool, ok) => log.info('tool.call', { tool, ok, uid: process.getuid?.() ?? null }));
      ctx.emit({ kind: 'tool-end', toolId: id, ok: result.isError !== true, output: result.content.map((c) => c.text).join('\n') });
    } else if (line.startsWith('!fail')) {
      ctx.emit({ kind: 'error', message: line.slice(5).trim() || 'fake failure' });
    }
  }
  ctx.emit({ kind: 'thinking', active: false });
  if (!DIRECTIVE.test(lastLine)) {
    const words = `Echo (${req.resumeId ? 'resumed' : 'fresh'}): ${lastLine}`.split(/(?<= )/);
    for (const word of words) {
      if (ctx.signal.aborted) break;
      ctx.emit({ kind: 'text-delta', text: word });
      await delay(5, ctx.signal);
    }
  }
  ctx.emit({
    kind: 'turn-end',
    stats: { inputTokens: prompt.length, outputTokens: 10, durationMs: Date.now() - started, costUsd: 0 },
  });
}

export const testAdapters = (
  log: Logger,
  tools: () => OrchestratorTool[] = () => [],
  real?: () => Record<string, HarnessAdapter>,
): Record<string, HarnessAdapter> => {
  const fakes: Record<string, HarnessAdapter> = Object.fromEntries(
    harnessDescriptors.map((d) => [d.id, { id: d.id, run: (req: AdapterRequest, ctx: AdapterContext) => runFake(log, tools, req, ctx) }]),
  );
  if (real && process.env.PUCK_TEST_REAL_CLAUDE === '1') fakes['claude-code'] = real()['claude-code'];
  return fakes;
};
