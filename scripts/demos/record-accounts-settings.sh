#!/usr/bin/env bash
# Record the Account Load Balancing off-vs-on settings differential.
#
# A proof is a contrast, not a snapshot. `accounts.loadBalancing` decides whether a session that
# exhausts one account may continue on another account of the SAME provider, which spends a second
# subscription, so the operator has to be able to see and reach the knob. The pair shows the same
# rendered row reading `false` and then `true`:
#   <out>/accounts-load-balancing-off.png   the shipped default
#   <out>/accounts-load-balancing-on.png    the opt-in
#
# The state is seeded through the real settings store inside the renderer, never by pressing the
# toggle, so a broken keybinding cannot produce a passing capture. The capture path is the real
# component rasterized off-screen (scripts/demos/render-proof.ts) rather than a terminal recording:
# it needs no display, and it renders on BOTH a grey ground and a black one. Attach the
# resulting pair to the pull request body; evidence pairs are never committed.
#
# VEYYON_DEMO_OUT overrides the output directory (defaults to .captures/accounts-settings).
#
# Run from the repo root:  bash scripts/demos/record-accounts-settings.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
WIDTH="${VEYYON_DEMO_WIDTH:-100}"
WORK="$(mktemp -d)"
OUT="${VEYYON_DEMO_OUT:-.captures/accounts-settings}"
mkdir -p "$OUT"
trap 'rm -rf "$WORK"' EXIT

shoot() {
	local state="$1" out="$2"
	"$BUN" scripts/demos/render-accounts-settings.ts --balancing "$state" --width "$WIDTH" |
		"$BUN" scripts/demos/render-proof.ts --out "$WORK/accounts-$state" --width "$WIDTH" --scale 2
	cp "$WORK/accounts-$state-grey.png" "$out"
	echo "wrote $out (accounts.loadBalancing=$state)"
}

shoot off "$OUT/accounts-load-balancing-off.png"
shoot on "$OUT/accounts-load-balancing-on.png"

# A degenerate pair is a failed proof: identical bytes mean the seeding never reached the row.
if cmp -s "$OUT/accounts-load-balancing-off.png" "$OUT/accounts-load-balancing-on.png"; then
	echo "error: the two shots are byte-identical, so the setting never reached the surface" >&2
	exit 1
fi
echo "done: differential recorded"
