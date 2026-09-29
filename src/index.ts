/**
 * Main-process composition root: constructs the window, wires the services
 * together (runner transport, env-reset → resume-id invalidation, login →
 * credential push), and registers the IPC surface from one handler table.
 * Domain logic lives in src/main/*; this file only assembles it.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import * as agents from './main/agents';
import * as backend from './main/backend';
import * as configRepo from './main/config-repo';
import * as conversations from './main/conversations';
import * as providerRegistry from './main/providers';
import * as github from './main/providers/github';
import * as environments from './main/environments';
import * as instances from './main/instances';
import * as runners from './main/runners';
import * as serverApi from './main/server/api';
import { log } from './main/log';
import * as runner from './main/runner';
import * as sessionRegistry from './main/session-registry';
import { flushWrites } from './main/jsonstore';
import { flushRenderers, installQuitDrain } from './main/shutdown';
import * as support from './main/support';
import {
  agentConfigFrom,
  askAnswersFrom,
  daemonCallFrom,
  enrollTokenIdFrom,
  envConfigFrom,
  instanceIdFrom,
  objArgs,
  pinFrom,
  repoNameFrom,
  requireId,
  requireSecretKey,
  requireString,
  runnerIdFrom,
  runnerPatchFrom,
  startSpecFrom,
} from './main/ipcguard';
import {
  CHANNELS,
  DAEMON_EVENT_CHANNEL,
  ENV_EVENT_CHANNEL,
  EVENT_CHANNEL,
  INSTANCE_EVENT_CHANNEL,
  RUNNER_EVENT_CHANNEL,
} from './harness/channels';
import type { RunnerEvent } from './harness/bridge';
import { dockerLocation } from './main/docker-client';
import { applyIsolatedLaunch } from './main/isolation';

// Tests and live checks launch isolated (PUCK_ISOLATED=1): data paths and the
// keychain switch must be set before anything reads them. Imports run first,
// which is safe because every module resolves userData lazily, per call.
const isolated = applyIsolatedLaunch(app);
if (isolated) console.log(`Puck isolated launch: data in ${isolated.dataDir}, mock keychain`);

// A rejected fire-and-forget promise must never take the process down.
// Both faults land in the diagnostic log (userData/logs, see main/log.ts).
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection in main process', reason);
});
// Electron shows its error dialog only while it is the sole listener, so
// this listener logs the fault and then shows the same dialog itself.
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception in main process', err);
  dialog.showErrorBox(
    'A JavaScript error occurred in the main process',
    err instanceof Error ? err.stack ?? err.message : String(err),
  );
});

// Composition: the runner bridge speaks NDJSON over whatever exec transport
// it is handed; environments supplies the docker adapter and explains a
// runner death caused by its own lifecycle ops. A destroyed container
// invalidates its resume ids, a completed login pushes credentials into
// every running environment, a logout removes them again (the container
// side of the logout fence; its failure surfaces to the Disconnect button
// through the IPC rejection), and every lifecycle change streams to the UI.
runner.useExecSpawner(environments.runnerExecSpawner);
runner.useDisconnectExplainer(environments.explainDisconnect);
environments.onEnvReset(sessionRegistry.forgetEnvironment);
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
environments.onLifecycle((payload) => broadcast(ENV_EVENT_CHANNEL, payload));
// Environments on runners: runner-list, environment and daemon events stream
// to the renderer; a harness sign-in or sign-out reaches the attached
// environment over its daemon connection (the others on their next attach).
runners.onRunnersChange((e) => {
  const event: RunnerEvent = e.kind === 'state' ? { kind: 'state', state: runners.state() } : e;
  broadcast(RUNNER_EVENT_CHANNEL, event);
});
instances.onInstanceEvent((e) => broadcast(INSTANCE_EVENT_CHANNEL, e));
instances.onDaemonEvent((e) => broadcast(DAEMON_EVENT_CHANNEL, e));
providerRegistry.setOnLogin(() => {
  environments.injectCredentialsIntoRunning().catch((err) => {
    log.error('Credential push into running environments failed', err);
  });
  instances.onHarnessLogin().catch((err) => log.error('Credential push into the attached environment failed', err));
});
providerRegistry.setOnLogout(async (provider) => {
  await instances.onHarnessLogout(provider.id);
  await environments.purgeCredentials(provider);
});

// Injected by Forge's webpack plugin: dev-server vs packaged bundle URLs.
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_V2_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_V2_PRELOAD_WEBPACK_ENTRY: string;

/** PUCK_UI=v2 loads the runner shell. The legacy window stays the default until cutover. */
function windowAssets(): { url: string; preload: string } {
  if (process.env.PUCK_UI === 'v2') return { url: MAIN_WINDOW_V2_WEBPACK_ENTRY, preload: MAIN_WINDOW_V2_PRELOAD_WEBPACK_ENTRY };
  return { url: MAIN_WINDOW_WEBPACK_ENTRY, preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY };
}

