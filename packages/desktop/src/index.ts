/**
 * Main-process composition root: constructs the window, wires the services
 * together (runner transport, env-reset → resume-id invalidation, login →
 * credential push), and registers the IPC surface from one handler table.
 * Domain logic lives in src/main/*; this file only assembles it.
 */

import { app, BrowserWindow, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import * as agents from './main/agents';
import * as backend from './main/backend';
import * as conversations from './main/conversations';
import * as providerRegistry from './main/providers';
import * as environments from './main/environments';
import * as runner from './main/runner';
import * as sessionRegistry from './main/session-registry';
import {
  agentConfigFrom,
  askAnswersFrom,
  envConfigFrom,
  objArgs,
  requireId,
  requireSecretKey,
  requireString,
} from './main/ipcguard';
import { CHANNELS, EVENT_CHANNEL } from './harness/channels';

// A rejected fire-and-forget promise must never take the process down.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in main process:', reason);
});

// Composition: the runner bridge speaks NDJSON over whatever exec transport
// it is handed; environments supplies the docker adapter. A destroyed
// container invalidates its resume ids, and a completed login pushes
// credentials into every running environment.
runner.useExecSpawner(environments.runnerExecSpawner);
environments.onEnvReset(sessionRegistry.forgetEnvironment);
providerRegistry.setOnLogin(() =>
  environments.injectCredentialsIntoRunning().catch((err) => {
    console.error('Credential push into running environments failed:', err);
  }),
);

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
  [CHANNELS.providerAuthLogout]: (_event, id) => {
    providerRegistry.requireProvider(requireId(id, 'provider')).auth.logout();
  },

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
  ipcMain.handle(channel, handler);
}

/* ---------- App lifecycle ---------- */

app.on('ready', () => {
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
});

// Kill runner docker-exec children on quit — no orphaned processes.
app.on('before-quit', () => runner.detachAll());

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
