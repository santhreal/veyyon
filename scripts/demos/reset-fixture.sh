#!/usr/bin/env bash
# Restore the complete tracked demo fixture between recordings.
#
# The pristine snapshot owns source and root metadata. Generated dependency and
# language-server state is removed explicitly so one recording cannot change
# the next recording's tool availability or project root.
# Git-backed fixtures seed from HEAD, never from an already-dirty working copy.
set -euo pipefail

DEMO_CWD="${VEYYON_DEMO_CWD:-$HOME/orbit}"
PRISTINE="${VEYYON_DEMO_PRISTINE:-${DEMO_CWD%/}-pristine}"

if [[ ! -d "$PRISTINE" ]]; then
  mkdir -p "$PRISTINE"
  if git -C "$DEMO_CWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$DEMO_CWD" archive HEAD | tar -x -C "$PRISTINE"
  else
    cp -r "$DEMO_CWD/src" "$PRISTINE/src"
    [[ ! -f "$DEMO_CWD/package.json" ]] || cp "$DEMO_CWD/package.json" "$PRISTINE/package.json"
    [[ ! -f "$DEMO_CWD/README.md" ]] || cp "$DEMO_CWD/README.md" "$PRISTINE/README.md"
  fi
  echo "seeded pristine fixture at $PRISTINE"
fi

rm -rf "$DEMO_CWD/src" "$DEMO_CWD/node_modules"
cp -r "$PRISTINE/src" "$DEMO_CWD/src"
for file in package.json README.md tsconfig.json lsp.json bun.lock bun.lockb; do
  rm -f "$DEMO_CWD/$file"
  [[ ! -f "$PRISTINE/$file" ]] || cp "$PRISTINE/$file" "$DEMO_CWD/$file"
done
echo "restored complete fixture from $PRISTINE"
