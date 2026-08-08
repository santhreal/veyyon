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

vhs assets/tapes/account-manager.tape

printf 'wrote assets/demo-account-manager.gif and the account-manager screenshots under a throwaway home\n'
