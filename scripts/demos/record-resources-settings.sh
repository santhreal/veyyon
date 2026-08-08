#!/usr/bin/env bash
# Record the Resources tab's write-budget off-vs-on settings differential.
#
# A proof is a contrast, not a snapshot. Before this tab existed, the only limit on what a session
# could consume was `session.cpuLimitCores`, under Shell in a group called "CPU Limit"; a budget an
# operator cannot find is a budget nobody sets. The pair shows the Disk group in both states:
#   assets/resources-write-budget-off.png   the shipped default: the budget row alone, reading Off
#   assets/resources-write-budget-on.png    a real budget, plus the kill policy it makes meaningful
#
# The second half of that contrast is the point. `Kill Over-Budget Writers` decides what happens to a
# budget that does not exist while the budget is 0, so it carries `condition: "writeBudgetEnabled"`
# and appears only in the `on` shot. `Session CPU Limit`, `Session Memory Limit` and `Max Processes`
# are NOT dependents of the write budget and keep their rows in both states, which is what makes the
# absence readable as a condition rather than as an empty tab.
#
# The state is seeded through the real settings store inside the renderer, never by pressing the row,
# so a broken keybinding cannot produce a passing capture. The capture path is the real component
# rasterized off-screen (scripts/demos/render-proof.ts) rather than a terminal recording: it needs no
# display and no ttyd, and it renders on BOTH a grey ground and a black one. The committed pair is
# the grey ground, since that is the operator's terminal; the black shots stay in the temp directory
# for review.
#
# Run from the repo root:  bash scripts/demos/record-resources-settings.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
WIDTH="${VEYYON_DEMO_WIDTH:-100}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

shoot() {
	local state="$1" out="$2"
	"$BUN" scripts/demos/render-resources-settings.ts --budget "$state" --width "$WIDTH" |
		"$BUN" scripts/demos/render-proof.ts --out "$WORK/resources-$state" --width "$WIDTH" --scale 2
	cp "$WORK/resources-$state-grey.png" "$out"
	echo "wrote $out (session.writeBudgetGb=$state)"
}

shoot off assets/resources-write-budget-off.png
shoot on assets/resources-write-budget-on.png

# A degenerate pair is a failed proof: identical bytes mean the seeding never reached the rows.
if cmp -s assets/resources-write-budget-off.png assets/resources-write-budget-on.png; then
	echo "error: the two shots are byte-identical, so the setting never reached the surface" >&2
	exit 1
fi
echo "done: differential recorded"
