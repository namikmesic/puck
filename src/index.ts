/**
 * Main-process composition root: constructs the window, wires the services
 * together (runner and environment events → the renderer, harness sign-in
 * and sign-out → the attached environment), and registers the IPC surface
 * from one handler table. Domain logic lives in src/main/*; this file only
 * assembles it.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainInvokeEvent } from 'electron';
import * as configRepo from './main/config-repo';
import * as providerRegistry from './main/providers';
import * as github from './main/providers/github';
import * as instances from './main/instances';
import * as runners from './main/runners';
import * as serverApi from './main/server/api';
import { log } from './main/log';
import { flushWrites } from './main/jsonstore';
import { flushRenderers, installQuitDrain } from './main/shutdown';
import * as support from './main/support';
import {
  appliedPinFrom,
  daemonCallFrom,
  enrollTokenIdFrom,
  instanceIdFrom,
  objArgs,
  pinFrom,
  repoNameFrom,
  requireId,
  runnerIdFrom,
  runnerPatchFrom,
  startSpecFrom,
} from './main/ipcguard';
import { CHANNELS, DAEMON_EVENT_CHANNEL, INSTANCE_EVENT_CHANNEL, RUNNER_EVENT_CHANNEL } from './harness/channels';
import type { RunnerEvent } from './harness/bridge';
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

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
// Composition: runner-list, environment and daemon events stream to the
// renderer; a harness sign-in or sign-out reaches the attached environment
// over its daemon connection (the others on their next attach). A failed
// removal surfaces to the Disconnect button through the IPC rejection.
runners.onRunnersChange((e) => {
  const event: RunnerEvent = e.kind === 'state' ? { kind: 'state', state: runners.state() } : e;
  broadcast(RUNNER_EVENT_CHANNEL, event);
});
instances.onInstanceEvent((e) => broadcast(INSTANCE_EVENT_CHANNEL, e));
instances.onDaemonEvent((e) => broadcast(DAEMON_EVENT_CHANNEL, e));
providerRegistry.setOnLogin(() => {
  instances.onHarnessLogin().catch((err) => log.error('Credential push into the attached environment failed', err));
});
providerRegistry.setOnLogout(async (provider) => {
  await instances.onHarnessLogout(provider.id);
});

// Injected by Forge's webpack plugin: dev-server vs packaged bundle URLs.
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    height: 800,
    width: 1120,
    // Three panes need the room.
    minHeight: 600,
    minWidth: 960,
    backgroundColor: '#FFFDF7',
    titleBarStyle: 'hiddenInset',
    // An isolated launch must not take focus from the person at the desk.
    show: !isolated,
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

  if (isolated) mainWindow.once('ready-to-show', () => mainWindow.showInactive());
  mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  log.info('window.created');
};

/* ---------- IPC surface ---------- */

// One handler per CHANNELS entry (the Record type keeps the table total —
// an unhandled channel is a compile error, and channels.test.ts asserts the
// registration from the outside). Payloads arrive untrusted; every argument
// goes through a validating coercion in ipcguard before it reaches a store,
// the Puck server, a runner or a daemon. No handler casts its args.
type IpcHandler = (event: IpcMainInvokeEvent, args: unknown) => unknown;

/** Providers with a sign-in (harness and integration kinds). */
function signInProvider(id: string): providerRegistry.HarnessProvider | providerRegistry.IntegrationProvider {
  const provider = providerRegistry.requireProvider(id);
  if (provider.kind === 'environment') throw new Error(`${provider.label} has no sign-in.`);
  return provider;
}

const ipcHandlers: Record<(typeof CHANNELS)[keyof typeof CHANNELS], IpcHandler> = {
  [CHANNELS.providers]: async () => {
    await github.loadInstallLink();
    return providerRegistry.providerInfos();
  },
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
    // Releases first: a failed read surfaces as an error instead of reading as
    // "no packages", and leaves no token behind.
    const releases = await serverApi.releases();
    const token = await serverApi.registrationToken();
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
  [CHANNELS.instanceCheckUpdate]: (_event, envId) => instances.checkUpdate(instanceIdFrom(envId)),
  [CHANNELS.instanceApplyUpdate]: (_event, args) => {
    const a = objArgs(args);
    return instances.applyUpdate(instanceIdFrom(a.envId), appliedPinFrom(a.pin));
  },
  [CHANNELS.instanceUpgradeDaemon]: (_event, args) => {
    const a = objArgs(args);
    if (a.mode !== 'drain' && a.mode !== 'now') throw new Error('mode must be "drain" or "now".');
    return instances.upgradeDaemon(instanceIdFrom(a.envId), a.mode);
  },
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

  [CHANNELS.supportInfo]: () => support.supportInfo(),
  [CHANNELS.supportExport]: (event) =>
    support.exportSupportBundle(BrowserWindow.fromWebContents(event.sender)),
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
