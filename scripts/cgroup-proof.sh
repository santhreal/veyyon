#!/usr/bin/env bash
# Run the kernel-enforcement proof for the resource budgets, on THIS host.
#
# See scripts/cgroup-proof.ts for why the proof is a script rather than a test.
# Exits 2 when the host cannot host it, 1 when a cap does not hold.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"
export XDG_RUNTIME_DIR

exec bun scripts/cgroup-proof.ts "$@"
