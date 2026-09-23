// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildSeg, stableJson } from '../../src/renderer/util';

describe('stableJson', () => {
  it('is key-order independent', () => {
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }));
    expect(stableJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested objects but preserves array order', () => {
    expect(stableJson({ x: [{ z: 1, y: 2 }, 3] })).toBe('{"x":[{"y":2,"z":1},3]}');
    expect(stableJson([2, 1])).not.toBe(stableJson([1, 2]));
  });

  it('handles null and undefined', () => {
    expect(stableJson(null)).toBe('null');
    expect(stableJson(undefined)).toBe('null');
    expect(stableJson({ a: null })).toBe('{"a":null}');
  });
});

describe('buildSeg', () => {
  it('renders one pressed segment and moves aria-pressed on click', () => {
    const host = document.createElement('div');
    const picks: string[] = [];
    buildSeg(
      host,
      [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      'a',
      (v) => picks.push(v),
    );
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    buttons[1].click();
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect(picks).toEqual(['b']);
  });

  it('rebuild clears previous segments', () => {
    const host = document.createElement('div');
    buildSeg(host, [{ value: 'a', label: 'A' }], 'a', () => undefined);
    buildSeg(host, [{ value: 'b', label: 'B' }], 'b', () => undefined);
    expect(host.querySelectorAll('button')).toHaveLength(1);
    expect(host.textContent).toBe('B');
  });
});
