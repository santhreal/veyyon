#!/usr/bin/env bash
# Record the demo gifs from the committed vhs tapes.
#
#   scripts/demos/record.sh            # record every tape in assets/tapes/
#   scripts/demos/record.sh install lsp-refactor   # only the named tapes
#
# Each editing demo starts from a pristine fixture so recordings are
# reproducible. Live tapes require the demo profile authenticated with Gemini
# 3.6 Flash. Offline tapes skip the provider preflight. A missing pinned model
# fails before any live recording, with no silent 3.5 fallback.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

MODEL="${VEYYON_DEMO_MODEL:-google-antigravity/gemini-3.6-flash}"
THINKING="${VEYYON_DEMO_THINKING:-high}"
PROFILE="${VEYYON_DEMO_PROFILE:-demo}"

tapes=("$@")
if [[ ${#tapes[@]} -eq 0 ]]; then
  for t in assets/tapes/*.tape; do tapes+=("$(basename "$t" .tape)"); done
fi

bash scripts/demos/setup-profile.sh >/dev/null

needs_model=false
for name in "${tapes[@]}"; do
  case "$name" in
    lsp-refactor|context-compaction)
      needs_model=true
      ;;
  esac
done

if [[ "$needs_model" == true ]]; then
  echo ">> preflight: $PROFILE / $MODEL / thinking=$THINKING"
  if ! out="$(VEYYON_DEMO_PROFILE="$PROFILE" bash scripts/demos/launch.sh -p "reply with exactly: ok" 2>&1)"; then
    echo "$out" >&2
    echo "demo model did not resolve. Run: bun packages/coding-agent/src/cli.ts --profile $PROFILE models refresh" >&2
    exit 1
  fi
  if ! grep -qi 'ok' <<<"$out"; then
    echo "$out" >&2
    echo "demo model preflight did not return ok" >&2
    exit 1
  fi
  echo ">> preflight ok"
else
  echo ">> offline recording: provider preflight skipped"
fi

for name in "${tapes[@]}"; do
  tape="assets/tapes/$name.tape"
  [[ -f "$tape" ]] || { echo "no such tape: $tape" >&2; exit 1; }
  echo ">> recording $name"
  case "$name" in
    argot-settings)
      bash scripts/demos/record-argot-settings.sh
      ;;
    autoqa-upload-settings)
      bash scripts/demos/record-autoqa-upload-settings.sh
      ;;
    subagent-recursion-settings)
      bash scripts/demos/record-subagent-recursion-settings.sh
      ;;
    install)
      bash scripts/demos/record-install.sh
      ;;
    lsp-refactor)
      bash scripts/demos/reset-fixture.sh >/dev/null
      bash scripts/demos/prepare-lsp-fixture.sh >/dev/null
      vhs "$tape"
      bash scripts/demos/reset-fixture.sh >/dev/null
      ;;
    *)
      bash scripts/demos/reset-fixture.sh >/dev/null
      vhs "$tape"
      bash scripts/demos/reset-fixture.sh >/dev/null
      ;;
  esac
done
echo ">> done"
