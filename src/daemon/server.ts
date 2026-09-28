/**
 * The daemon's control socket (/run/puck/puckd.sock, root 0600). Access to
 * `docker exec` into the container is the authentication; there are no
 * tokens on this channel, and agents (the puck user) cannot open it.
 *
 * Per connection: the client must send `hello` within a few seconds; an
 * unsupported protocol gets `protocol-mismatch` and the connection closes.
 * `welcome` says whether the client's cursor is still inside the event
 * log (then every missed event follows, then live ones) or it must resync
 * from `snapshot.get`. Commands are answered by id, in any order. Several
 * connections may be attached; every one gets every event.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import {
  WIRE_LIMITS,
  isOp,
  protocolSupported,
  type ClientFrame,
  type DaemonFrame,
  type ErrorCode,
  PROTOCOL_VERSION,
} from '../harness/daemon-protocol';
import type { EventLog, LoggedEvent } from './eventlog';
import type { Logger } from './log';
import { OpError } from './ops';

/** A client this far behind on reading is dropped (it reconnects and replays). */
const MAX_BACKLOG_BYTES = 64 * 1024 * 1024;

export interface ServerDeps {
  socketPath: string;
  log: Logger;
  events: EventLog;
  identity(): { envId: string; version: string; build: string };
  dispatch(op: string, args: unknown): Promise<unknown>;
}

export class DaemonServer {
  private server: net.Server | null = null;
  private readonly clients = new Set<net.Socket>();
  private accepting = true;

  constructor(private readonly deps: ServerDeps) {}

  async listen(): Promise<void> {
    const { socketPath } = this.deps;
    // A socket file left by a previous daemon (the lock proves it is gone).
    fs.rmSync(socketPath, { force: true });
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Created 0600 from the start: no window where another user could connect.
      const oldMask = process.umask(0o177);
      server.listen(socketPath, () => {
        process.umask(oldMask);
        server.off('error', reject);
        resolve();
      });
    });
    fs.chmodSync(socketPath, 0o600);
  }

  /** Refuse new commands (shutdown, upgrade); attached clients still get events. */
  stopAccepting(): void {
    this.accepting = false;
  }

  async close(): Promise<void> {
    for (const socket of this.clients) socket.end();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private accept(socket: net.Socket): void {
    const { log, events } = this.deps;
    this.clients.add(socket);
    let buffer = '';
    let welcomed = false;
    let unsubscribe: (() => void) | null = null;

    const send = (frame: DaemonFrame): void => {
      if (socket.destroyed) return;
      if (socket.writableLength > MAX_BACKLOG_BYTES) {
        log.warn('client.dropped', { reason: 'backlog' });
        socket.destroy();
        return;
      }
      socket.write(JSON.stringify(frame) + '\n');
    };
    const fatal = (code: 'protocol-mismatch' | 'bad-frame', message: string): void => {
      send({ t: 'error', code, message });
      socket.end();
    };
    const helloTimer = setTimeout(() => fatal('bad-frame', 'Expected hello.'), WIRE_LIMITS.helloTimeoutMs);

    const onFrame = (frame: ClientFrame): void => {
      if (!welcomed) {
        if (frame.t !== 'hello') return fatal('bad-frame', 'Expected hello.');
        clearTimeout(helloTimer);
        if (!protocolSupported(frame.protocol)) {
          return fatal(
            'protocol-mismatch',
            `This daemon speaks protocol ${PROTOCOL_VERSION} (and ${PROTOCOL_VERSION - 1}); the client sent ${String(frame.protocol)}.`,
          );
        }
        const since = typeof frame.since === 'number' && Number.isInteger(frame.since) && frame.since >= 0 ? frame.since : null;
        // Replay list, welcome and subscription happen in one tick, so no
        // event can fall between the replay and the live stream.
        const replay = events.since(since);
        const id = this.deps.identity();
        welcomed = true;
        send({
          t: 'welcome',
          protocol: frame.protocol,
          daemon: { version: id.version, build: id.build },
          envId: id.envId,
          head: events.head(),
          replay: replay ? 'events' : 'resync',
        });
        for (const e of replay ?? []) send({ t: 'event', seq: e.seq, at: e.at, ev: e.ev });
        unsubscribe = events.subscribe((e: LoggedEvent) => send({ t: 'event', seq: e.seq, at: e.at, ev: e.ev }));
        log.info('client.attached', { protocol: frame.protocol, replay: replay ? replay.length : 'resync' });
        return;
      }
      if (frame.t === 'ping') {
        send({ t: 'pong', at: Date.now() });
        return;
      }
      if (frame.t !== 'cmd') return fatal('bad-frame', 'Unknown frame.');
      const cmdId = typeof frame.id === 'string' && frame.id.length <= 100 ? frame.id : null;
      if (!cmdId) return fatal('bad-frame', 'A command needs an id.');
      const fail = (code: ErrorCode, message: string): void => send({ t: 'res', id: cmdId, ok: false, error: { code, message } });
      if (!isOp(frame.op)) return fail('invalid-args', `Unknown op ${String(frame.op).slice(0, 40)}.`);
      if (!this.accepting) return fail('not-ready', 'The daemon is shutting down.');
      this.deps
        .dispatch(frame.op, frame.args)
        .then((result) => send({ t: 'res', id: cmdId, ok: true, result: result ?? {} }))
        .catch((err: unknown) => {
          if (err instanceof OpError) fail(err.code, err.message);
          else {
            log.error('command.failed', err, { op: frame.op });
            fail('internal', err instanceof Error ? err.message : String(err));
          }
        });
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let frame: ClientFrame;
        try {
          frame = JSON.parse(line) as ClientFrame;
        } catch {
          return fatal('bad-frame', 'A frame is not JSON.');
        }
        if (!frame || typeof frame !== 'object') return fatal('bad-frame', 'A frame is not an object.');
        onFrame(frame);
      }
      if (Buffer.byteLength(buffer, 'utf8') > WIRE_LIMITS.maxFrameBytes) fatal('bad-frame', 'A frame is larger than 1 MiB.');
    });
    const cleanup = (): void => {
      clearTimeout(helloTimer);
      unsubscribe?.();
      this.clients.delete(socket);
    };
    socket.on('close', cleanup);
    socket.on('error', () => socket.destroy());
  }
}
