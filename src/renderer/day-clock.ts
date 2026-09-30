/**
 * The day clock: tells the window when the local calendar day turns, so
 * labels such as "Today" and "Yesterday" can be recomputed.
 *
 * A timer re-arms at the sooner of the next local midnight and a short
 * cap. When it runs, it calls `onDayTurn` only if the local day key
 * differs from the one seen at the last check, so a wall-clock jump
 * after sleep is noticed within one cap, then re-arms. Window focus
 * calls `onDayTurn` as well; a repeated call just relabels.
 */

import { dayKey } from './format';

/** Milliseconds from `now` to the next local midnight (always > 0, DST-aware). */
export function msUntilNextDay(now: number): number {
  return new Date(now).setHours(24, 0, 0, 0) - now;
}

const DAY_CHECK_CAP_MS = 60_000;

type ClockWindow = Pick<Window, 'setTimeout' | 'clearTimeout' | 'addEventListener' | 'removeEventListener'>;

/** Call `onDayTurn` when the local day changes, and on window focus. Returns a stop function. */
export function watchDayRollover(win: ClockWindow, onDayTurn: () => void, now: () => number = Date.now): () => void {
  let timer: ReturnType<Window['setTimeout']> | undefined;
  let seen = dayKey(now());
  const arm = (): void => {
    if (timer !== undefined) win.clearTimeout(timer);
    const at = now();
    timer = win.setTimeout(onTimer, Math.min(msUntilNextDay(at), DAY_CHECK_CAP_MS));
  };
  function onTimer(): void {
    const key = dayKey(now());
    if (key !== seen) {
      seen = key;
      onDayTurn();
    }
    arm();
  }
  function onFocus(): void {
    seen = dayKey(now());
    onDayTurn();
    arm();
  }
  win.addEventListener('focus', onFocus);
  arm();
  return () => {
    win.removeEventListener('focus', onFocus);
    if (timer !== undefined) win.clearTimeout(timer);
  };
}
