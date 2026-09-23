import { describe, expect, it } from 'vitest';
import { fmtTokens, relTime } from '../../src/renderer/format';

describe('fmtTokens', () => {
  it('keeps small counts verbatim', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(999)).toBe('999');
  });
  it('abbreviates thousands without trailing zeros', () => {
    expect(fmtTokens(1000)).toBe('1k');
    expect(fmtTokens(41181)).toBe('41.2k');
  });
});

describe('relTime', () => {
  it('buckets recency', () => {
    expect(relTime(Date.now() - 10_000)).toBe('just now');
    expect(relTime(Date.now() - 5 * 60_000)).toBe('5m ago');
    expect(relTime(Date.now() - 3 * 3_600_000)).toBe('3h ago');
  });
});
