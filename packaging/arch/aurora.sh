#!/bin/sh
# Aurora in the terminal: `aurora` (TUI), `aurora status`, `aurora pick`. See `aurora --help`.
# The data folder is only read for local.key, so the CLI works when the owner lock is on.
: "${SOCIAL_READER_DATA:=${XDG_DATA_HOME:-$HOME/.local/share}/aurora}"
export SOCIAL_READER_DATA
exec node "${AURORA_LIB:-/usr/lib/aurora}/cli/aurora.ts" "$@"
