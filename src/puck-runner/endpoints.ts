/**
 * What a channel from the app ends in on the runner, whatever carries it
 * (the relay's encrypted channels, relay.ts, or This Mac's local socket,
 * local.ts):
 *
 * - control: NDJSON commands answered by control.ts, `welcome` first;
 * - attach: a byte pipe to `docker exec -i puck-<envId> node
 *   /opt/puck/puckd.js attach`. When the app side has no room, the exec's
 *   stdout is paused; input is acknowledged (`done`) only once the exec's
 *   stdin took it, so a slow container holds the app back instead of this
 *   process buffering without bound.
 *
 * The carrier supplies `Sink`: `write` (false = no room until `resume`)
 * and `close` (tell the peer, tear down the carrier).
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { RUNNER_LIMITS, type ControlEvent, type ControlRunnerFrame } from '../harness/runner-protocol';
import { welcomeFrame, type Control } from './control';
import { attachArgs } from './daemon-link';
import type { DockerSpawner } from './docker/client';
import type { Logger } from './log';

export interface Sink {
  /** False while the peer has no room; the endpoint waits for its `resume`. */
  write(data: Buffer): boolean;
  /** Ends the channel with `reason` (the carrier tells the peer). */
  close(reason: string): void;
}

export interface Endpoint {
  /** Bytes from the app; call `done` once they were consumed. */
  data(chunk: Buffer, done: () => void): void;
  /** The peer has room again after `write` returned false. */
  resume(): void;
  /** The carrier is gone: release everything, tell no one. */
  end(reason: string): void;
}

export function controlEndpoint(opts: { control: Control; runnerId: string; version: string; sink: Sink; log: Logger }): Endpoint {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let closed = false;
  const write = (frame: ControlRunnerFrame): void => {
    if (!closed) opts.sink.write(Buffer.from(JSON.stringify(frame) + '\n', 'utf8'));
  };
  const emit = (ev: ControlEvent): void => write({ t: 'event', ev });
  write(welcomeFrame(opts.runnerId, opts.version));
  const end = (reason: string): void => {
    if (closed) return;
    closed = true;
    opts.log.info('channel.closed', { kind: 'control', reason });
  };
  return {
    data(chunk, done) {
      buf += decoder.write(chunk);
      done();
      if (buf.length > RUNNER_LIMITS.maxFrameBytes * 2) {
        end('frame-too-large');
        opts.sink.close('frame-too-large');
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          write({ t: 'error', code: 'bad-frame', message: 'Each line must be one JSON frame.' });
          continue;
        }
        void opts.control.handle(parsed, emit).then(write);
      }
    },
    resume() {
      // Control answers are small; the carrier queues them.
    },
    end,
  };
}

export function attachEndpoint(opts: { envId: string; spawner: DockerSpawner; sink: Sink; log: Logger }): Endpoint {
  const child: ChildProcessWithoutNullStreams = opts.spawner(attachArgs(opts.envId));
  let closed = false;
  let bytesIn = 0;
  let bytesOut = 0;
  const end = (reason: string): void => {
    if (closed) return;
    closed = true;
    child.stdin.end();
    child.kill();
    opts.log.info('channel.closed', { kind: 'attach', envId: opts.envId, reason, bytesIn, bytesOut });
  };
  const close = (reason: string): void => {
    if (closed) return;
    end(reason);
    opts.sink.close(reason);
  };
  child.stdout.on('data', (chunk: Buffer) => {
    bytesOut += chunk.length;
    if (!opts.sink.write(chunk)) child.stdout.pause();
  });
  child.stderr.on('data', () => undefined);
  child.stdin.on('error', () => undefined);
  child.on('error', () => close('daemon-unavailable'));
  child.on('close', () => close('daemon-closed'));
  return {
    data(chunk, done) {
      if (closed) return done();
      bytesIn += chunk.length;
      if (child.stdin.write(chunk)) done();
      else child.stdin.once('drain', done);
    },
    resume() {
      if (!closed) child.stdout.resume();
    },
    end,
  };
}
