#!/usr/bin/env bash
set -euo pipefail

# Release gate for the install methods veyyon actually ships.
#
# veyyon is distributed GitHub-only, through exactly two channels:
#   1. the prebuilt self-contained binary (`curl -fsSL https://get.veyyon.dev | sh`)
#   2. a source checkout (`install.sh --source`), where a launcher on PATH runs
#      veyyon straight from TypeScript
#
# There is no npm/bun registry channel and there never will be: the workspace
# pins its own packages with `workspace:*` and `catalog:` protocols, which only
# resolve inside a checkout, so a registry install could not work even if one
# were published. This gate therefore smokes the two real channels and nothing
# else — it deliberately does NOT pack tarballs or reproduce a published npm
# topology, because no user can ever install that way.

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

smoke_cli() {
   local cli_bin="$1"
   local runtime_dir
   runtime_dir="$(mktemp -d "$WORK_DIR/compiled-runtime.XXXXXX")"
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$cli_bin" --version
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$cli_bin" --help >/dev/null
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$cli_bin" stats --summary >/dev/null
   # Spawns bundled workers and serves the stats dashboard once. Regression
   # probe for #1011/#1027 worker loading and for compiled distributions
   # missing the dashboard assets that `stats --summary` never touches.
   XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$cli_bin" --smoke-test
}

section "Installer function unit tests"
# Fast, dependency-free checks of install.sh's helper functions (checksum
# verification, uninstall, alias linking, atomic binary placement, retry knob)
# before the build-heavy smoke tests. Exits non-zero on any failure, so a broken
# installer helper fails the run here rather than after a full build.
sh "$ROOT_DIR/scripts/install-tests/functions.test.sh"

section "Binary install smoke"
# Channel 1: what `curl | sh` puts on a user's machine.
bun --cwd=packages/natives run build
bun --cwd=packages/coding-agent run build

BINARY_DIR="$WORK_DIR/binary-bin"
mkdir -p "$BINARY_DIR"
cp packages/coding-agent/dist/vey "$BINARY_DIR/veyyon"
smoke_cli "$BINARY_DIR/veyyon"

section "Installer end-to-end (--local install, then --uninstall)"
# The two smokes above run the ARTIFACTS each channel produces. Neither runs
# install.sh itself, so everything the installer does around the binary — linking
# the alias, writing completions, editing the shell rc, the doctor self-check,
# and reclaiming all of it on uninstall — was only ever covered by unit tests of
# the individual functions. This drives the real script end to end against a
# sandboxed HOME, with no network: --local installs the binary just built above.
#
# The assertions themselves live in installer-e2e-lib.sh, shared with
# published-release-e2e.sh, which runs the identical contract against the release
# a user actually downloads.
INSTALLER_E2E_ROOT="$ROOT_DIR"
# shellcheck source=./installer-e2e-lib.sh
. "$ROOT_DIR/scripts/install-tests/installer-e2e-lib.sh"

installer_end_to_end "$WORK_DIR" --local

section "Installer end-to-end (a 'vey' the user already owns)"
installer_no_clobber "$WORK_DIR" --local

section "Source install smoke (bun link)"
SOURCE_BUN_HOME="$WORK_DIR/bun-source"
(
   export BUN_INSTALL="$SOURCE_BUN_HOME"
   export PATH="$BUN_INSTALL/bin:$PATH"
   bun --cwd="$ROOT_DIR/packages/coding-agent" link
   smoke_cli "$BUN_INSTALL/bin/veyyon"
)

section "Source launcher smoke (install.sh --source path)"
# Channel 2 as the installer actually wires it: `install.sh --source` symlinks
# PATH's veyyon at this committed launcher, so the launcher itself must run the
# CLI from a checkout. `bun link` above does not exercise it, which is how a
# broken launcher could pass the gate and still break every source install.
LAUNCHER="$ROOT_DIR/packages/coding-agent/scripts/veyyon"
[ -x "$LAUNCHER" ] || {
   echo "source launcher missing or not executable: $LAUNCHER"
   exit 1
}
smoke_cli "$LAUNCHER"

echo ""
echo "All install method smoke tests passed"
