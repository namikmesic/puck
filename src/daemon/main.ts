/**
 * puckd: the Puck environment daemon, bundled to one file and run inside
 * every environment container as `node /opt/puck/puckd.js <command>`.
 *
 *   serve    (default) run the daemon: the container's main process, as root
 *   attach   pipe stdio to the running daemon's socket (the app's channel)
 *   version  print { daemonVersion, protocolVersion, build } as JSON
 */

import * as fs from 'node:fs';
import { attach } from './attach';
import { Daemon } from './daemon';
import { acquireLock, releaseLock } from './lock';
import { createLogger } from './log';
import { daemonPaths } from './paths';
import { daemonIdentity } from './version';

function bundleFile(): string {
  return typeof __filename === 'string' && __filename ? __filename : process.argv[1];
}

async function serve(): Promise<void> {
  const paths = daemonPaths();
  const log = createLogger({ dir: paths.logs, mirror: true });
  const identity = daemonIdentity(bundleFile());
  fs.mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  if (!acquireLock(paths.lock)) {
    log.error('daemon.locked', undefined, { lock: paths.lock });
    process.exit(1);
  }
  const exit = (code: number): void => {
    releaseLock(paths.lock);
    process.exit(code);
  };
  const daemon = new Daemon({
    paths,
    log,
    identity,
    env: process.env,
    privileged: process.getuid?.() === 0,
    exit,
  });
  process.on('SIGTERM', () => void daemon.shutdown());
  process.on('SIGINT', () => void daemon.shutdown());
  // One bad promise must not take the environment down; log it and go on.
  process.on('unhandledRejection', (err) => log.error('daemon.unhandled', err));
  log.info('daemon.start', { version: identity.daemonVersion, pid: process.pid });
  await daemon.start();
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  switch (command) {
    case 'serve':
      await serve();
      return;
    case 'attach':
      process.exitCode = await attach(daemonPaths().socket);
      return;
    case 'version':
      process.stdout.write(JSON.stringify(daemonIdentity(bundleFile())) + '\n');
      return;
    default:
      process.stderr.write(`Usage: puckd [serve|attach|version]\n`);
      process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`puckd: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
