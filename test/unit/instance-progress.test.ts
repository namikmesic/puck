// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { composerGate, createTicker, pinText, progressLine, statusChip, statusWord, toneOf } from '../../src/renderer/instance-progress';
import { instance } from './v2-fixtures';

describe('instance progress', () => {
  it('reads the op first, then the attach, then the daemon', () => {
    const starting = instance({ op: { kind: 'starting', stage: 'pulling-image', detail: '', startedAt: 1_000, error: null } });
    expect(statusWord(starting)).toBe('starting');
    expect(toneOf(starting)).toBe('busy');
    expect(progressLine(starting, 13_000)).toBe('pulling the image · 12s');
    const failed = instance({ op: { kind: 'rebuilding', stage: null, detail: '', startedAt: 1, error: 'no space' } });
    expect(toneOf(failed)).toBe('bad');
    expect(progressLine(failed, 5)).toBe('rebuilding failed: no space');
    expect(toneOf(instance({ attach: 'unreachable' }))).toBe('off');
    expect(statusWord(instance({ attach: 'unreachable' }))).toBe('unreachable');
    expect(toneOf(instance(), { status: 'provisioning', stage: 'installing-clis', detail: 'npm i' })).toBe('busy');
    expect(progressLine(instance(), 0, { status: 'provisioning', stage: 'installing-clis', detail: 'npm i' })).toBe('installing harness CLIs · npm i');
    expect(toneOf(instance({ status: 'lost' }))).toBe('off');
    expect(statusWord(instance({ status: 'lost' }))).toBe('runner removed');
    expect(statusWord(instance({ current: false, attach: null, daemon: null }))).toBe('not open');
  });

  it('builds a toned chip and pin text', () => {
    const chip = statusChip(instance());
    expect(chip.className).toBe('status tone-on on');
    expect(chip.textContent).toBe('ready');
    expect(pinText({ kind: 'tag', name: 'v1.4.0', sha: 'a1b2c3d4e5' })).toBe('v1.4.0 (a1b2c3d)');
    expect(pinText({ kind: 'commit', name: 'x', sha: 'a1b2c3d4e5' })).toBe('a1b2c3d');
    expect(pinText(null)).toBe('');
  });

  it('opens the composer only when attached and ready', () => {
    expect(composerGate(undefined, null, null).ready).toBe(false);
    expect(composerGate(instance({ attach: 'unreachable' }), null, 'lead').reason).toBe("Can't reach build-box.");
    expect(composerGate(instance({ attach: 'incompatible', attachDetail: 'Update Puck to work in it.' }), null, 'lead').reason).toBe('Update Puck to work in it.');
    expect(composerGate(instance({ attach: 'incompatible' }), null, 'lead').reason).toBe("This environment's daemon needs a newer Puck.");
    expect(composerGate(instance({ attach: 'detached' }), null, null).reason).toBe('Not connected to example.');
    expect(composerGate(instance({ attach: 'detached', name: '' }), null, null).reason).toBe('Not connected to this environment.');
    expect(composerGate(instance({ attach: 'connecting' }), null, null).reason).toBe('Connecting…');
    expect(composerGate(instance({ attach: 'reconnecting' }), null, null).reason).toBe('Connecting…');
    expect(composerGate(instance(), null, 'lead').reason).toBe('Loading…');
    expect(composerGate(instance(), { status: 'provisioning', stage: 'syncing-repos' }, 'lead').reason).toBe('The environment is syncing repositories…');
    expect(composerGate(instance(), { status: 'ready' }, 'lead')).toEqual({ ready: true, placeholder: 'Message lead', reason: '' });
    expect(composerGate(instance(), { status: 'degraded' }, null).ready).toBe(true);
  });

  it('ticks only while busy', () => {
    let busy = true;
    const setI = vi.fn(() => 7 as unknown as ReturnType<typeof setInterval>);
    const clearI = vi.fn();
    const t = createTicker({ busy: () => busy, onTick: () => undefined, setInterval: setI as never, clearInterval: clearI as never });
    t.sync();
    t.sync();
    expect(setI).toHaveBeenCalledTimes(1);
    busy = false;
    t.sync();
    expect(clearI).toHaveBeenCalledWith(7);
    expect(t.running()).toBe(false);
  });
});
