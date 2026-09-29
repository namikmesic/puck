/**
 * The local socket: how the app on the same machine reaches this runner
 * without the Puck server (the This Mac runner the app installs). Enabled
 * by `config.sh --local-socket <path>`, which records the path in `.runner`.
 *
 * The socket file is 0600 in a 0700 directory, so only this user can
 * connect, and that is the authentication: nothing is encrypted or relayed.
 * Each connection is one channel. The app sends one `LocalOpen` line; the
 * runner answers `accept` (then the connection carries control NDJSON or
 * the raw attach pipe, exactly as a relay channel would) or `close` with a
 * reason. Attach needs a running container, as over the relay.
 *
 * A stale socket file from an earlier process is replaced only when nothing
 * answers on it; the directory lock already keeps one runner per directory.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { ENV_ID_RE, LOCAL_OPEN_MAX_BYTES, type LocalAnswer } from '../harness/runner-protocol';
import type { Control } from './control';
import type { DockerSpawner } from './docker/client';
import { attachEndpoint, controlEndpoint, type Endpoint } from './endpoints';
import type { Logger } from './log';

/** Unix socket paths are limited to 104 bytes on macOS (108 on Linux). */
export const MAX_SOCKET_PATH_BYTES = 103;
const OPEN_TIMEOUT_MS = 5_000;

export interface LocalDeps {
  path: string;
  runnerId: string;
  version: string;
  control: Control;
  spawner: DockerSpawner;
  instanceState(envId: string): Promise<string | null>;
  log: Logger;
}

export function checkSocketPath(p: string): string | null {
  if (!path.isAbsolute(p)) return 'The local socket path must be absolute.';
  if (path.resolve(p) !== p) {
    return `The local socket path must be normalized (no ".", "..", or repeated slashes): ${p}`;
  }
  if (Buffer.byteLength(p, 'utf8') > MAX_SOCKET_PATH_BYTES) {
    return `The local socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes, which unix sockets do not allow: ${p}`;
  }
  return null;
}

function inUse(p: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(p);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

function prepareSocketDir(dir: string): void {
  if (fs.existsSync(dir)) {
    if ((fs.statSync(dir).mode & 0o077) !== 0) {
      throw new Error(
        `Refusing to listen: ${dir} is group- or world-accessible. Puck will not change its permissions. Put the local socket in a private directory (mode 0700).`,
      );
    }
    return;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export class LocalListener {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly deps: LocalDeps) {}

  async start(): Promise<void> {
    const problem = checkSocketPath(this.deps.path);
    if (problem) throw new Error(problem);
    prepareSocketDir(path.dirname(this.deps.path));
    if (fs.existsSync(this.deps.path)) {
      if (await inUse(this.deps.path)) throw new Error(`Another process is listening on ${this.deps.path}.`);
      fs.rmSync(this.deps.path, { force: true });
    }
    const server = net.createServer((sock) => this.accept(sock));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // The umask keeps the socket private from the moment it exists; chmod makes it explicit.
      const old = process.umask(0o177);
      try {
        server.listen(this.deps.path, () => {
          server.off('error', reject);
          resolve();
        });
      } finally {
        process.umask(old);
      }
    });
    fs.chmodSync(this.deps.path, 0o600);
    server.on('error', (err) => this.deps.log.warn('local.error', { error: err.message.slice(0, 200) }));
    this.server = server;
    this.deps.log.info('local.listening');
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => {
        fs.rmSync(this.deps.path, { force: true });
        resolve();
      });
    });
  }

  private accept(sock: net.Socket): void {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => undefined);
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => sock.destroy(), OPEN_TIMEOUT_MS);
    const answer = (a: LocalAnswer): void => void sock.write(JSON.stringify(a) + '\n');
    const refuse = (reason: string): void => {
      answer({ t: 'close', reason });
      sock.end();
    };
    const onHead = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(0x0a);
      if (nl < 0) {
        if (head.length > LOCAL_OPEN_MAX_BYTES) {
          clearTimeout(timer);
          sock.off('data', onHead);
          refuse('bad-open');
        }
        return;
      }
      clearTimeout(timer);
      sock.off('data', onHead);
      sock.pause();
      const rest = head.subarray(nl + 1);
      let open: Record<string, unknown>;
      try {
        open = JSON.parse(head.subarray(0, nl).toString('utf8')) as Record<string, unknown>;
      } catch {
        return refuse('bad-open');
      }
      void this.open(sock, open, rest, answer, refuse);
    };
    sock.on('data', onHead);
  }

  private async open(
    sock: net.Socket,
    open: Record<string, unknown>,
    rest: Buffer,
    answer: (a: LocalAnswer) => void,
    refuse: (reason: string) => void,
  ): Promise<void> {
    if (open.t !== 'open' || (open.kind !== 'control' && open.kind !== 'attach')) return refuse('bad-open');
    const kind = open.kind;
    let envId: string | null = null;
    if (kind === 'attach') {
      if (typeof open.envId !== 'string' || !ENV_ID_RE.test(open.envId)) return refuse('bad-open');
      envId = open.envId;
      let state: string | null;
      try {
        state = await this.deps.instanceState(envId);
      } catch {
        return refuse('docker-unavailable');
      }
      if (sock.destroyed) return;
      if (state === null) return refuse('not-found');
      if (state !== 'running') return refuse('not-running');
    }
    answer({ t: 'accept' });
    let ended = false;
    const sink = {
      write: (data: Buffer) => sock.write(data),
      close: (reason: string) => {
        if (ended) return;
        ended = true;
        endpoint.end(reason);
        sock.end();
      },
    };
    const endpoint: Endpoint =
      kind === 'control'
        ? controlEndpoint({ control: this.deps.control, runnerId: this.deps.runnerId, version: this.deps.version, sink, log: this.deps.log })
        : attachEndpoint({ envId: envId as string, spawner: this.deps.spawner, sink, log: this.deps.log });
    this.deps.log.info('channel.open', { kind, envId, via: 'local' });
    sock.on('drain', () => endpoint.resume());
    sock.on('close', () => {
      if (ended) return;
      ended = true;
      endpoint.end('app-closed');
    });
    let inFlight = 0;
    const feed = (chunk: Buffer): void => {
      inFlight++;
      sock.pause();
      endpoint.data(chunk, () => {
        if (--inFlight === 0 && !sock.destroyed) sock.resume();
      });
    };
    if (rest.length) feed(Buffer.from(rest));
    sock.on('data', feed);
    if (inFlight === 0) sock.resume();
  }
}
