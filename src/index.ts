/**
 * Main-process composition root: constructs the window, wires the services
 * together (runner transport, env-reset → resume-id invalidation, login →
 * credential push), and registers the IPC surface from one handler table.
 * Domain logic lives in src/main/*; this file only assembles it.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import * as agents from './main/agents';
import * as backend from './main/backend';
import * as conversations from './main/conversations';
import * as providerRegistry from './main/providers';
import * as environments from './main/environments';
import { log } from './main/log';
import * as runner from './main/runner';
import * as sessionRegistry from './main/session-registry';
import { flushWrites } from './main/jsonstore';
import { flushRenderers, installQuitDrain } from './main/shutdown';
import * as support from './main/support';
import {
  agentConfigFrom,
  askAnswersFrom,
  envConfigFrom,
  objArgs,
  requireId,
  requireSecretKey,
  requireString,
} from './main/ipcguard';
import { CHANNELS, ENV_EVENT_CHANNEL, EVENT_CHANNEL } from './harness/channels';
import { dockerLocation } from './main/docker-client';

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
environments.onLifecycle((payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(ENV_EVENT_CHANNEL, payload);
  }
});
providerRegistry.setOnLogin(() =>
  environments.injectCredentialsIntoRunning().catch((err) => {
    log.error('Credential push into running environments failed', err);
  }),
);
providerRegistry.setOnLogout((provider) => environments.purgeCredentials(provider));

// Injected by Forge's webpack plugin: dev-server vs packaged bundle URLs.
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    height: 800,
    width: 1120,
    minHeight: 520,
    minWidth: 720,
    backgroundColor: '#FFFDF7',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
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
    if (url !== MAIN_WINDOW_WEBPACK_ENTRY) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });

  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
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

const ipcHandlers: Record<(typeof CHANNELS)[keyof typeof CHANNELS], IpcHandler> = {
  [CHANNELS.status]: () => backend.status(),
  [CHANNELS.providers]: () => providerRegistry.providerInfos(),
  [CHANNELS.openExternal]: (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url);
  },
  [CHANNELS.providerAuthStart]: async (_event, id) => {
    const url = await providerRegistry.requireProvider(requireId(id, 'provider')).auth.start();
    return { url };
  },
  [CHANNELS.providerAuthCancel]: (_event, id) => {
    providerRegistry.requireProvider(requireId(id, 'provider')).auth.cancel();
  },
  [CHANNELS.providerAuthLogout]: (_event, id) =>
    providerRegistry.requireProvider(requireId(id, 'provider')).auth.logout(),

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
  // Locate the docker CLI up front (Finder launches do not inherit the shell
  // PATH); a miss is reported by the first environment operation that needs it.
  void dockerLocation().catch((err) => console.error('Docker discovery:', err));
});

// Quit is a drain: the first request is held while the renderer flushes its
// debounced saves and the composer draft and every queued store write
// settles; then it proceeds (bounded, so a stuck disk cannot wedge quit).
installQuitDrain(app, { flushRenderers, drainStores: flushWrites, timeoutMs: 5_000 });

// Kill runner docker-exec children on quit — no orphaned processes.
app.on('before-quit', () => runner.detachAll());
// will-quit fires once, after the drain has re-issued quit; before-quit fires twice.
app.on('will-quit', () => log.info('app.quit'));

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
