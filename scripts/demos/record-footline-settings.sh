#!/usr/bin/env bash
# Record the Composer Footline off-vs-on settings differential.
#
# A proof is a contrast, not a snapshot. `statusLine.enabled` decides whether the composer carries
# its quiet metadata row at all, and it ships OFF, so the operator has to be able to see and reach
# the switch. The pair shows the Status Line group in both states:
#   assets/composer-footline-off.png   the shipped default: the toggle alone
#   assets/composer-footline-on.png    the opt-in: the toggle plus the preset it makes meaningful
#
# The second half of that contrast is the point. A knob for a row that is not on screen is a knob
# with nothing behind it, so `Status Line Preset` is hidden by a condition while the footline is off
# and appears only in the `on` shot. `Session Accent` is deliberately NOT part of that group of
# dependents: it colors the editor border, so it keeps its row in both states.
#
# The state is seeded through the real settings store inside the renderer, never by pressing the
# toggle, so a broken keybinding cannot produce a passing capture. The capture path is the real
# component rasterized off-screen (scripts/demos/render-proof.ts) rather than a terminal recording:
# it needs no display and no ttyd, and it renders on BOTH a grey ground and a black one. The
# committed pair is the grey ground, since that is the operator's terminal; the black shots stay in
# the temp directory for review.
#
# Run from the repo root:  bash scripts/demos/record-footline-settings.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
WIDTH="${VEYYON_DEMO_WIDTH:-100}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

shoot() {
	local state="$1" out="$2"
	"$BUN" scripts/demos/render-footline-settings.ts --footline "$state" --width "$WIDTH" |
		"$BUN" scripts/demos/render-proof.ts --out "$WORK/footline-$state" --width "$WIDTH" --scale 2
	cp "$WORK/footline-$state-grey.png" "$out"
	echo "wrote $out (statusLine.enabled=$state)"
}

shoot off assets/composer-footline-off.png
shoot on assets/composer-footline-on.png

# A degenerate pair is a failed proof: identical bytes mean the seeding never reached the rows.
if cmp -s assets/composer-footline-off.png assets/composer-footline-on.png; then
	echo "error: the two shots are byte-identical, so the setting never reached the surface" >&2
	exit 1
fi
echo "done: differential recorded"
