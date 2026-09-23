import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessEvent } from '../../src/harness/types';
import * as runner from '../../src/main/runner';
import type { TurnRequest } from '../../src/main/runner';

const END: HarnessEvent = { kind: 'turn-end', stats: { inputTokens: 0, outputTokens: 0, durationMs: 0 } };

/** Scripted stand-in for the docker-exec child process. */
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  /** One NDJSON line from the "runner". */
  reply(msg: unknown): void {
    this.stdout.write(`${JSON.stringify(msg)}\n`);
  }
  ready(rv = runner.WIRE.rv): void {
    this.reply({ ready: true, rv });
  }
  /** The terminal pair every turn ends with: a turn-end event, then done. */
  finish(id: string, extra: Record<string, unknown> = {}): void {
    this.reply({ id, event: END });
    this.reply({ id, done: true, ...extra });
  }
  private outbox = '';
  /** Every line the host has written to the runner's stdin so far. */
  sent(): Array<Record<string, unknown>> {
    let chunk: Buffer | null;
    while ((chunk = this.stdin.read() as Buffer | null) !== null) {
      this.outbox += chunk.toString();
    }
    return this.outbox
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

function req(id: string, extra: Partial<TurnRequest> = {}): TurnRequest {
  return {
    id,
    provider: 'claude-code',
    model: 'auto',
    systemPrompt: '',
    thinking: 'auto',
    settings: '{}',
    advanced: '',
    resume: null,
    prompt: 'hi',
    ...extra,
  };
}

let child: FakeChild;
let envSeq = 0;
let envId: string;

/** Collects a turn's events; runs the generator to completion. */
async function collect(
  request: TurnRequest,
  onSession: (id: string) => void = () => undefined,
): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  for await (const e of runner.turn(envId, request, onSession)) events.push(e);
  return events;
}

beforeEach(() => {
  vi.useFakeTimers();
  child = new FakeChild();
  envId = `env-${++envSeq}`; // fresh cached-proc slot per test
  runner.useExecSpawner(() => child as unknown as ChildProcessWithoutNullStreams);
});

afterEach(() => {
  runner.detach(envId);
  vi.useRealTimers();
});

describe('runner NDJSON bridge', () => {
  it('routes a full turn: request line out, events in, terminal turn-end', async () => {
    child.ready();
    const turn = collect(req('t1'));
    await vi.advanceTimersByTimeAsync(0);
    child.reply({ id: 't1', event: { kind: 'text-delta', text: 'hello' } });
    child.reply({ id: 't1', event: { kind: 'turn-end', stats: { inputTokens: 1, outputTokens: 2, durationMs: 3 } } });
    child.reply({ id: 't1', done: true, providerSessionId: null });
    const events = await turn;
    expect(events.map((e) => e.kind)).toEqual(['text-delta', 'turn-end']);
    const sent = child.sent();
    expect(sent[0].op).toBe(runner.WIRE.ops.turn);
    expect(sent[0].id).toBe('t1');
  });

  it('synthesizes turn-end when done arrives without one', async () => {
    child.ready();
    const turn = collect(req('t1'));
    await vi.advanceTimersByTimeAsync(0);
    child.reply({ id: 't1', event: { kind: 'error', message: 'sdk import failed' } });
    child.reply({ id: 't1', done: true, providerSessionId: null });
    const events = await turn;
    expect(events.map((e) => e.kind)).toEqual(['error', 'turn-end']);
  });

  it('fails the turn when the runner never reports ready', async () => {
    const turn = collect(req('t1'));
    await vi.advanceTimersByTimeAsync(15_000);
    const events = await turn;
    expect(events.map((e) => e.kind)).toEqual(['error', 'turn-end']);
    expect((events[0] as { message: string }).message).toMatch(/failed to start/i);
  });

  it('records the handshake rv and warns when settings target an old runner', async () => {
    child.ready(runner.WIRE.rv - 1); // pre-settings runner
    const turn = collect(req('t1', { settings: '{"maxTurns":5}' }));
    await vi.advanceTimersByTimeAsync(0);
    child.finish('t1');
    const events = await turn;
    expect(events[0].kind).toBe('error');
    expect((events[0] as { message: string }).message).toMatch(/older Puck runner/);
  });

  it('does not warn old runners about untouched agents (sparse settings)', async () => {
    child.ready(runner.WIRE.rv - 1);
    const turn = collect(req('t1', { settings: '{}' }));
    await vi.advanceTimersByTimeAsync(0);
    child.finish('t1');
    const events = await turn;
    expect(events.map((e) => e.kind)).toEqual(['turn-end']);
  });

  it('refuses a duplicate turn id instead of clobbering the route', async () => {
    child.ready();
    const first = collect(req('t1'));
    await vi.advanceTimersByTimeAsync(0);
    const second = await collect(req('t1'));
    expect(second.map((e) => e.kind)).toEqual(['error', 'turn-end']);
    expect((second[0] as { message: string }).message).toMatch(/duplicate/i);
    child.finish('t1');
    await first;
  });

  it('watchdog fails a turn the runner never answers', async () => {
    child.ready();
    const turn = collect(req('t1'));
    await vi.advanceTimersByTimeAsync(90_000);
    const events = await turn;
    expect(events.map((e) => e.kind)).toEqual(['error', 'turn-end']);
    expect((events[0] as { message: string }).message).toMatch(/did not respond/i);
  });

  it('fails in-flight turns when the exec dies, with stderr diagnostics', async () => {
    child.ready();
    const turn = collect(req('t1'));
    await vi.advanceTimersByTimeAsync(0);
    child.reply({ id: 't1', event: { kind: 'text-delta', text: 'partial' } });
    child.stderr.write('boom: container exploded\n');
    await vi.advanceTimersByTimeAsync(0);
    child.emit('close', 1);
    const events = await turn;
    expect(events.map((e) => e.kind)).toEqual(['text-delta', 'error', 'turn-end']);
    expect((events[1] as { message: string }).message).toMatch(/disconnected/i);
    expect((events[1] as { message: string }).message).toMatch(/container exploded/);
  });

  it('sends an interrupt when the consumer abandons a live turn', async () => {
    child.ready();
    const gen = runner.turn(envId, req('t1'), () => undefined);
    const first = gen.next();
    await vi.advanceTimersByTimeAsync(0);
    child.reply({ id: 't1', event: { kind: 'text-delta', text: 'partial' } });
    await first;
    await gen.return(undefined); // consumer walks away mid-turn
    await vi.advanceTimersByTimeAsync(0); // let the finally flush its interrupt
    const ops = child.sent().map((line) => line.op);
    expect(ops).toEqual([runner.WIRE.ops.turn, runner.WIRE.ops.interrupt]);
  });

  it('reports eager session ids and the final providerSessionId', async () => {
    child.ready();
    const seen: string[] = [];
    const turn = collect(req('t1'), (id) => seen.push(id));
    await vi.advanceTimersByTimeAsync(0);
    child.reply({ id: 't1', session: 'sess-early' });
    child.finish('t1', { providerSessionId: 'sess-final' });
    await turn;
    expect(seen).toEqual(['sess-early', 'sess-final']);
  });
});