const createWindow = (): void => {
  const assets = windowAssets();
  const mainWindow = new BrowserWindow({
    height: 800,
    width: 1120,
    minHeight: 520,
    minWidth: 720,
    backgroundColor: '#FFFDF7',
    titleBarStyle: 'hiddenInset',
    // An isolated launch must not take focus from the person at the desk.
    show: !isolated,
    webPreferences: {
      preload: assets.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Streaming render batches on requestAnimationFrame; an occluded
      // window must keep painting background conversations truthfully.
      backgroundThrottling: false,
    },
  });

  // The window must never leave the app: chat renders remote-authored
  // markdown, and a navigated page would inherit the preload's IPC bridge.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== assets.url) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  if (isolated) mainWindow.once('ready-to-show', () => mainWindow.showInactive());
  mainWindow.loadURL(assets.url);
  log.info('window.created');
};

/* ---------- IPC surface ---------- */

// One handler per CHANNELS entry (the Record type keeps the table total —
// an unhandled channel is a compile error, and channels.test.ts asserts the
// registration from the outside). Payloads arrive untrusted; every argument
// goes through a validating coercion — ipcguard for ids/strings/configs,
// conversations.fromIpc for the persisted transcript — before touching a
// store or docker. No handler casts its args.
type IpcHandler = (event: IpcMainInvokeEvent, args: unknown) => unknown;

/** Providers with a sign-in (harness and integration kinds). */
function signInProvider(id: string): providerRegistry.HarnessProvider | providerRegistry.IntegrationProvider {
  const provider = providerRegistry.requireProvider(id);
  if (provider.kind === 'environment') throw new Error(`${provider.label} has no sign-in.`);
  return provider;
}

