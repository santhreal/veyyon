#!/usr/bin/env bash
# Record the setup wizard's default-vs-specialists selector differential.
#
# Renders both selector states through render-proof.ts, which regenerates the
# committed grey and black PNG pairs. Each state drives the real setup scene, so
# what lands in assets/ is the component's own output rather than a mock-up of
# its layout.
#
# The pair matters: an explicit dark fill is invisible on a black ground and
# reads as a slab on a grey one, so one ground answers half the question. The
# selector is supposed to paint no ground at all, which is what the pair proves.
#
# VEYYON_DEMO_BUN overrides the interpreter and VEYYON_DEMO_PROFILE the demo
# profile; both have defaults.
#
# Run:
#     bash scripts/demos/record-setup-subagents.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
PROFILE="${VEYYON_DEMO_PROFILE:-demo}"

bash scripts/demos/setup-profile.sh >/dev/null

VEYYON_PROFILE="$PROFILE" "$BUN" scripts/demos/render-setup-subagents.ts --enabled task |
	"$BUN" scripts/demos/render-proof.ts --out assets/setup-subagents-default --width 100 --scale 2
VEYYON_PROFILE="$PROFILE" "$BUN" scripts/demos/render-setup-subagents.ts --enabled task,reviewer,scout |
	"$BUN" scripts/demos/render-proof.ts --out assets/setup-subagents-specialists --width 100 --scale 2

echo "done: selector grey/black render proofs recorded"
