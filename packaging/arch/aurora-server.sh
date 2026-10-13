#!/bin/sh
# Start the Aurora server. Data lives in $XDG_DATA_HOME/aurora (default ~/.local/share/aurora),
# private to you; the server listens on 127.0.0.1 unless you say otherwise.
set -e
: "${SOCIAL_READER_DATA:=${XDG_DATA_HOME:-$HOME/.local/share}/aurora}"
: "${HOST:=127.0.0.1}"
: "${PORT:=4317}"
NODE_ENV=production
export SOCIAL_READER_DATA HOST PORT NODE_ENV
umask 077
mkdir -p "$SOCIAL_READER_DATA"
exec node "${AURORA_LIB:-/usr/lib/aurora}/server/main.ts" "$@"
