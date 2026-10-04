/**
 * Every Docker timeout on the runner, in one table: the guard the client
 * puts on each docker command (`client.ts`, read by `ops.ts` and
 * `health.ts`), Docker's own stop grace, and the login-shell probe that
 * locates the CLI (`discovery.ts`). A leaf module, so each of them reads
 * it without an import cycle.
 */

export const TIMEOUTS = {
  /** A command that names no timeout of its own: a wedged engine must produce an error, not a hang. */
  default: 20_000,
  /** `docker info`, the health check. */
  info: 20_000,
  inspect: 20_000,
  pull: 30 * 60_000,
  build: 30 * 60_000,
  volume: 30_000,
  create: 60_000,
  copy: 120_000,
  start: 60_000,
  /** Docker's grace for `docker stop -t` before it kills the container. */
  stopGrace: 30_000,
  /** `docker stop`: the grace plus slack. */
  stop: 45_000,
  remove: 60_000,
  list: 20_000,
  /** `$SHELL -lc 'command -v docker'`: bounded, so a slow rc file cannot hang the runner's start. */
  loginShell: 8_000,
};
