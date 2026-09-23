/**
 * The live harness backend: forwards turns to the main process over the
 * preload bridge (which runs them via provider SDKs inside the environment's
 * Docker container) and adapts the turnId-tagged event callbacks back into
 * the `AsyncGenerator<HarnessEvent>` protocol.
 */

import type { PuckBridge } from './bridge';
import type { Harness, HarnessEvent } from './types';

/** Unbounded push queue with promise-based pulls. */
class AsyncQueue<T> {
  private items: T[] = [];
  private resolvers: Array<(value: T) => void> = [];

  push(value: T): void {
    const resolve = this.resolvers.shift();
    if (resolve) resolve(value);
    else this.items.push(value);
  }

  next(): Promise<T> {
    const value = this.items.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
}

export class IpcHarness implements Harness {
  private queues = new Map<string, AsyncQueue<HarnessEvent>>();
  private turnSeq = 0;

  constructor(private bridge: PuckBridge) {
    this.bridge.onEvent(({ turnId, event }) => {
      this.queues.get(turnId)?.push(event);
    });
  }

  /** Interrupt a specific in-flight turn. */
  interrupt(turnId: string): void {
    void this.bridge.interrupt(turnId);
  }

  /** Answer (or dismiss, with null) a mid-turn question from the agent. */
  answerAsk(turnId: string, askId: string, answers: Record<string, string> | null): Promise<void> {
    return this.bridge.answerAsk(turnId, askId, answers);
  }

  send(agentId: string, prompt: string): { turnId: string; events: AsyncGenerator<HarnessEvent> } {
    const turnId = `ipc-${++this.turnSeq}`;
    const queue = new AsyncQueue<HarnessEvent>();
    this.queues.set(turnId, queue);

    // If the IPC call itself dies, synthesize a terminal pair of events so the
    // consuming loop always ends.
    void this.bridge.startTurn(turnId, agentId, prompt).catch((err: Error) => {
      queue.push({ kind: 'error', message: err.message });
      queue.push({
        kind: 'turn-end',
        stats: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
      });
    });

    return { turnId, events: this.consume(turnId, queue) };
  }

  private async *consume(
    turnId: string,
    queue: AsyncQueue<HarnessEvent>,
  ): AsyncGenerator<HarnessEvent> {
    try {
      for (;;) {
        const event = await queue.next();
        yield event;
        if (event.kind === 'turn-end') return;
      }
    } finally {
      this.queues.delete(turnId);
    }
  }
}