const ipcHandlers: Record<(typeof CHANNELS)[keyof typeof CHANNELS], IpcHandler> = {
  [CHANNELS.status]: () => backend.status(),
  [CHANNELS.providers]: () => providerRegistry.providerInfos(),
  [CHANNELS.openExternal]: (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url);
  },
  [CHANNELS.providerAuthStart]: async (_event, id) => {
    const provider = signInProvider(requireId(id, 'provider'));
    return { url: await provider.auth.start() };
  },
  [CHANNELS.providerAuthCancel]: (_event, id) => {
    signInProvider(requireId(id, 'provider')).auth.cancel();
  },
  [CHANNELS.providerAuthLogout]: (_event, id) => signInProvider(requireId(id, 'provider')).auth.logout(),
  [CHANNELS.runners]: () => runners.state(),
  [CHANNELS.runnerRegistrationToken]: async () => {
    const token = await serverApi.registrationToken();
    const releases = await serverApi.releases().catch(() => ({ latest: null, assets: [] }));
    return {
      id: token.id,
      token: token.token,
      expiresAt: token.expiresAt,
      serverUrl: token.serverUrl,
      version: releases.latest,
      assets: releases.assets.filter((a) => a.version === releases.latest),
    };
  },
  [CHANNELS.runnerRegistrationCancel]: (_event, id) => serverApi.revokeEnrollToken('registration', enrollTokenIdFrom(id)),
  [CHANNELS.runnerRemovalToken]: async (_event, runnerId) => {
    runnerIdFrom(runnerId);
    const token = await serverApi.removalToken();
    return { id: token.id, token: token.token, expiresAt: token.expiresAt, command: `./config.sh remove --token ${token.token}` };
  },
  [CHANNELS.runnerForceRemove]: async (_event, runnerId) => {
    await runners.forceRemove(runnerIdFrom(runnerId));
    return runners.state();
  },
  [CHANNELS.runnerUpdate]: async (_event, args) => {
    const a = objArgs(args);
    await serverApi.updateRunner(runnerIdFrom(a.runnerId), runnerPatchFrom(a.patch));
    await runners.refresh();
    return runners.state();
  },
  [CHANNELS.runnerInstallLocal]: async () => {
    await runners.installLocal();
    return runners.state();
  },
  [CHANNELS.runnerUninstallLocal]: async () => {
    await runners.uninstallLocal();
    return runners.state();
  },

  [CHANNELS.instanceList]: () => instances.list(),
  [CHANNELS.instanceStart]: (_event, spec) => instances.start(startSpecFrom(spec)),
  [CHANNELS.instanceOpen]: (_event, envId) => instances.open(instanceIdFrom(envId)),
  [CHANNELS.instanceStop]: (_event, envId) => instances.stop(instanceIdFrom(envId)),
  [CHANNELS.instanceResume]: (_event, envId) => instances.resume(instanceIdFrom(envId)),
  [CHANNELS.instanceRebuild]: (_event, envId) => instances.rebuild(instanceIdFrom(envId)),
  [CHANNELS.instanceDelete]: (_event, envId) => instances.remove(instanceIdFrom(envId)),
  [CHANNELS.instanceForget]: (_event, envId) => instances.forget(instanceIdFrom(envId)),
  [CHANNELS.daemon]: (_event, args) => {
    const { envId, op, args: opArgs } = daemonCallFrom(args);
    return instances.daemon(envId, op, opArgs as never);
  },
  [CHANNELS.githubInstallations]: () => github.installations(),
  [CHANNELS.githubRepos]: () => github.repositories(),
  [CHANNELS.githubSetConfigRepo]: async (_event, fullName) => {
    await github.setConfigRepo(repoNameFrom(fullName));
    return providerRegistry.providerInfos();
  },

  [CHANNELS.definitionRefs]: () => configRepo.definitionRefs(),
  [CHANNELS.definitionsAt]: (_event, pin) => configRepo.definitionsAt(pinFrom(pin)),

  [CHANNELS.agentList]: () => agents.list(),
  [CHANNELS.agentCreate]: (_event, cfg) => agents.create(agentConfigFrom(cfg)),
  [CHANNELS.agentUpdate]: (_event, args) => {
    const a = objArgs(args);
    return agents.update(requireId(a.id, 'agent'), agentConfigFrom(a.cfg));
  },
  [CHANNELS.agentDelete]: (_event, id) => agents.remove(requireId(id, 'agent')),
  [CHANNELS.agentSelect]: (_event, id) => {
    agents.select(requireId(id, 'agent'));
    return backend.status();
  },

  [CHANNELS.envList]: () => environments.list(),
  [CHANNELS.envCreate]: (_event, cfg) => environments.create(envConfigFrom(cfg)),
  [CHANNELS.envUpdate]: (_event, args) => {
    const a = objArgs(args);
    return environments.update(requireId(a.id, 'environment'), envConfigFrom(a.cfg));
  },
  [CHANNELS.envDelete]: (_event, id) => environments.remove(requireId(id, 'environment')),
  [CHANNELS.envStart]: (_event, id) => environments.start(requireId(id, 'environment')),
  [CHANNELS.envStop]: (_event, id) => environments.stop(requireId(id, 'environment')),
  [CHANNELS.envRestart]: (_event, id) => environments.restart(requireId(id, 'environment')),
  [CHANNELS.envRebuild]: (_event, id) => environments.rebuild(requireId(id, 'environment')),
  [CHANNELS.envSecretSet]: (_event, args) => {
    const a = objArgs(args);
    return environments.secretSet(
      requireId(a.id, 'environment'),
      requireSecretKey(a.key),
      requireString(a.value, 'secret value'),
    );
  },
  [CHANNELS.envSecretDelete]: (_event, args) => {
    const a = objArgs(args);
    return environments.secretDelete(requireId(a.id, 'environment'), requireSecretKey(a.key));
  },
  [CHANNELS.envSelect]: (_event, id) => {
    environments.select(requireId(id, 'environment'));
    return backend.status();
  },

  [CHANNELS.convoLoad]: () => conversations.loadAll(),

  [CHANNELS.supportInfo]: () => support.supportInfo(),
  [CHANNELS.supportExport]: (event) =>
    support.exportSupportBundle(BrowserWindow.fromWebContents(event.sender)),
  [CHANNELS.convoSave]: (_event, args) => {
    const a = objArgs(args);
    return conversations.save(requireId(a.agentId, 'agent'), conversations.fromIpc(a.data));
  },

  [CHANNELS.startTurn]: async (event, args) => {
    const a = objArgs(args);
    const turnId = requireString(a.turnId, 'turn id');
    const agentId = requireId(a.agentId, 'agent');
    const promptText = requireString(a.prompt, 'prompt');
    for await (const harnessEvent of backend.runTurn(turnId, agentId, promptText)) {
      if (event.sender.isDestroyed()) return;
      event.sender.send(EVENT_CHANNEL, { turnId, event: harnessEvent });
    }
  },
  [CHANNELS.interrupt]: (_event, turnId) => backend.interrupt(requireString(turnId, 'turn id')),
  [CHANNELS.answerAsk]: (_event, args) => {
    const a = objArgs(args);
    return backend.answerAsk(
      requireString(a.turnId, 'turn id'),
      requireString(a.askId, 'ask id'),
      askAnswersFrom(a.answers),
    );
  },
};

