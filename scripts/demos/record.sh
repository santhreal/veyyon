#!/usr/bin/env bash
# Record the demo gifs from the committed vhs tapes.
#
#   scripts/demos/record.sh            # record every tape in assets/tapes/
#   scripts/demos/record.sh hero edit  # record only the named tapes
#
# Each editing demo starts from a pristine fixture so recordings are
# reproducible. Requires: vhs on PATH, and the demo profile authenticated with
# Gemini 3.6 Flash (see VEYYON_DEMO_* in launch.sh). Preflight refuses to
# record if the pinned model does not resolve — no silent 3.5 fallback.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

MODEL="${VEYYON_DEMO_MODEL:-google-antigravity/gemini-3.6-flash}"
THINKING="${VEYYON_DEMO_THINKING:-high}"
PROFILE="${VEYYON_DEMO_PROFILE:-work}"
VEYYON_BIN="${VEYYON_DEMO_BIN:-veyyon}"

echo ">> preflight: $PROFILE / $MODEL / thinking=$THINKING"
if ! out="$("$VEYYON_BIN" --profile "$PROFILE" --model "$MODEL" --thinking "$THINKING" -p "reply with exactly: ok" 2>&1)"; then
  echo "$out" >&2
  echo "demo model did not resolve. Run: $VEYYON_BIN --profile $PROFILE models refresh" >&2
  exit 1
fi
if ! grep -qi 'ok' <<<"$out"; then
  echo "$out" >&2
  echo "demo model preflight did not return ok" >&2
  exit 1
fi
echo ">> preflight ok"

tapes=("$@")
if [[ ${#tapes[@]} -eq 0 ]]; then
  for t in assets/tapes/*.tape; do tapes+=("$(basename "$t" .tape)"); done
fi

for name in "${tapes[@]}"; do
  tape="assets/tapes/$name.tape"
  [[ -f "$tape" ]] || { echo "no such tape: $tape" >&2; exit 1; }
  echo ">> recording $name"
  bash scripts/demos/reset-fixture.sh >/dev/null
  vhs "$tape"
done
echo ">> done"
