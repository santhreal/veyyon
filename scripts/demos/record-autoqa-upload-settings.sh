#!/usr/bin/env bash
# Record the per-profile Auto QA upload disabled-vs-enabled settings differential.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
PROFILE="${VEYYON_DEMO_PROFILE:-demo}"
TAPE="assets/tapes/autoqa-upload-settings.tape"
SHOT="assets/.autoqa-upload-settings-shot.png"

bash scripts/demos/setup-profile.sh >/dev/null

set_autoqa() {
	( cd packages/coding-agent && "$BUN" src/cli.ts --profile "$PROFILE" config set dev.autoqa "$1" >/dev/null )
}

shoot() {
	local enabled="$1" out="$2"
	set_autoqa "$enabled"
	rm -f "$SHOT"
	vhs "$TAPE"
	if [[ ! -f "$SHOT" ]]; then
		echo "error: $TAPE did not produce $SHOT" >&2
		exit 1
	fi
	mv "$SHOT" "$out"
	echo "wrote $out (dev.autoqa=$enabled)"
}

shoot false assets/autoqa-upload-settings-off.png
shoot true assets/autoqa-upload-settings-on.png
set_autoqa false
rm -f assets/.autoqa-upload-settings-shot.gif
echo "done: differential recorded, Auto QA restored to off"
