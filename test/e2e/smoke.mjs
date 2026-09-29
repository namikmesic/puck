/**
 * Boot smoke test: launches the real app isolated (`npm run start:isolated`:
 * a throwaway data dir, the mock keychain, no focus steal) with a debug port,
 * attaches over CDP, and asserts the environment window renders with a
 * working preload bridge and zero page errors: the first-run screen shows,
 * Settings has exactly Providers, Runners and Support, and Esc closes it. It
 * never reads or writes the real user data folder or keychain. Needs a
 * desktop session (run locally: npm run test:e2e).
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

/** Boots the app and checks its window (`windowPath` is the dev URL segment). */
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
    await sleep(2500); // boot

    await page.waitForSelector('#fr:not(.hidden) .fr-step', { timeout: 10_000 }).catch(() => {
      throw new Error(`${label}: the first-run screen did not show`);
    });
    const state = await page.evaluate(async () => ({
      bridge: !!window.puck,
      firstRun: document.querySelectorAll('#fr:not(.hidden) .fr-step').length,
      dataDir: await window.puck
        .supportInfo()
        .then((s) => s.dataDir)
        .catch(() => null),
      shell: !!document.getElementById('app-shell'),
      // The per-agent chat's bridge is gone: turns run in environments.
      legacy: ['status', 'agentList', 'envList', 'convoSave', 'startTurn'].filter((m) => m in window.puck),
      providers: await window.puck
        .providers()
        .then((list) => list.length)
        .catch(() => 0),
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
      sections: [...document.querySelectorAll('#settings-nav .nav-item')].map((n) => n.dataset.section),
    }));
    if (groups.harness !== 2 || groups.runners !== 0) throw new Error(`${label}: providers grouped wrong: ${JSON.stringify(groups)}`);
    if (groups.sections.join(',') !== 'providers,runners,support') throw new Error(`${label}: settings sections are ${groups.sections.join(', ')}`);
    await page.click('.nav-item[data-section="runners"]');
    await page.waitForSelector('#rn-cards [data-provider="runner"]', { timeout: 5000 }).catch(() => {
      throw new Error(`${label}: the Runners section did not render`);
    });
    await page.keyboard.press('Escape');
    const closed = await page
      .waitForSelector('#settings-overlay.hidden', { state: 'attached', timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (!closed) throw new Error(`${label}: Esc did not close Settings`);
    await browser.close();

    if (!state.bridge) throw new Error(`${label}: preload bridge missing`);
    if (state.providers !== 4) throw new Error(`${label}: provider:list round-trip returned ${state.providers} providers`);
    if (state.legacy.length) throw new Error(`${label}: the bridge still has ${state.legacy.join(', ')}`);
    if (state.dataDir !== dataDir) {
      throw new Error(`${label}: app data is not isolated: ${state.dataDir} (expected ${dataDir})`);
    }
    if (!fs.existsSync(path.join(dataDir, 'logs', 'puck.log'))) throw new Error(`${label}: no diagnostic log in the isolated data dir`);
    if (errors.length) throw new Error(`${label}: page errors: ${errors.join(' | ')}`);
    if (!state.shell) throw new Error(`${label}: the environment window is missing`);
    if (state.firstRun !== 6) throw new Error(`${label}: first run shows ${state.firstRun} steps`);
    console.log(`smoke ${label} OK — bridge up, first run shows, settings modal and its sections render`);
  } finally {
    kill();
    for (let i = 0; i < 20 && running(); i++) await sleep(500);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

await boot({}, { windowPath: '/main_window/', label: 'app' });
