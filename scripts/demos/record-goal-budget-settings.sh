#!/usr/bin/env bash
# Record the default-off versus enabled Model Goal Budgets settings differential for a PR.
# Attach the resulting pair to the pull request body; evidence pairs are never committed.
#
# VEYYON_DEMO_OUT overrides the output directory (defaults to .captures/goal-budget-settings).
#
# Run from the repository root:
#   bash scripts/demos/record-goal-budget-settings.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
PROFILE="${VEYYON_DEMO_PROFILE:-work}"
TAPE="assets/tapes/goal-budget-settings.tape"
SHOT="assets/.goal-budget-settings-shot.png"
OUT="${VEYYON_DEMO_OUT:-.captures/goal-budget-settings}"
mkdir -p "$OUT"

set_goal_budgets() {
	( cd packages/coding-agent && "$BUN" src/cli.ts --profile "$PROFILE" config set goal.modelBudgetsEnabled "$1" >/dev/null )
}

shoot() {
	local enabled="$1" out="$2"
	set_goal_budgets "$enabled"
	rm -f "$SHOT"
	vhs "$TAPE"
	if [[ ! -f "$SHOT" ]]; then
		echo "error: $TAPE did not produce $SHOT" >&2
		exit 1
	fi
	mv "$SHOT" "$out"
	echo "wrote $out (goal.modelBudgetsEnabled=$enabled)"
}

shoot false "$OUT/goal-budget-settings-off.png"
shoot true "$OUT/goal-budget-settings-on.png"
set_goal_budgets false
rm -f assets/.goal-budget-settings-shot.gif
echo "done: differential recorded, Model Goal Budgets restored to off"
