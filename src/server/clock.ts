/**
 * The server's only source of time. Every expiry (sessions, registration
 * and removal tokens, runner tokens, assertion replay windows, the Offline
 * threshold, grant re-verification) reads `now()`, and every recurring job
 * goes through `every()`, so tests drive the whole server with a fake clock.
 */

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Runs `fn` every `ms` until the returned function is called. */
  every(ms: number, fn: () => void): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  every(ms, fn) {
    const timer = setInterval(fn, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};

/** A clock that moves only when a test advances it; due jobs run in order. */
export class FakeClock implements Clock {
  private jobs = new Set<{ ms: number; next: number; fn: () => void }>();

  constructor(private t = Date.UTC(2026, 0, 1)) {}

  now(): number {
    return this.t;
  }

  every(ms: number, fn: () => void): () => void {
    const job = { ms, next: this.t + ms, fn };
    this.jobs.add(job);
    return () => {
      this.jobs.delete(job);
    };
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let due: { ms: number; next: number; fn: () => void } | null = null;
      for (const job of this.jobs) if (job.next <= end && (!due || job.next < due.next)) due = job;
      if (!due) break;
      this.t = due.next;
      due.next += due.ms;
      due.fn();
    }
    this.t = end;
  }
}
