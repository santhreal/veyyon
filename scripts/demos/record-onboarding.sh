#!/usr/bin/env bash
# Record the onboarding walkthrough and regenerate its committed render proofs.
#
# Runs the VHS tape that steps through all five setup scenes, then regenerates
# the grey and black PNG pair for each scene through render-proof.ts. Both halves
# drive the real SetupWizardComponent, so what lands in assets/ is the
# component's own output rather than a mock-up of its layout.
#
# The pair matters: an explicit dark fill is invisible on a black ground and
# reads as a slab on a grey one, so one ground answers half the question. The
# wizard is supposed to paint no ground at all, which is what the pair proves.
#
# Needs vhs on PATH. VEYYON_DEMO_BUN overrides the interpreter.
#
# Run:
#     bash scripts/demos/record-onboarding.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
TAPE="assets/tapes/setup-onboarding.tape"
SCENES=(providers subagents glyphs theme import)

rm -f assets/.setup-onboarding-providers.png assets/.setup-onboarding-import.png
vhs "$TAPE"

for state in providers import; do
	shot="assets/.setup-onboarding-$state.png"
	if [[ ! -f "$shot" ]]; then
		echo "error: $TAPE did not produce $shot" >&2
		exit 1
	fi
	mv "$shot" "assets/setup-onboarding-$state.png"
done

mkdir -p assets/onboarding
for scene in "${SCENES[@]}"; do
	env -u NO_COLOR FORCE_COLOR=3 "$BUN" scripts/demos/render-setup-wizard.ts \
		--width 100 --rows 30 --scene "$scene" |
		"$BUN" scripts/demos/render-proof.ts \
			--out "assets/onboarding/setup-$scene-after" --width 100 --scale 3
done

echo "done: onboarding tape and per-scene grey/black render proofs recorded"