for (const [channel, handler] of Object.entries(ipcHandlers)) {
  // Every failed request lands in the diagnostic log under its channel
  // name; the renderer still receives the rejection unchanged.
  ipcMain.handle(channel, async (event, args) => {
    try {
      return await handler(event, args);
    } catch (err) {
      log.warn(`ipc.failed ${channel}`, { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  });
}

/* ---------- App lifecycle ---------- */

app.on('ready', () => {
  log.info('app.ready', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    electron: process.versions.electron,
    platform: `${process.platform}-${process.arch}`,
    isolated: !!isolated,
  });
  // Packaged builds get a strict CSP; dev needs webpack's eval sourcemaps,
  // covered by the WebpackPlugin devContentSecurityPolicy instead.
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:",
          ],
        },
      });
    });
  }
  createWindow();
  // Follow the signed-in user's runners and reattach the environment the
  // window showed last (it replays from its cursor).
  runners.start();
  instances.resumeCurrent();
  // Locate the docker CLI up front (Finder launches do not inherit the shell
  // PATH); a miss is reported by the first environment operation that needs it.
  void dockerLocation().catch((err) => console.error('Docker discovery:', err));
});

// Quit is a drain: the first request is held while the renderer flushes its
// debounced saves and the composer draft and every queued store write
// settles; then it proceeds (bounded, so a stuck disk cannot wedge quit).
installQuitDrain(app, {
  flushRenderers,
  drainStores: async () => {
    instances.flushSeq();
    await flushWrites();
  },
  timeoutMs: 5_000,
});

// Kill runner docker-exec children on quit — no orphaned processes.
app.on('before-quit', () => runner.detachAll());
// will-quit fires once, after the drain has re-issued quit; before-quit fires twice.
// Environment connections close last: every environment keeps working.
app.on('will-quit', () => {
  instances.shutdown();
  runners.shutdown();
  log.info('app.quit');
});

// macOS convention: closing the window keeps the app (and menu bar) alive.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Dock-icon click with no window open recreates one (macOS).
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
