#!/usr/bin/env bash
# Restore the ~/orbit demo repo to a clean state between recordings.
#
# Editing demos (the edit tape) change files under the fixture. This restores
# the tracked source from a pristine copy so every recording starts identical,
# without running destructive git on the fixture. The pristine copy is made on
# first run and kept under the scratch dir.
set -euo pipefail

# Keep the pristine copy OUTSIDE the fixture tree, so it never shows up when a
# demo has the agent list or glob the repo.
DEMO_CWD="${VEYYON_DEMO_CWD:-$HOME/orbit}"
PRISTINE="${VEYYON_DEMO_PRISTINE:-${DEMO_CWD%/}-pristine-src}"

if [[ ! -d "$PRISTINE" ]]; then
  cp -r "$DEMO_CWD/src" "$PRISTINE"
  echo "seeded pristine fixture at $PRISTINE"
  exit 0
fi

rm -rf "$DEMO_CWD/src"
cp -r "$PRISTINE" "$DEMO_CWD/src"
echo "restored $DEMO_CWD/src from pristine"
