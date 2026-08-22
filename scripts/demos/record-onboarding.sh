#!/usr/bin/env bash
# Record the onboarding walkthrough's render proofs for a pull request.
#
# Renders the grey and black PNG pair for each of the five setup scenes through
# render-proof.ts. Every frame drives the real SetupWizardComponent, so what
# comes out is the component's own output rather than a mock-up of its layout.
#
# The pair matters: an explicit dark fill is invisible on a black ground and
# reads as a slab on a grey one, so one ground answers half the question. The
# wizard is supposed to paint no ground at all, which is what the pair proves.
# Output lands outside the tracked tree; evidence pairs are never committed.
#
# VEYYON_DEMO_BUN overrides the interpreter, VEYYON_DEMO_OUT the output directory
# (defaults to .captures/onboarding-proofs).
#
# Run:
#     bash scripts/demos/record-onboarding.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
SCENES=(providers subagents glyphs theme import)

OUT="${VEYYON_DEMO_OUT:-.captures/onboarding-proofs}"
mkdir -p "$OUT"
for scene in "${SCENES[@]}"; do
	env -u NO_COLOR FORCE_COLOR=3 "$BUN" scripts/demos/render-setup-wizard.ts \
		--width 100 --rows 30 --scene "$scene" |
		"$BUN" scripts/demos/render-proof.ts \
			--out "$OUT/setup-$scene-after" --width 100 --scale 3
done

echo "done: per-scene grey/black render proofs recorded in $OUT"
