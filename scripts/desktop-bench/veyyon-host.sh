#!/bin/sh
# The `veyyon` binary veyyon-desktop spawns as `$VEYYON_BIN gui`: this
# checkout's CLI under bun, so the host and the window come from one tree.
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
exec "${BENCH_BUN:-bun}" "${here}/../../packages/coding-agent/src/cli.ts" "$@"
