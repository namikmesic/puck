/**
 * `puckd attach`: the stdio bridge into the daemon. The runner hosting the
 * environment runs `docker exec -i <container> node /opt/puck/puckd.js
 * attach` for each attach channel and for its token pushes; this process
 * pipes stdin to the control socket and the socket to stdout, and exits
 * when either side closes. With no daemon listening it prints one
 * `daemon-unavailable` error frame and exits 3.
 */

import * as net from 'node:net';
import type { Readable, Writable } from 'node:stream';
import { ATTACH_UNAVAILABLE_EXIT, type DaemonFrame } from '../harness/daemon-protocol';

export function attach(
  socketPath: string,
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
): Promise<number> {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const done = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const socket = net.connect(socketPath);
    socket.on('connect', () => {
      connected = true;
      stdin.pipe(socket);
      socket.pipe(stdout);
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (connected) return done(0);
      const frame: DaemonFrame = {
        t: 'error',
        code: 'daemon-unavailable',
        message: `The environment daemon is not running (${err.code ?? err.message}).`,
      };
      stdout.write(JSON.stringify(frame) + '\n', () => done(ATTACH_UNAVAILABLE_EXIT));
    });
    socket.on('close', () => {
      if (connected) done(0);
    });
    stdin.on('end', () => socket.end());
  });
}
