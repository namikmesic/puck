/**
 * Assembles the Puck server: the routes over node:http, and the two
 * WebSocket endpoints (the `ws` package, upgraded only after the bearer
 * token checks out). Everything with an effect is injected, so the tests run
 * the real server against a fake GitHub, an in-memory store and a fake clock.
 *
 *   GET  /healthz                                   liveness + which features are configured
 *   POST /v1/auth/github/start, GET /v1/auth/github/callback, POST /v1/auth/token, POST /v1/auth/logout
 *   GET  /v1/me, GET /v1/github/token, GET /v1/audit
 *   POST /v1/runners/registration-token | removal-token   (DELETE .../:id revokes)
 *   POST /v1/runners/register | token | remove
 *   GET  /v1/runners, GET|PATCH|DELETE /v1/runners/:id
 *   POST /v1/instances, GET /v1/instances[/:envId], PUT /v1/instances/:envId/grant, DELETE /v1/instances/:envId
 *   POST /v1/runners/instances/:envId/github-token        (runner token)
 *   GET  /v1/runner/releases, GET /runner/:version/:file
 *   WS   /v1/runners/connect (runner token), /v1/app/connect (session token)
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { DATA_HEADER_BYTES, MAX_CIPHERTEXT_BYTES } from '../channel/wire';
import pkg from '../../package.json';
import { registerAuthRoutes } from './auth';
import { systemClock, type Clock } from './clock';
import type { ServerConfig } from './config';
import { auditWriter, authenticate, sessionFor, type ServerContext } from './context';
import { registerDownloadRoutes, RunnerDownloads } from './downloads';
import { GitHubApp, pemSigner, type AppSigner, type GitHubAppDeps } from './github';
import { bearerFrom, createRequestHandler, HttpError, Router } from './http';
import { registerInstanceRoutes } from './instances';
import { createServerLog, type ServerLog } from './log';
import { Relay } from './relay';
import { authenticateRunner, registerRunnerRoutes } from './runners';
import type { Store } from './store';
import { UserTokenCustody } from './user-tokens';

export const SERVER_VERSION: string = pkg.version;
const STORE_SWEEP_MS = 10 * 60_000;

export interface ServerDeps {
  config: ServerConfig;
  store: Store;
  clock?: Clock;
  log?: ServerLog;
  /** GitHub transport (tests pass a fake GitHub). */
  githubDeps?: GitHubAppDeps;
  /** Signs App JWTs; defaults to the configured PEM key. */
  signer?: AppSigner;
}

export interface PuckServer {
  ctx: ServerContext;
  relay: Relay;
  http: http.Server;
  listen(): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

export function createPuckServer(deps: ServerDeps): PuckServer {
  const { config, store } = deps;
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? createServerLog();
  const gh = config.github;
  const github = gh ? new GitHubApp(gh, deps.signer ?? pemSigner(gh.appId, gh.privateKeyPem), deps.githubDeps) : null;
  const custody = github && config.tokenKey ? new UserTokenCustody(store, github, config.tokenKey, clock) : null;
  const relay = new Relay(clock);
  const ctx: ServerContext = { config, store, clock, log, github, custody, hub: relay, audit: auditWriter(store, clock) };
  relay.bind(ctx);

  const router = new Router();
  router.add('GET', '/healthz', async () => {
    await store.getUser('usr_health');
    return { body: { ok: true, version: SERVER_VERSION, github: !!github } };
  });
  router.add('GET', '/v1/audit', async (req) => {
    const { user } = await sessionFor(ctx, req);
    const limit = Math.min(Math.max(Number(req.query.get('limit') ?? 100) || 100, 1), 500);
    return { body: { events: await store.listAudit(user.id, limit) } };
  });
  registerAuthRoutes(router, ctx);
  registerRunnerRoutes(router, ctx);
  registerInstanceRoutes(router, ctx);
  registerDownloadRoutes(router, ctx, new RunnerDownloads(config.runnerDownloads, config.publicUrl));

  const server = http.createServer(createRequestHandler(router, log));
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: DATA_HEADER_BYTES + MAX_CIPHERTEXT_BYTES });

  const reject = (socket: Duplex, status: number, text: string): void => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://server.invalid').pathname;
    const token = bearerFrom(req.headers);
    socket.on('error', () => socket.destroy());
    void (async () => {
      try {
        if (path === '/v1/runners/connect') {
          const runner = await authenticateRunner(ctx, token);
          wss.handleUpgrade(req, socket, head, (ws) => relay.attachRunner(ws, runner));
        } else if (path === '/v1/app/connect') {
          const { session, user } = await authenticate(ctx, token);
          wss.handleUpgrade(req, socket, head, (ws) => relay.attachApp(ws, session.id, user.id, session.accessExpiresAt));
        } else {
          reject(socket, 404, 'Not Found');
        }
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) reject(socket, 401, 'Unauthorized');
        else {
          log.error('upgrade failed', { path, error: err instanceof Error ? err.name : 'unknown' });
          reject(socket, 500, 'Internal Server Error');
        }
      }
    })();
  });

  const stopSweep = clock.every(STORE_SWEEP_MS, () => {
    void store.sweep(clock.now()).catch(() => log.warn('store sweep failed'));
  });

  return {
    ctx,
    relay,
    http: server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          const { port } = server.address() as AddressInfo;
          log.info('listening', { host: config.host, port, publicUrl: config.publicUrl, github: !!github });
          resolve({ port, url: `http://${config.host}:${port}` });
        });
      }),
    close: async () => {
      stopSweep();
      relay.close();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      wss.close();
    },
  };
}
