#!/usr/bin/env bash
# Launch veyyon for demo recording.
#
# The .tape files call this instead of spelling out the bun path, profile,
# model, and repo on every line, so the recording setup lives in one place.
# Override any of these with the VEYYON_DEMO_* env vars before running vhs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUN="${VEYYON_DEMO_BUN:-$HOME/.bun/bin/bun}"
DEMO_CWD="${VEYYON_DEMO_CWD:-$HOME/orbit}"
# Pin the collapsed Antigravity family (wire tiers gemini-3.6-flash-{low,medium,high}).
# Without --thinking, requestModelId stays on -low; demos pin high so the capture
# actually uses gemini-3.6-flash-high. Profile defaults to `work` (authenticated
# antigravity on this fleet); override with VEYYON_DEMO_PROFILE if needed.
# If resolve fails with "not found", run: veyyon --profile "$PROFILE" models refresh
MODEL="${VEYYON_DEMO_MODEL:-google-antigravity/gemini-3.6-flash}"
THINKING="${VEYYON_DEMO_THINKING:-high}"
PROFILE="${VEYYON_DEMO_PROFILE:-work}"

# Open straight into the composer, never the first-run setup wizard. The demo
# profile has never been onboarded (setupVersion 0), so without this every
# recording would capture the "Set up your providers" wizard instead of the
# feature. VEYYON_SKIP_SETUP skips onboarding for this launch only, without
# mutating the profile's stored setupVersion (see selectSetupScenes).
export VEYYON_SKIP_SETUP="${VEYYON_SKIP_SETUP:-1}"

cd "$REPO_ROOT/packages/coding-agent"
exec "$BUN" src/cli.ts \
  --profile "$PROFILE" \
  --model "$MODEL" \
  --thinking "$THINKING" \
  --cwd "$DEMO_CWD" \
  "$@"
