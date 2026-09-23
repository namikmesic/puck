/**
 * Dedicated sign-in window for provider OAuth flows (main process).
 *
 * Logins open in their own BrowserWindow instead of inline UI or the system
 * browser. A persistent session partition keeps provider cookies between
 * logins, and the user agent is normalized to a plain Chrome UA (some
 * identity providers refuse embedded/"insecure" browsers otherwise).
 */

import { BrowserWindow, session } from 'electron';

let current: BrowserWindow | null = null;

/**
 * Wipe the sign-in partition (cookies, storage). Called on provider logout —
 * otherwise the next "Connect" silently re-authenticates the same account.
 */
export function clearAuthSession(): void {
  void session.fromPartition('persist:puck-auth').clearStorageData();
}

export function openAuthWindow(url: string, title: string): BrowserWindow {
  closeAuthWindow();
  const win = new BrowserWindow({
    width: 540,
    height: 760,
    title,
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:puck-auth',
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const ua = win.webContents.getUserAgent().replace(/(Electron|puck)\/\S+ ?/g, '');
  win.webContents.setUserAgent(ua);
  void win.loadURL(url);
  win.on('closed', () => {
    if (current === win) current = null;
  });
  current = win;
  return win;
}

export function closeAuthWindow(): void {
  if (current && !current.isDestroyed()) current.close();
  current = null;
}
