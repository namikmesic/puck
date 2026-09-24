/**
 * The Settings → Support section: where Puck keeps its data on this Mac,
 * and the support-bundle export. Context/elements in, controller out, no
 * DOM lookups inside, so it is jsdom-testable like the other settings
 * modules.
 */

import type { PuckBridge } from '../../harness/bridge';
import { errText } from '../util';

export interface SupportElements {
  version: HTMLElement;
  dataDir: HTMLElement;
  logFile: HTMLElement;
  exportBtn: HTMLButtonElement;
  msg: HTMLElement;
}

export interface SupportContext {
  bridge: PuckBridge | undefined;
  els: SupportElements;
}

export function initSupportView(ctx: SupportContext): { render(): Promise<void> } {
  const { bridge, els } = ctx;

  els.exportBtn.addEventListener('click', async () => {
    if (!bridge) return;
    els.exportBtn.disabled = true;
    els.msg.textContent = '';
    els.msg.classList.remove('ok');
    try {
      const { path } = await bridge.supportExport();
      if (path) {
        els.msg.textContent = `Saved ${path}`;
        els.msg.classList.add('ok');
      } else {
        els.msg.textContent = 'Export canceled.';
      }
    } catch (err) {
      els.msg.textContent = errText(err);
    } finally {
      els.exportBtn.disabled = false;
    }
  });

  return {
    async render(): Promise<void> {
      if (!bridge) return;
      try {
        const info = await bridge.supportInfo();
        els.version.textContent = info.version;
        els.dataDir.textContent = info.dataDir;
        els.logFile.textContent = info.logFile;
      } catch (err) {
        els.msg.textContent = errText(err);
      }
    },
  };
}
