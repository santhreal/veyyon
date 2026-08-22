#!/usr/bin/env bash
# Record the Resources tab's write-budget off-vs-on settings differential.
#
# A proof is a contrast, not a snapshot. Before this tab existed, the only limit on what a session
# could consume was `session.cpuLimitCores`, under Shell in a group called "CPU Limit"; a budget an
# operator cannot find is a budget nobody sets. The pair shows the Disk group in both states:
#   <out>/resources-write-budget-off.png   the shipped default: the budget row alone, reading Off
#   <out>/resources-write-budget-on.png    a real budget, plus the kill policy it makes meaningful
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
# it needs no display, and it renders on BOTH a grey ground and a black one. Attach the
# resulting pair to the pull request body; evidence pairs are never committed.
#
# VEYYON_DEMO_OUT overrides the output directory (defaults to .captures/resources-settings).
#
# Run from the repo root:  bash scripts/demos/record-resources-settings.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
WIDTH="${VEYYON_DEMO_WIDTH:-100}"
WORK="$(mktemp -d)"
OUT="${VEYYON_DEMO_OUT:-.captures/resources-settings}"
mkdir -p "$OUT"
trap 'rm -rf "$WORK"' EXIT

shoot() {
	local state="$1" out="$2"
	"$BUN" scripts/demos/render-resources-settings.ts --budget "$state" --width "$WIDTH" |
		"$BUN" scripts/demos/render-proof.ts --out "$WORK/resources-$state" --width "$WIDTH" --scale 2
	cp "$WORK/resources-$state-grey.png" "$out"
	echo "wrote $out (session.writeBudgetGb=$state)"
}

shoot off "$OUT/resources-write-budget-off.png"
shoot on "$OUT/resources-write-budget-on.png"

# A degenerate pair is a failed proof: identical bytes mean the seeding never reached the rows.
if cmp -s "$OUT/resources-write-budget-off.png" "$OUT/resources-write-budget-on.png"; then
	echo "error: the two shots are byte-identical, so the setting never reached the surface" >&2
	exit 1
fi
echo "done: differential recorded"
