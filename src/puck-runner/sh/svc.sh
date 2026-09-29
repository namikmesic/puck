#!/bin/sh
# Runs the runner as a service (systemd on Linux, a LaunchAgent on macOS): ./svc.sh --help
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
exec "$DIR/bin/node" "$DIR/bin/puck-runner.cjs" svc "$@"
