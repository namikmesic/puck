#!/bin/sh
# Registers this machine with Puck as a runner, or removes it: ./config.sh --help
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
exec "$DIR/bin/node" "$DIR/bin/puck-runner.js" config "$@"
