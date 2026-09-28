/**
 * PUCK_FAKE_ADAPTER: a scripted harness for the Docker suite, compiled
 * into test bundles only (never into the shipped daemon). It streams an
 * echo of the prompt, reports a stable resume id, and understands a few
 * directives so the suite can exercise the real plumbing:
 *
 *   !exec <command>   run `sh -c <command>` exactly the way the Claude CLI
 *                     is launched (as the puck user, allowlisted env) and
 *                     return its output in a tool card
 *   !ask              ask one question and echo the answer
 *   !sleep <ms>       wait (interruptible)
 */

import { claudeSpawner } from './spawn';
import { harnessDescriptors } from '../../harness/providers';
import type { Logger } from '../log';
import type { AdapterContext, AdapterRequest, HarnessAdapter } from './types';

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

async function runFake(log: Logger, req: AdapterRequest, ctx: AdapterContext): Promise<void> {
  const started = Date.now();
  ctx.reportSession(req.resumeId ?? `fake-${req.sessionId}`);
  ctx.emit({ kind: 'thinking', active: true });
  const prompt = req.prompt.trim();
  const lastLine = prompt.split('\n').pop() ?? '';
  if (lastLine.startsWith('!exec ')) {
    const command = lastLine.slice(6);
    ctx.emit({ kind: 'thinking', active: false });
    ctx.emit({ kind: 'tool-start', toolId: `${req.turnId}-exec`, tool: 'Bash', summary: command, input: command });
    const output = await execAsPuck(log, req, command);
    ctx.emit({ kind: 'tool-end', toolId: `${req.turnId}-exec`, ok: true, output });
  } else if (lastLine === '!ask') {
    const answers = await ctx.askUser([
      { question: 'Continue?', header: 'Fake', multiSelect: false, options: [{ label: 'Yes', description: '' }] },
    ]);
    ctx.emit({ kind: 'thinking', active: false });
    ctx.emit({ kind: 'text-delta', text: `answer: ${answers ? JSON.stringify(answers) : 'dismissed'}` });
  } else if (lastLine.startsWith('!sleep ')) {
    await delay(Number(lastLine.slice(7)) || 0, ctx.signal);
    ctx.emit({ kind: 'thinking', active: false });
  } else {
    ctx.emit({ kind: 'thinking', active: false });
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

export const testAdapters = (log: Logger): Record<string, HarnessAdapter> =>
  Object.fromEntries(harnessDescriptors.map((d) => [d.id, { id: d.id, run: (req, ctx) => runFake(log, req, ctx) }]));
