/**
 * Boot smoke test: launches the real app isolated (`npm run start:isolated`:
 * a throwaway data dir, the mock keychain, no focus steal) with a debug port,
 * attaches over CDP, and asserts the chat shell renders with a working
 * preload bridge and zero page errors. It never reads or writes the real user
 * data folder or keychain. Needs a desktop session (run locally: npm run test:e2e).
 */

import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

// A free port, so the test never attaches to another Puck's debug port.
const PORT = await new Promise((resolve, reject) => {
  const srv = createServer().once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-smoke-'));
const app = spawn('npm', ['run', 'start:isolated', '--', '--', `--remote-debugging-port=${PORT}`], {
  stdio: 'ignore',
  detached: true,
  env: { ...process.env, PUCK_ISOLATED: '1', PUCK_ISOLATED_DIR: dataDir },
});

const kill = () => {
  try {
    process.kill(-app.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  try {
    execSync(`pkill -f -- "--remote-debugging-port=${PORT}" || true`, { stdio: 'ignore' });
  } catch {
    /* none left */
  }
};

/** Whether this run's Electron is still up (its quit drain writes to dataDir). */
const running = () => {
  try {
    execSync(`pgrep -f -- "--remote-debugging-port=${PORT}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
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
    dataDir: await window.puck
      .supportInfo()
      .then((s) => s.dataDir)
      .catch(() => null),
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
  // Providers renders every kind: harnesses, environments, integrations.
  await page.click('.nav-item[data-section="providers"]');
  await page.waitForSelector('#pv-integration-cards [data-provider="github"]', { timeout: 5000 }).catch(() => {
    throw new Error('providers section did not render the GitHub card');
  });
  const groups = await page.evaluate(() => ({
    harness: document.querySelectorAll('#pv-harness-cards [data-provider]').length,
    env: document.querySelectorAll('#pv-env-cards .pv-card').length,
  }));
  if (groups.harness !== 2 || groups.env !== 2) throw new Error(`providers grouped wrong: ${JSON.stringify(groups)}`);
  await page.keyboard.press('Escape');
  await browser.close();

  if (!state.bridge) throw new Error('preload bridge missing');
  if (!state.composer) throw new Error('composer missing');
  if (!state.status) throw new Error('harness:status round-trip failed');
  if (state.dataDir !== dataDir) {
    throw new Error(`app data is not isolated: ${state.dataDir} (expected ${dataDir})`);
  }
  if (!fs.existsSync(path.join(dataDir, 'logs', 'puck.log'))) throw new Error('no diagnostic log in the isolated data dir');
  if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
  console.log(`smoke OK — bridge + status up, settings modal and Providers section render, ${state.roster} agents listed`);
} finally {
  kill();
  for (let i = 0; i < 20 && running(); i++) await sleep(500);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
