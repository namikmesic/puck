import { describe, expect, it } from 'vitest';
import { dayLabel, fmtClock, fmtDuration, fmtTime, fmtTokens, fmtUsd, ordinal, relTime } from '../../src/renderer/format';

describe('fmtTokens', () => {
  it('keeps small counts verbatim', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(999)).toBe('999');
  });
  it('abbreviates thousands and millions without trailing zeros', () => {
    expect(fmtTokens(1000)).toBe('1k');
    expect(fmtTokens(41181)).toBe('41.2k');
    expect(fmtTokens(1_250_000)).toBe('1.3M');
  });
});

describe('fmtUsd', () => {
  it('always shows cents, the same way everywhere', () => {
    expect(fmtUsd(0.99)).toBe('$0.99');
    expect(fmtUsd(0.2724)).toBe('$0.27');
    expect(fmtUsd(12.4817)).toBe('$12.48');
    expect(fmtUsd(1204.5)).toBe('$1,204.50');
    expect(fmtUsd(0)).toBe('$0.00');
  });
  it('says a tiny spend is under a cent instead of rounding it away', () => {
    expect(fmtUsd(0.0042)).toBe('<$0.01');
  });
});

describe('fmtDuration', () => {
  it('uses tenths under ten seconds, then the running-clock style', () => {
    expect(fmtDuration(400)).toBe('0.4s');
    expect(fmtDuration(4_210)).toBe('4.2s');
    expect(fmtDuration(38_400)).toBe('38s');
    expect(fmtDuration(73_400)).toBe('1m 13s');
    expect(fmtDuration(3_780_000)).toBe('1h 03m');
  });
});

describe('clock times', () => {
  it('have no leading zero on the hour', () => {
    const at = new Date(2026, 8, 29, 8, 42, 5).getTime();
    expect(fmtTime(at)).not.toMatch(/^0/);
    expect(fmtTime(at)).toMatch(/^8:42/);
    expect(fmtClock(at)).toMatch(/^8:42:05/);
  });
});

describe('dayLabel', () => {
  it('names today and yesterday, then the weekday and date', () => {
    const now = new Date(2026, 8, 29, 12, 0).getTime();
    expect(dayLabel(new Date(2026, 8, 29, 1, 0).getTime(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 8, 28, 23, 0).getTime(), now)).toBe('Yesterday');
    const older = dayLabel(new Date(2026, 8, 26, 9, 0).getTime(), now);
    expect(older).toContain('26');
    expect(older).not.toContain('2026');
    expect(dayLabel(new Date(2025, 11, 31, 9, 0).getTime(), now)).toContain('2025');
  });
});

describe('ordinal', () => {
  it('suffixes like English', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  });
});

describe('relTime', () => {
  it('buckets recency', () => {
    expect(relTime(Date.now() - 10_000)).toBe('just now');
    expect(relTime(Date.now() - 5 * 60_000)).toBe('5m ago');
    expect(relTime(Date.now() - 3 * 3_600_000)).toBe('3h ago');
  });
});
