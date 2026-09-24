// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { PuckBridge } from '../../src/harness/bridge';
import { initSupportView, type SupportElements } from '../../src/renderer/settings/support';

function mount(bridgeOver: Partial<PuckBridge> = {}, withBridge = true) {
  const bridge = withBridge
    ? ({
        supportInfo: vi.fn(async () => ({
          version: '0.0.1',
          dataDir: '/Users/me/Library/Application Support/Puck',
          logFile: '/Users/me/Library/Application Support/Puck/logs/puck.log',
        })),
        supportExport: vi.fn(async () => ({ path: '/Users/me/Downloads/puck-support-x.zip' })),
        ...bridgeOver,
      } as unknown as PuckBridge)
    : undefined;
  const els = {
    version: document.createElement('dd'),
    dataDir: document.createElement('dd'),
    logFile: document.createElement('dd'),
    exportBtn: document.createElement('button'),
    msg: document.createElement('div'),
  } satisfies SupportElements;
  const view = initSupportView({ bridge, els });
  return { bridge, els, view };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('support view', () => {
  it('renders version and data paths from main', async () => {
    const { els, view } = mount();
    await view.render();
    expect(els.version.textContent).toBe('0.0.1');
    expect(els.dataDir.textContent).toBe('/Users/me/Library/Application Support/Puck');
    expect(els.logFile.textContent).toBe('/Users/me/Library/Application Support/Puck/logs/puck.log');
  });

  it('exports on click, disables the button meanwhile, and shows the saved path', async () => {
    let resolve!: (v: { path: string | null }) => void;
    const supportExport = vi.fn(() => new Promise<{ path: string | null }>((r) => (resolve = r)));
    const { els } = mount({ supportExport });
    els.exportBtn.click();
    expect(els.exportBtn.disabled).toBe(true);
    resolve({ path: '/Users/me/Downloads/puck-support-x.zip' });
    await settle();
    expect(supportExport).toHaveBeenCalledTimes(1);
    expect(els.exportBtn.disabled).toBe(false);
    expect(els.msg.textContent).toBe('Saved /Users/me/Downloads/puck-support-x.zip');
    expect(els.msg.classList.contains('ok')).toBe(true);
  });

  it('says so when the dialog was canceled, and shows the error when main fails', async () => {
    const canceled = mount({ supportExport: vi.fn(async () => ({ path: null })) });
    canceled.els.exportBtn.click();
    await settle();
    expect(canceled.els.msg.textContent).toBe('Export canceled.');
    expect(canceled.els.msg.classList.contains('ok')).toBe(false);

    const failing = mount({ supportExport: vi.fn(async () => Promise.reject(new Error('disk full'))) });
    failing.els.exportBtn.click();
    await settle();
    expect(failing.els.msg.textContent).toBe('disk full');
    expect(failing.els.exportBtn.disabled).toBe(false);
  });

  it('does nothing without a bridge', async () => {
    const { els, view } = mount({}, false);
    await view.render();
    els.exportBtn.click();
    await settle();
    expect(els.msg.textContent).toBe('');
    expect(els.version.textContent).toBe('');
  });
});
