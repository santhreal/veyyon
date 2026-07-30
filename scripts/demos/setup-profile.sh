#!/usr/bin/env bash
# Create the isolated profile used by every committed Veyyon recording.
#
# Run from the repository root:
#   bash scripts/demos/setup-profile.sh
#   bash scripts/demos/setup-profile.sh --refresh
#
# Credentials remain in Veyyon's shared credential store. This script writes
# only the dedicated demo profile's settings.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
PROFILE="${VEYYON_DEMO_PROFILE:-demo}"
MODEL="${VEYYON_DEMO_MODEL:-google-antigravity/gemini-3.6-flash}"
THINKING="${VEYYON_DEMO_THINKING:-high}"
CLI=("$BUN" "$REPO_ROOT/packages/coding-agent/src/cli.ts")
PROFILE_AGENT_DIR="${VEYYON_HOME:-$HOME/.veyyon}/profiles/$PROFILE/agent"

if [[ ! -d "$PROFILE_AGENT_DIR" ]]; then
  "${CLI[@]}" profile new "$PROFILE" --from blank >/dev/null
  echo "created profile: $PROFILE"
fi

"${CLI[@]}" --profile "$PROFILE" config set profile.displayName Demo >/dev/null
"${CLI[@]}" --profile "$PROFILE" config set modelRoles "{\"default\":\"$MODEL\"}" >/dev/null
"${CLI[@]}" --profile "$PROFILE" config set defaultEffort "{\"*\":\"$THINKING\"}" >/dev/null
"${CLI[@]}" --profile "$PROFILE" config set subagent.thinkingLevel "$THINKING" >/dev/null
"${CLI[@]}" --profile "$PROFILE" config set secrets.enabled false >/dev/null

if [[ "${1:-}" == "--refresh" ]]; then
  "${CLI[@]}" --profile "$PROFILE" models refresh >/dev/null
fi

printf 'demo profile ready: %s / %s / thinking=%s\n' "$PROFILE" "$MODEL" "$THINKING"
