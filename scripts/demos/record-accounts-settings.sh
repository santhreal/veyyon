#!/usr/bin/env bash
# Record the Account Load Balancing off-vs-on settings differential.
#
# A proof is a contrast, not a snapshot. `accounts.loadBalancing` decides whether a session that
# exhausts one account may continue on another account of the SAME provider, which spends a second
# subscription, so the operator has to be able to see and reach the knob. The pair shows the same
# rendered row reading `false` and then `true`:
#   assets/accounts-load-balancing-off.png   the shipped default
#   assets/accounts-load-balancing-on.png    the opt-in
#
# The state is seeded through the real settings store inside the renderer, never by pressing the
# toggle, so a broken keybinding cannot produce a passing capture. The capture path is the real
# component rasterized off-screen (scripts/demos/render-proof.ts) rather than a terminal recording:
# it needs no display and no ttyd, and it renders on BOTH a grey ground and a black one, which is the
# only way an explicit dark fill is visible as a fill rather than as nothing at all. The committed
# pair is the grey ground, since that is the operator's terminal; the black shots stay in the temp
# directory for review.
#
# Run from the repo root:  bash scripts/demos/record-accounts-settings.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
WIDTH="${VEYYON_DEMO_WIDTH:-100}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

shoot() {
	local state="$1" out="$2"
	"$BUN" scripts/demos/render-accounts-settings.ts --balancing "$state" --width "$WIDTH" |
		"$BUN" scripts/demos/render-proof.ts --out "$WORK/accounts-$state" --width "$WIDTH" --scale 2
	cp "$WORK/accounts-$state-grey.png" "$out"
	echo "wrote $out (accounts.loadBalancing=$state)"
}

shoot off assets/accounts-load-balancing-off.png
shoot on assets/accounts-load-balancing-on.png

# A degenerate pair is a failed proof: identical bytes mean the seeding never reached the row.
if cmp -s assets/accounts-load-balancing-off.png assets/accounts-load-balancing-on.png; then
	echo "error: the two shots are byte-identical, so the setting never reached the surface" >&2
	exit 1
fi
echo "done: differential recorded"
