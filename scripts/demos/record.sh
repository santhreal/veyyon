#!/usr/bin/env bash
# Record the demo gifs from the committed vhs tapes.
#
#   scripts/demos/record.sh                       # record every tape in assets/tapes/
#   scripts/demos/record.sh argot-settings        # only the named tapes
#
# Every remaining tape drives a settings or onboarding surface, and navigation makes
# no model call, so all of them record offline. The provider preflight this script
# used to run went with the one live tape: the workflow rows are recorded by
# scripts/demos/record-hd-demo.sh against a local model instead.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

tapes=("$@")
if [[ ${#tapes[@]} -eq 0 ]]; then
  for t in assets/tapes/*.tape; do tapes+=("$(basename "$t" .tape)"); done
fi

bash scripts/demos/setup-profile.sh >/dev/null

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
    *)
      bash scripts/demos/reset-fixture.sh >/dev/null
      vhs "$tape"
      bash scripts/demos/reset-fixture.sh >/dev/null
      ;;
  esac
done
echo ">> done"
