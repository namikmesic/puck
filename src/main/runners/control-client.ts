/**
 * The app's side of the runner control protocol (src/harness/runner-protocol.ts)
 * over one control channel: wait for `welcome`, check the protocol version,
 * then typed commands matched to results by id. Long operations stream
 * `instance.stage` events to the command that asked for them.
 */

import {
  RUNNER_LIMITS,
  RUNNER_PROTOCOL_VERSION,
  type ControlArgs,
  type ControlEvent,
  type ControlOp,
  type ControlResult,
  type ControlRunnerFrame,
  type RunnerErrorCode,
} from '../../harness/runner-protocol';
import { lines, type ByteChannel } from './channel';

const WELCOME_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;
/** Pulling or building an image can take a long time. */
export const LONG_TIMEOUT_MS = 30 * 60_000;

export class RunnerCommandError extends Error {
  constructor(
    readonly code: RunnerErrorCode | 'closed' | 'timeout' | 'protocol',
    message: string,
  ) {
    super(message);
    this.name = 'RunnerCommandError';
  }
}

interface Waiting {
  resolve(result: unknown): void;
  reject(err: Error): void;
  onEvent?(ev: ControlEvent): void;
  timer: ReturnType<typeof setTimeout>;
}

export class ControlClient {
  private n = 0;
  private readonly waiting = new Map<string, Waiting>();
  private readonly out: { send(frame: unknown): boolean };
  readonly welcome: Promise<{ runnerId: string; version: string }>;
  private onWelcome!: (w: { runnerId: string; version: string }) => void;
  private onWelcomeFail!: (err: Error) => void;

  constructor(private readonly channel: ByteChannel) {
    this.welcome = new Promise((resolve, reject) => {
      this.onWelcome = resolve;
      this.onWelcomeFail = reject;
    });
    this.welcome.catch(() => undefined);
    const timer = setTimeout(() => {
      this.onWelcomeFail(new RunnerCommandError('timeout', 'The runner did not greet the app.'));
      channel.close('no-welcome');
    }, WELCOME_TIMEOUT_MS);
    this.out = lines(channel, RUNNER_LIMITS.maxFrameBytes, (line) => {
      let frame: ControlRunnerFrame;
      try {
        frame = JSON.parse(line) as ControlRunnerFrame;
      } catch {
        return;
      }
      this.onFrame(frame, () => clearTimeout(timer));
    });
    channel.onClose((reason) => {
      clearTimeout(timer);
      this.onWelcomeFail(new RunnerCommandError('closed', `The runner closed the channel (${reason}).`));
      for (const [id, w] of [...this.waiting]) {
        this.waiting.delete(id);
        clearTimeout(w.timer);
        w.reject(new RunnerCommandError('closed', `The connection to the runner closed (${reason}).`));
      }
    });
  }

  private onFrame(frame: ControlRunnerFrame, welcomed: () => void): void {
    switch (frame.t) {
      case 'welcome':
        welcomed();
        if (frame.protocol !== RUNNER_PROTOCOL_VERSION) {
          this.onWelcomeFail(new RunnerCommandError('protocol', `The runner speaks control protocol ${frame.protocol}; this Puck speaks ${RUNNER_PROTOCOL_VERSION}. Update the runner or Puck.`));
          this.channel.close('protocol-mismatch');
          return;
        }
        this.onWelcome({ runnerId: frame.runnerId, version: frame.version });
        return;
      case 'res': {
        const w = this.waiting.get(frame.id);
        if (!w) return;
        this.waiting.delete(frame.id);
        clearTimeout(w.timer);
        if (frame.ok) w.resolve(frame.result);
        else w.reject(new RunnerCommandError(frame.error.code, frame.error.message));
        return;
      }
      case 'event':
        for (const w of this.waiting.values()) w.onEvent?.(frame.ev);
        return;
      case 'error':
        for (const [id, w] of [...this.waiting]) {
          this.waiting.delete(id);
          clearTimeout(w.timer);
          w.reject(new RunnerCommandError('protocol', frame.message));
        }
        return;
    }
  }

  /** Sends one command; `onEvent` sees the events streamed while it runs. */
  async cmd<O extends ControlOp>(
    op: O,
    args: ControlArgs<O>,
    opts: { timeoutMs?: number; onEvent?: (ev: ControlEvent) => void } = {},
  ): Promise<ControlResult<O>> {
    await this.welcome;
    const id = `c${++this.n}`;
    return new Promise<ControlResult<O>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new RunnerCommandError('timeout', `The runner did not answer ${op} in time.`));
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.waiting.set(id, { resolve: resolve as (r: unknown) => void, reject, onEvent: opts.onEvent, timer });
      this.out.send({ t: 'cmd', id, op, args });
    });
  }

  close(): void {
    this.channel.close('app-closed');
  }

  get closed(): boolean {
    return this.channel.closedReason !== null;
  }
}
