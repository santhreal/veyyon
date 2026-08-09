#!/usr/bin/env bash
# Launch veyyon for the account manager recording.
#
# Separate from launch.sh for two reasons. The recording runs under a throwaway HOME, so there is
# no models cache to resolve a pinned demo model against, and pinning one would fail at startup for
# a card that never talks to a model. And every outbound request has to fail instantly: the seeded
# tokens are fabricated, so a live health probe would spend the recording waiting on a real
# provider for answers it cannot get.
#
# Run: bash scripts/demos/launch-accounts.sh
#
# assets/tapes/account-manager.tape types that exact line; run it directly to check the
# seeded accounts before spending a recording on them.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
DEMO_CWD="${VEYYON_DEMO_CWD:?the recorder owns the throwaway project directory}"
PROFILE="${VEYYON_DEMO_PROFILE:-demo}"

export VEYYON_SKIP_SETUP="${VEYYON_SKIP_SETUP:-1}"
# A closed port, so every provider request refuses immediately instead of timing out. The card's
# health probe is expected to fail here; what the recording is about is the layout it reports it in.
export HTTPS_PROXY="http://127.0.0.1:9"
export HTTP_PROXY="http://127.0.0.1:9"

cd "$REPO_ROOT/packages/coding-agent"
exec "$BUN" src/cli.ts --profile "$PROFILE" --cwd "$DEMO_CWD" "$@"
