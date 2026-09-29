/**
 * Screenshots of the environment window in every view and state, from the
 * fixture harness (src/renderer/fixture): launches the app isolated with
 * PUCK_FIXTURE=<scenario> (no runner, no sign-in), attaches over CDP, and
 * saves each state at 1440×900 and 1024×768 into the directory given.
 * Viewports are set with Emulation.setDeviceMetricsOverride and cleared
 * again (never page.setViewportSize, which outlives the script). Images
 * go wherever you point it; never commit them.
 *
 *   node test/e2e/fixture-shots.mjs <out-dir> [name-filter]
 *
 * PUCK_DEV_PORT and PUCK_DEV_LOGGER_PORT (default 3312, 9312) keep it off
 * the ports a running `npm start` holds.
 */

import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

const OUT = process.argv[2];
const FILTER = process.argv[3] ?? '';
if (!OUT) {
  console.error('usage: node test/e2e/fixture-shots.mjs <out-dir> [name-filter]');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const SIZES = [
  [1440, 900],
  [1024, 768],
];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer().once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function withApp(scenario, fn) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(OUT, `.iso-${scenario}-`));
  const app = spawn('npm', ['run', 'start:isolated', '--', '--', `--remote-debugging-port=${port}`], {
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      PUCK_ISOLATED: '1',
      PUCK_ISOLATED_DIR: dataDir,
      PUCK_FIXTURE: scenario,
      PUCK_DEV_PORT: process.env.PUCK_DEV_PORT ?? '3312',
      PUCK_DEV_LOGGER_PORT: process.env.PUCK_DEV_LOGGER_PORT ?? '9312',
    },
  });
  try {
    for (let i = 0; i < 120; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`);
        break;
      } catch {
        await sleep(1000);
      }
    }
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    let page;
    for (let i = 0; i < 60 && !page; i++) {
      page = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes('main_window'));
      if (!page) await sleep(500);
    }
    if (!page) throw new Error(`${scenario}: window not found`);
    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.waitForSelector('#tb-views:not(.hidden), #oc-empty:not(.hidden)', { timeout: 30_000 });
    await sleep(1500);
    const cdp = await page.context().newCDPSession(page);
    try {
      await fn(page, cdp);
    } finally {
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
    if (errors.length) console.error(`${scenario}: page errors:\n  ${errors.join('\n  ')}`);
  } finally {
    try {
      process.kill(-app.pid, 'SIGTERM');
    } catch {
      /* gone */
    }
    try {
      execSync(`pkill -f -- "--remote-debugging-port=${port}" || true`, { stdio: 'ignore' });
    } catch {
      /* none left */
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    await sleep(1500);
  }
}

/** Back to a known state: popups, sheet and modals closed, Closed folded, Chat showing. */
async function reset(page) {
  for (let i = 0; i < 4; i++) await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const closed = document.querySelector('.bd-col.col-closed');
    if (closed && !closed.classList.contains('collapsed')) closed.querySelector('.bd-fold')?.click();
    const chat = document.getElementById('oc-chat');
    if (chat) chat.scrollTop = chat.scrollHeight;
  });
  await page.evaluate(() => document.querySelector('#turn-full-back')?.closest('.turn-full-open') && document.querySelector('#turn-full-back')?.click());
  await page.keyboard.press('Meta+1');
  await sleep(250);
}

const board = async (page) => {
  await page.keyboard.press('Meta+2');
  await sleep(300);
};
const showClosed = async (page) => {
  if (await page.$('.bd-col.col-closed.collapsed')) await page.click('.bd-rail');
};
const card = (page, n) => page.click(`.bd-card[data-item="itm_${String(n).padStart(2, '0')}"]`);

/** Simulated drag of a card over a column, stopped mid-drag for the picture. */
async function dragOver(page, n, column) {
  await page.evaluate(
    ({ n, column }) => {
      const source = document.querySelector(`.bd-card[data-item="itm_${String(n).padStart(2, '0')}"]`);
      const target = document.querySelector(`.bd-col[data-col="${column}"] .bd-list`);
      const dt = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const box = target.getBoundingClientRect();
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + 20, clientY: box.top + 60 }));
    },
    { n, column },
  );
}

const SHOTS = {
  full: [
    ['chat', async () => undefined],
    [
      'chat-history',
      async (page) => {
        await page.evaluate(() => {
          const chat = document.getElementById('oc-chat');
          chat.scrollTop = chat.scrollHeight * 0.35;
        });
      },
    ],
    ['chat-details', (page) => page.click('#oc-info')],
    ['chat-env-details', (page) => page.click('#tb-status')],
    [
      'chat-steps',
      async (page) => {
        await page.evaluate(() => document.querySelectorAll('#oc-chat .turn-card')[0]?.click());
      },
    ],
    [
      'chat-item-sheet',
      async (page) => {
        await page.evaluate(() => [...document.querySelectorAll('#oc-chat .ref-chip')].find((c) => c.textContent === 'W-4')?.click());
        await sleep(500);
      },
    ],
    ['board', board],
    [
      'board-menu-backlog',
      async (page) => {
        await board(page);
        await page.hover('.bd-card[data-item="itm_09"]');
        await page.click('.bd-card[data-item="itm_09"] .bd-more');
      },
    ],
    [
      'board-menu-running',
      async (page) => {
        await board(page);
        await page.hover('.bd-card[data-item="itm_03"]');
        await page.click('.bd-card[data-item="itm_03"] .bd-more');
        await page.click('.menu [data-action="cancel"]');
      },
    ],
    [
      'board-closed',
      async (page) => {
        await board(page);
        await showClosed(page);
        await page.evaluate(() => {
          const cols = document.getElementById('bd-columns');
          cols.scrollLeft = cols.scrollWidth;
        });
      },
    ],
    [
      'board-drag',
      async (page) => {
        await board(page);
        await dragOver(page, 9, 'ready');
      },
    ],
    [
      'board-new-item',
      async (page) => {
        await board(page);
        await page.keyboard.press('Meta+n');
        await page.keyboard.type('Rate-limit the login endpoint');
      },
    ],
    [
      'board-import',
      async (page) => {
        await board(page);
        await page.click('#bd-import');
        await page.keyboard.type('web');
        await sleep(600);
      },
    ],
    [
      'sheet-needs-input',
      async (page) => {
        await board(page);
        await card(page, 4);
        await sleep(600);
      },
    ],
    [
      'sheet-running',
      async (page) => {
        await board(page);
        await card(page, 3);
        await sleep(600);
      },
    ],
    [
      'sheet-review-changes',
      async (page) => {
        await board(page);
        await card(page, 2);
        await sleep(300);
        await page.click('#wd-tabs [data-tab="changes"]');
        await sleep(600);
      },
    ],
    [
      'sheet-failed-details',
      async (page) => {
        await board(page);
        await showClosed(page);
        await card(page, 12);
        await sleep(300);
        await page.click('#wd-tabs [data-tab="details"]');
        await sleep(300);
      },
    ],
    [
      'palette',
      async (page) => {
        await page.keyboard.press('Meta+k');
        await page.keyboard.type('w-');
      },
    ],
  ],
  empty: [
    ['chat', async () => undefined],
    ['board', board],
  ],
  provisioning: [['chat', async () => undefined]],
  unreachable: [
    ['chat', async () => undefined],
    ['board', board],
  ],
};

for (const [scenario, shots] of Object.entries(SHOTS)) {
  const wanted = shots.filter(([name]) => `${scenario}-${name}`.includes(FILTER));
  if (!wanted.length) continue;
  await withApp(scenario, async (page, cdp) => {
    for (const [w, h] of SIZES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
      await sleep(300);
      for (const [name, setup] of wanted) {
        await reset(page);
        try {
          await setup(page);
          await sleep(350);
          await page.screenshot({ path: path.join(OUT, `${scenario}-${name}-${w}x${h}.png`) });
        } catch (err) {
          console.error(`${scenario}-${name} ${w}x${h}: ${err.message.split('\n')[0]}`);
        }
        await page.evaluate(() => document.querySelectorAll('.bd-card.dragging').forEach((n) => n.dispatchEvent(new DragEvent('dragend', { bubbles: true }))));
      }
    }
  });
}
console.log(`screenshots in ${OUT}`);
