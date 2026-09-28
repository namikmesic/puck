/**
 * The puck-server entry point: configuration from the environment, the
 * SQLite store, the server, and a graceful stop on SIGTERM/SIGINT.
 * `node puck-server.js health` probes a running server's /healthz on the
 * configured port and exits 0 only when it answers ok (the image's
 * HEALTHCHECK; slim images have no curl).
 */

import { ConfigError, loadConfig } from './config';
import { createServerLog } from './log';
import { createPuckServer } from './server';
import { SqliteStore } from './store';

async function health(): Promise<number> {
  const port = Number(process.env.PUCK_SERVER_PORT ?? '8080');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3_000) });
    const body = (await res.json()) as { ok?: unknown };
    return res.ok && body.ok === true ? 0 : 1;
  } catch {
    return 1;
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'health') process.exit(await health());
  const log = createServerLog();
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error('configuration error', { problem: err.message });
      process.exit(78);
    }
    throw err;
  }
  const store = new SqliteStore(config.dbPath);
  const server = createPuckServer({ config, store, log });
  await server.listen();
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('stopping', { signal });
    void server
      .close()
      .then(() => store.close())
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

void main();
