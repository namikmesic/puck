/**
 * The day clock: tells the window when the local calendar day turns, so
 * labels such as "Today" and "Yesterday" can be recomputed.
 *
 * It fires at the next local midnight, then reschedules from the time it
 * actually ran. Timers stall while the machine sleeps, so it also fires
 * whenever the window regains focus. A fire can be early or repeated; the
 * callback just relabels for the current time.
 */

/** Milliseconds from `now` to the next local midnight (always > 0, DST-aware). */
export function msUntilNextDay(now: number): number {
  return new Date(now).setHours(24, 0, 0, 0) - now;
}

type ClockWindow = Pick<Window, 'setTimeout' | 'clearTimeout' | 'addEventListener' | 'removeEventListener'>;

/** Call `onDayTurn` at each local midnight and on window focus. Returns a stop function. */
export function watchDayRollover(win: ClockWindow, onDayTurn: () => void, now: () => number = Date.now): () => void {
  let timer: ReturnType<Window['setTimeout']> | undefined;
  const schedule = (): void => {
    if (timer !== undefined) win.clearTimeout(timer);
    timer = win.setTimeout(fire, msUntilNextDay(now()));
  };
  function fire(): void {
    onDayTurn();
    schedule();
  }
  win.addEventListener('focus', fire);
  schedule();
  return () => {
    win.removeEventListener('focus', fire);
    if (timer !== undefined) win.clearTimeout(timer);
  };
}
