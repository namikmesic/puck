/**
 * Boot smoke test: launches the real app with a debug port, attaches over
 * CDP, and asserts the chat shell renders with a working preload bridge and
 * zero page errors. Needs a desktop session (run locally: npm run test:e2e).
 */

import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const PORT = 9223;
const app = spawn('npm', ['start', '--', '--', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  detached: true,
});

const kill = () => {
  try {
    process.kill(-app.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  try {
    execSync('pkill -f "puck.*Electron" || true', { stdio: 'ignore' });
  } catch {
    /* none left */
  }
};

try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`);
      up = true;
      break;
    } catch {
      await sleep(1000);
    }
  }
  if (!up) throw new Error('debug port never came up');

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes('main_window'));
  if (!page) throw new Error('main window not found');

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await sleep(2500); // boot + conversation hydration

  const state = await page.evaluate(async () => ({
    bridge: !!window.puck,
    composer: !!document.getElementById('prompt'),
    roster: document.querySelectorAll('.recent.agent-row').length,
    // Round-trips a real IPC handler — catches unregistered-channel bugs.
    status: await window.puck
      .status()
      .then((s) => typeof s.connected === 'boolean')
      .catch(() => false),
  }));
  await page.click('#open-settings');
  await page.waitForSelector('#settings-overlay:not(.hidden)', { timeout: 2000 }).catch(() => {
    throw new Error('settings modal did not open');
  });
  await page.waitForTimeout(400); // let the section renders surface any page errors
  await page.keyboard.press('Escape');
  await browser.close();

  if (!state.bridge) throw new Error('preload bridge missing');
  if (!state.composer) throw new Error('composer missing');
  if (!state.status) throw new Error('harness:status round-trip failed');
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`smoke OK — bridge + status up, settings modal opens, ${state.roster} agents listed`);
} finally {
  kill();
}
