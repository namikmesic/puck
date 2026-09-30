// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayKey } from '../../src/renderer/format';
import { msUntilNextDay, watchDayRollover } from '../../src/renderer/day-clock';

describe('msUntilNextDay', () => {
  it.each(['2026-08-18T00:00:00', '2026-08-18T13:45:10', '2026-08-18T23:59:59.999', '2026-12-31T23:00:00'])(
    'lands exactly on the next local day from %s',
    (at) => {
      const now = new Date(at).getTime();
      const ms = msUntilNextDay(now);
      expect(ms).toBeGreaterThan(0);
      expect(dayKey(now + ms)).not.toBe(dayKey(now));
      expect(dayKey(now + ms - 1)).toBe(dayKey(now));
    },
  );
});

describe('watchDayRollover', () => {
  afterEach(() => vi.useRealTimers());

  it('fires at each local midnight, on focus, and when the window becomes visible again, until stopped', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T23:59:00'));
    const onDayTurn = vi.fn();
    const stop = watchDayRollover(window, onDayTurn);

    vi.advanceTimersByTime(59_000);
    expect(onDayTurn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onDayTurn).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('focus'));
    expect(onDayTurn).toHaveBeenCalledTimes(2);

    // Waking from sleep with the window frontmost: no focus, only visibilitychange.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(onDayTurn).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(24 * 3_600_000);
    expect(onDayTurn).toHaveBeenCalledTimes(4);

    stop();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(48 * 3_600_000);
    expect(onDayTurn).toHaveBeenCalledTimes(4);
  });
});
