#!/usr/bin/env bash
# Record a real binary installation without touching the maintainer's HOME.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_HOME="$(mktemp -d /tmp/veyyon-install-demo.XXXXXX)"
trap 'rm -rf "$DEMO_HOME"' EXIT

mkdir -p "$DEMO_HOME/home" "$DEMO_HOME/bin"
export HOME="$DEMO_HOME/home"
export VEYYON_INSTALL_DIR="$DEMO_HOME/bin"

cd "$REPO_ROOT"
vhs assets/tapes/install.tape
printf 'wrote assets/install-demo.gif from isolated install root %s\n' "$DEMO_HOME"
