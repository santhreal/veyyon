#!/usr/bin/env bash
# Look at the setup wizard's default-vs-specialists selector, off-screen.
#
# Renders both selector states through render-proof.ts. Each state drives the real
# setup scene, so what comes out is the component's own output rather than a
# mock-up of its layout, and the grey/black pair is the comparison worth making:
# an explicit dark fill is invisible on a black ground and reads as a slab on a
# grey one. The selector is supposed to paint no ground at all.
#
# THE OUTPUT IS A DEBUGGING AID AND NOT A PROOF, so it goes to a temporary
# directory and never to assets/. It draws a fixture at a chosen width through a
# constructed call: it cannot show that the screen is reachable, that the state is
# real, or that the selector is positioned and clipped the way a session draws it.
# The evidence a settings differential needs is a VHS capture of the real screen --
# see docs/handbook/src/foundations/verification.md, and
# scripts/demos/record-argot-settings.sh for the shape of one.
#
# VEYYON_DEMO_BUN overrides the interpreter, VEYYON_DEMO_PROFILE the demo profile
# and VEYYON_DEMO_OUT the output directory; all three have defaults.
#
# Run:
#     bash scripts/demos/record-setup-subagents.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
PROFILE="${VEYYON_DEMO_PROFILE:-demo}"
OUT="${VEYYON_DEMO_OUT:-$(mktemp -d)}"

bash scripts/demos/setup-profile.sh >/dev/null

VEYYON_PROFILE="$PROFILE" "$BUN" scripts/demos/render-setup-subagents.ts --enabled task |
	"$BUN" scripts/demos/render-proof.ts --out "$OUT/setup-subagents-default" --width 100 --scale 2
VEYYON_PROFILE="$PROFILE" "$BUN" scripts/demos/render-setup-subagents.ts --enabled task,reviewer,scout |
	"$BUN" scripts/demos/render-proof.ts --out "$OUT/setup-subagents-specialists" --width 100 --scale 2

echo "done: selector grey/black renders in $OUT"
