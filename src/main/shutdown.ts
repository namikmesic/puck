/**
 * Quit drain (main process).
 *
 * Electron exits as soon as the `before-quit` listeners return, so anything
 * still queued at that moment is lost: atomic store writes in flight
 * (jsonstore) and the environment replay cursor. The first quit request is
 * intercepted; the renderer is asked to persist anything it still holds,
 * then the store chains are awaited; then quit resumes. The wait is bounded so a stuck disk or an
 * unresponsive renderer cannot wedge quit.
 */

import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import { FLUSH_CHANNEL, FLUSHED_CHANNEL } from '../harness/channels';

export interface QuitDrainDeps {
  /** Ask the renderer(s) to persist everything pending; resolves when acknowledged. */
  flushRenderers(): Promise<void>;
  /** Await every queued store write. */
  drainStores(): Promise<void>;
  /** Upper bound on the whole drain, in ms. */
  timeoutMs: number;
  log?(message: string): void;
}

/** The slice of Electron's `app` the drain needs (injected so tests can fake it). */
export interface QuitApp {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

/**
 * Intercepts the first `before-quit`, runs the drain once, then re-issues
 * `app.quit()`, which the second `before-quit` lets through. Returns the
 * drain for callers that want to await it directly.
 */
export function installQuitDrain(app: QuitApp, deps: QuitDrainDeps): { drain(): Promise<void> } {
  const log = deps.log ?? ((message: string) => console.error(message));
  let drained = false;
  let draining: Promise<void> | null = null;

  const drain = (): Promise<void> => {
    draining ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), deps.timeoutMs);
      });
      try {
        // Renderer first: its saves enqueue store writes the drain then awaits.
        const work = deps.flushRenderers().then(() => deps.drainStores());
        if ((await Promise.race([work, timeout])) === 'timeout') {
          log(`quit drain: still pending after ${deps.timeoutMs}ms - quitting anyway`);
        }
      } catch (err) {
        log(`quit drain failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
        drained = true;
      }
    })();
    return draining;
  };

  app.on('before-quit', (event) => {
    if (drained) return; // second pass: let the quit proceed
    event.preventDefault();
    void drain().then(() => app.quit());
  });

  return { drain };
}

/**
 * Ask every live window to persist its pending state (FLUSH_CHANNEL) and wait
 * for each one's acknowledgement (FLUSHED_CHANNEL carrying the same token).
 * A window that never answers is covered by the drain's timeout.
 */
export function flushRenderers(): Promise<void> {
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.webContents.isDestroyed());
  if (!windows.length) return Promise.resolve();
  const token = crypto.randomUUID();
  const waiting = new Set(windows.map((w) => w.webContents.id));
  return new Promise((resolve) => {
    const onFlushed = (event: IpcMainEvent, answered: unknown): void => {
      if (answered !== token) return;
      waiting.delete(event.sender.id);
      if (!waiting.size) {
        ipcMain.removeListener(FLUSHED_CHANNEL, onFlushed);
        resolve();
      }
    };
    ipcMain.on(FLUSHED_CHANNEL, onFlushed);
    for (const w of windows) w.webContents.send(FLUSH_CHANNEL, token);
  });
}
