#!/usr/bin/env bash
# Record the Argot settings disabled-vs-enabled differential.
#
# A proof is a contrast, not a snapshot. Argot is experimental, so when its
# master toggle (argot.enabled) is off its four dependent knobs are hidden
# completely, and when it is on they appear. This driver seeds each state with
# `veyyon config set`, records the same single-state tape twice, and moves each
# shot into place:
#   assets/argot-settings-off.png  one row  (only "Argot Shorthand")
#   assets/argot-settings-on.png   five rows (the toggle plus its four knobs)
# Argot is restored to off at the end so the repo state is unchanged.
#
# Run from the repo root:  bash scripts/demos/record-argot-settings.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
PROFILE="${VEYYON_DEMO_PROFILE:-work}"
TAPE="assets/tapes/argot-settings.tape"
SHOT="assets/.argot-settings-shot.png"

set_argot() {
	( cd packages/coding-agent && "$BUN" src/cli.ts --profile "$PROFILE" config set argot.enabled "$1" >/dev/null )
}

shoot() {
	local enabled="$1" out="$2"
	set_argot "$enabled"
	rm -f "$SHOT"
	vhs "$TAPE"
	if [[ ! -f "$SHOT" ]]; then
		echo "error: $TAPE did not produce $SHOT" >&2
		exit 1
	fi
	mv "$SHOT" "$out"
	echo "wrote $out (argot.enabled=$enabled)"
}

shoot false assets/argot-settings-off.png
shoot true  assets/argot-settings-on.png
set_argot false
rm -f assets/.argot-settings-shot.gif
echo "done: differential recorded, argot restored to off"
