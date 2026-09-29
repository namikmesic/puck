/**
 * Boot smoke test: launches the real app isolated (`npm run start:isolated`:
 * a throwaway data dir, the mock keychain, no focus steal) with a debug port,
 * attaches over CDP, and asserts the chat shell renders with a working
 * preload bridge and zero page errors. It never reads or writes the real user
 * data folder or keychain. Needs a desktop session (run locally: npm run test:e2e).
 *
 * A second boot with PUCK_UI=v2 checks the runner shell the same way.
 */

import { spawn, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer().once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Boots one window. `windowPath` is the dev URL segment (`/main_window/` or
 * `/main_window_v2/`); the slash keeps the v1 page from matching v2.
 */
async function boot(extraEnv, { windowPath, label }) {
  const PORT = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-smoke-'));
  const app = spawn('npm', ['run', 'start:isolated', '--', '--', `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, PUCK_ISOLATED: '1', PUCK_ISOLATED_DIR: dataDir, ...extraEnv },
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
    if (!up) throw new Error(`${label}: debug port never came up`);

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes(windowPath));
    if (!page) throw new Error(`${label}: window not found`);

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
      v2: !!document.getElementById('v2-app'),
      roster: document.querySelectorAll('.recent.agent-row').length,
      status: await window.puck
        .status()
        .then((s) => typeof s.connected === 'boolean')
        .catch(() => false),
    }));
    await page.click('#open-settings');
    await page.waitForSelector('#settings-overlay:not(.hidden)', { timeout: 2000 }).catch(() => {
      throw new Error(`${label}: settings modal did not open`);
    });
    await page.waitForTimeout(400);
    await page.click('.nav-item[data-section="providers"]');
    await page.waitForSelector('#pv-integration-cards [data-provider="github"]', { timeout: 5000 }).catch(() => {
      throw new Error(`${label}: providers section did not render the GitHub card`);
    });
    const groups = await page.evaluate(() => ({
      harness: document.querySelectorAll('#pv-harness-cards [data-provider]').length,
      runners: document.querySelectorAll('#pv-env-cards [data-provider="runner"]').length,
    }));
    if (groups.harness !== 2 || groups.runners !== 1) throw new Error(`${label}: providers grouped wrong: ${JSON.stringify(groups)}`);
    await page.keyboard.press('Escape');
    await browser.close();

    if (!state.bridge) throw new Error(`${label}: preload bridge missing`);
    if (!state.status) throw new Error(`${label}: harness:status round-trip failed`);
    if (state.dataDir !== dataDir) {
      throw new Error(`${label}: app data is not isolated: ${state.dataDir} (expected ${dataDir})`);
    }
    if (!fs.existsSync(path.join(dataDir, 'logs', 'puck.log'))) throw new Error(`${label}: no diagnostic log in the isolated data dir`);
    if (errors.length) throw new Error(`${label}: page errors: ${errors.join(' | ')}`);
    if (label === 'v1' && !state.composer) throw new Error('composer missing');
    if (label === 'v2' && !state.v2) throw new Error('v2 shell missing');
    if (label === 'v2' && state.composer) throw new Error('v2 booted the legacy composer');
    console.log(`smoke ${label} OK — bridge + status up, settings modal and Providers section render${label === 'v1' ? `, ${state.roster} agents listed` : ''}`);
  } finally {
    kill();
    for (let i = 0; i < 20 && running(); i++) await sleep(500);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

await boot({}, { windowPath: '/main_window/', label: 'v1' });
await boot({ PUCK_UI: 'v2' }, { windowPath: '/main_window_v2/', label: 'v2' });
