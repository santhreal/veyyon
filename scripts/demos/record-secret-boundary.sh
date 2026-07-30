#!/usr/bin/env bash
# Record the provider-bound secret proof against a throwaway project vault.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_CWD="$(mktemp -d /tmp/veyyon-secret-demo.XXXXXX)"
trap 'rm -rf "$DEMO_CWD"' EXIT

mkdir -p "$DEMO_CWD/.veyyon" "$DEMO_CWD/src"
printf 'export const demo = true;\n' > "$DEMO_CWD/src/index.ts"
printf '{"name":"veyyon-secret-demo","private":true,"type":"module"}\n' > "$DEMO_CWD/package.json"

export VEYYON_DEMO_CWD="$DEMO_CWD"
export VEYYON_DEMO_PROFILE="${VEYYON_DEMO_PROFILE:-demo}"
export VEYYON_DEMO_SECRET="veyyon-demo-value-not-a-real-credential"

cd "$REPO_ROOT"
bash scripts/demos/setup-profile.sh >/dev/null
DEMO_PROFILE_DIR="${VEYYON_HOME:-$HOME/.veyyon}/profiles/$VEYYON_DEMO_PROFILE/agent"
rm -f -- "$DEMO_PROFILE_DIR/secret-audit.jsonl" "$DEMO_PROFILE_DIR/secret-audit.jsonl.1"
vhs assets/tapes/secret-boundary.tape
bash scripts/demos/setup-profile.sh >/dev/null
printf 'wrote assets/demo-secret-boundary.gif using throwaway project %s\n' "$DEMO_CWD"
