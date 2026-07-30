#!/usr/bin/env bash
# Record the setup wizard's default-vs-specialists selector differential.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
PROFILE="${VEYYON_DEMO_PROFILE:-demo}"
TAPE="assets/tapes/setup-subagents.tape"

bash scripts/demos/setup-profile.sh >/dev/null
rm -f assets/.setup-subagents-default.png assets/.setup-subagents-specialists.png
VEYYON_DEMO_PROFILE="$PROFILE" vhs "$TAPE"

for state in default specialists; do
	shot="assets/.setup-subagents-$state.png"
	if [[ ! -f "$shot" ]]; then
		echo "error: $TAPE did not produce $shot" >&2
		exit 1
	fi
	mv "$shot" "assets/setup-subagents-$state.png"
done

VEYYON_PROFILE="$PROFILE" "$BUN" scripts/demos/render-setup-subagents.ts --enabled task |
	"$BUN" scripts/demos/render-proof.ts --out assets/setup-subagents-default --width 100 --scale 2
VEYYON_PROFILE="$PROFILE" "$BUN" scripts/demos/render-setup-subagents.ts --enabled task,reviewer,scout |
	"$BUN" scripts/demos/render-proof.ts --out assets/setup-subagents-specialists --width 100 --scale 2

echo "done: selector tape and grey/black render proofs recorded"
