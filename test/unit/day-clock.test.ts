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

  it('fires once when sleep jumps past midnight, not on same-day ticks, until stopped', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T22:00:00'));
    const onDayTurn = vi.fn();
    const stop = watchDayRollover(window, onDayTurn);

    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000);
    expect(onDayTurn).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-08-19T08:00:00'));
    vi.advanceTimersByTime(60_000);
    expect(onDayTurn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000);
    expect(onDayTurn).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('focus'));
    expect(onDayTurn).toHaveBeenCalledTimes(2);

    stop();
    window.dispatchEvent(new Event('focus'));
    vi.setSystemTime(new Date('2026-08-20T09:00:00'));
    vi.advanceTimersByTime(60_000);
    expect(onDayTurn).toHaveBeenCalledTimes(2);
  });

  it('fires when the timer reaches the next local midnight, then not again that day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T23:59:00'));
    const onDayTurn = vi.fn();
    const stop = watchDayRollover(window, onDayTurn);

    vi.advanceTimersByTime(59_000);
    expect(onDayTurn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onDayTurn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(onDayTurn).toHaveBeenCalledTimes(1);

    stop();
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(48 * 3_600_000);
    expect(onDayTurn).toHaveBeenCalledTimes(1);
  });
});
