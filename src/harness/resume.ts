/**
 * Recognizing "this resume id no longer resolves" harness errors. Shared by
 * the app's turn routing and the environment daemon's turns, which both
 * retry such a turn once with a fresh session instead of surfacing the error.
 */

/** Provider errors that mean "this resume id no longer resolves". Claude
 *  reports a dead resume as an opaque `error_during_execution` before any
 *  content, so that counts too (callers must require a resumed, content-free
 *  attempt — a genuine mid-work failure never matches). */
const STALE_RESUME_RE =
  /no conversation found|no rollout found|resume failed|failed to resume|(session|thread|conversation).{0,40}not found|unknown (session|thread)|does not exist|error_during_execution/i;

export function isStaleResumeError(message: string): boolean {
  return STALE_RESUME_RE.test(message);
}
