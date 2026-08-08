#!/usr/bin/env bash
# Record the account manager demo against a throwaway HOME and fabricated logins.
#
# The credential store is machine-wide when profile sharing is on, which is the default, so seeding
# accounts into the operator's real HOME would put fabricated logins beside their real ones and a
# per-profile cleanup would never find them. This runs the whole recording under a temporary HOME
# instead: the seeder refuses to run anywhere else, and the directory is removed on exit, so the
# recording cannot outlive itself.
#
# Nothing here talks to a model, and outbound requests are pointed at a closed port, so it records
# offline.
#
# Run:
#     bash scripts/demos/record-account-manager.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_HOME="$(mktemp -d /tmp/veyyon-account-manager-home.XXXXXX)"
DEMO_CWD="$(mktemp -d /tmp/veyyon-account-manager-demo.XXXXXX)"
trap 'rm -rf "$DEMO_HOME" "$DEMO_CWD"' EXIT

mkdir -p "$DEMO_CWD/src"
printf 'export const demo = true;\n' > "$DEMO_CWD/src/index.ts"
printf '{"name":"veyyon-account-manager-demo","private":true,"type":"module"}\n' > "$DEMO_CWD/package.json"

# Exported before anything spawns, because `os.homedir()` is resolved once per process: a child
# that inherits this sees the throwaway home, and assigning it later would not move it.
export HOME="$DEMO_HOME"
export VEYYON_DEMO_CWD="$DEMO_CWD"
export VEYYON_DEMO_PROFILE="${VEYYON_DEMO_PROFILE:-demo}"

cd "$REPO_ROOT"
BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
if [[ ! -x "$BUN" ]]; then
	BUN="$(command -v bun)"
fi
export VEYYON_DEMO_BUN="$BUN"

"$BUN" scripts/demos/seed-account-manager.ts --profile "$VEYYON_DEMO_PROFILE"

# Cleared first, so a step that stops taking its screenshot leaves a MISSING file rather than a
# stale one from the last run that still looks like evidence.
rm -f "$REPO_ROOT"/assets/account-manager-*.png

vhs assets/tapes/account-manager.tape

# A screenshot that is byte-identical to the one BEFORE it is a FAILED proof, not a small blemish:
# it means the step it was taken for never happened, and the picture says otherwise. That shipped
# once here (the `balancing on` frame was a byte-for-byte copy of the sidebar frame, so the one
# artifact proving the toggle proved nothing), so the recording refuses to finish quietly now.
# Checksums rather than a visual read, because the whole failure is that both frames look plausible.
#
# Adjacent frames rather than every pair, because this tape RESTORES state on purpose: it turns
# balancing on and then off again, and the second press is correct precisely when it reproduces the
# frame from before the first one. A step that did not land reproduces its immediate predecessor,
# which is the comparison that carries the signal.
prev_sum=""
prev_name=""
degenerate=0
while read -r sum name; do
	if [[ "$sum" == "$prev_sum" ]]; then
		printf 'recording failed: %s is byte-identical to %s, so that step did not land\n' "$name" "$prev_name" >&2
		degenerate=1
	fi
	prev_sum="$sum"
	prev_name="$name"
done < <(md5sum "$REPO_ROOT"/assets/account-manager-*.png)
if [[ "$degenerate" -ne 0 ]]; then
	exit 1
fi

printf 'wrote assets/demo-account-manager.{gif,mp4} and the account-manager screenshots under a throwaway home\n'
