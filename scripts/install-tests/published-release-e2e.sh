#!/usr/bin/env bash
set -euo pipefail

# The DEFAULT install, on Linux and macOS: what `curl -fsSL https://get.veyyon.dev | sh`
# actually does on a user's machine.
#
# `run-ci.sh` drives the same installer with `--local`, which installs the binary
# the checkout just built. That covers everything the installer does around the
# binary and nothing about how the binary GETS there: the release lookup, the
# download, the `.sha256` verification and the staged preflight had never run on
# Linux or macOS in CI. The release workflow downloads the asset directly and
# checks it, which is a different question — it proves the asset is fine, not
# that the installer can install it.
#
# Windows has had this gate since `install_ps1_binary` (`e2e.test.ps1 -Mode Binary`),
# and it found a broken published binary on its first run. This is its POSIX
# counterpart, with the same reasoning and the same schedule: push-to-main only,
# because it downloads a published release every time and needs one to exist.
#
# Run it by hand the same way CI does:
#
#     sh scripts/install-tests/published-release-e2e.sh
#
# It never touches your own install: every path it writes is inside a disposable
# HOME under a temp directory, including the shell rc and the completion files.

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d)"
TMP_WORK_DIR="$WORK_DIR/tmp"
mkdir -p "$TMP_WORK_DIR"
export TMPDIR="$TMP_WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

section() {
   echo ""
   echo "=== $1 ==="
}

INSTALLER_E2E_ROOT="$ROOT_DIR"
# shellcheck source=./installer-e2e-lib.sh
. "$ROOT_DIR/scripts/install-tests/installer-e2e-lib.sh"

section "Published release install (no --local: the real download path)"
# No mode argument at all, which is the default and the documented command.
installer_end_to_end "$WORK_DIR"

# The no-clobber rules are deliberately NOT repeated here. They are about what
# the installer does to files the user already owns, which cannot depend on where
# the binary came from, and each extra phase is another ~280 MB download.

echo ""
echo "The published release installs, reinstalls and uninstalls cleanly"
