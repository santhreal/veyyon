#!/usr/bin/env bash
# Record the per-agent nested spawn depth inherit-vs-override differential.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
PROFILE="${VEYYON_DEMO_PROFILE:-demo}"
TAPE="assets/tapes/subagent-recursion-settings.tape"
SHOT="assets/.subagent-recursion-settings-shot.png"

bash scripts/demos/setup-profile.sh >/dev/null

set_agents() {
	( cd packages/coding-agent && "$BUN" src/cli.ts --profile "$PROFILE" config set subagent.agents "$1" >/dev/null )
}

shoot() {
	local agents="$1" out="$2" label="$3"
	set_agents "$agents"
	rm -f "$SHOT"
	vhs "$TAPE"
	if [[ ! -f "$SHOT" ]]; then
		echo "error: $TAPE did not produce $SHOT" >&2
		exit 1
	fi
	mv "$SHOT" "$out"
	echo "wrote $out ($label)"
}

shoot '{}' assets/subagent-recursion-settings-inherit.png "designer inherits blanket depth"
shoot '{"designer":{"maxNestedSpawnDepth":2}}' assets/subagent-recursion-settings-override.png "designer override=2"
set_agents '{}'
rm -f assets/.subagent-recursion-settings-shot.gif
echo "done: differential recorded, subagent agent table restored"
