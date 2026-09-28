#!/bin/sh
# Runs the runner until it is stopped: ./run.sh --help
#
# Exit 3 means the runner installed an update: start the new version.
# Exit 78 means the runner was removed from Puck; systemd does not restart
# it (RestartPreventExitStatus), and under launchd, which has no such
# setting, it is reported as a clean exit so the LaunchAgent stays down.
# TERM and INT are passed on to the runner, which closes its connections
# and exits; environments keep running.
DIR=$(cd "$(dirname "$0")" && pwd)
child=
trap 'if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; fi' TERM INT
while :; do
  "$DIR/bin/node" "$DIR/bin/puck-runner.js" run "$@" &
  child=$!
  wait "$child"
  code=$?
  # A trapped signal interrupts wait; wait again for the runner's own exit status.
  while kill -0 "$child" 2>/dev/null; do
    wait "$child"
    code=$?
  done
  child=
  if [ "$code" -eq 3 ]; then
    continue
  fi
  if [ "$code" -eq 78 ] && [ "$PUCK_RUNNER_SERVICE" = "launchd" ]; then
    exit 0
  fi
  exit "$code"
done
