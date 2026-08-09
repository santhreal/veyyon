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
# counterpart, with the same reasoning and the same schedule: both run once a day
# from `published-release-monitor.yml`, because a published release is what they
# download and that only changes when one is published.
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

section "Release-tag probe against the real endpoint"
# functions.test.sh cannot answer this one. It stubs curl, so it decides what
# github.com replies: it can prove the probe reads a reply correctly, never that
# the reply it expects is the one github.com actually sends. That gap is exactly
# how the defect shipped. The probe used to HEAD `/releases/tag/<tag>` and read a
# 200 as "this release is published", but github.com renders that page for a BARE
# GIT TAG with no release attached, so `--ref v1.0.39` sailed past the check and
# died at the asset download with "veyyon-linux-x64 not published for this
# release?", blaming the platform binary for a release that was never cut. The
# stub answered 200 too, so the suite saw nothing wrong.
#
# It lives in this tier and not the default one because it is a real request to
# github.com, on the same push-to-main schedule as the download below.
#
# The tags, chosen not to rot:
#   the newest release       a published release with assets, by construction
#   v1.0.39                  a real tag of this repository, never released
#   v0.0.0-does-not-exist    a tag nobody will ever create
# A draft is not probed here: from outside, github.com renders a draft's tag
# exactly like a bare one (a tag page, and an asset list holding only the source
# archives), so v1.0.39 covers that state too and functions.test.sh pins it
# separately.
# Inputs go through the environment, not positional parameters: install.sh parses
# "$@" as its own command line when sourced, so a path in $1 is read as a bad
# flag and kills the shell before any function is defined.
probe_tag_state() { # <tag> -> 0 released, 2 tag with no release, 1 no such tag
   VEYYON_INSTALL_SOURCED=1 PROBE_ROOT="$ROOT_DIR" PROBE_TAG="$1" sh -c '
      . "$PROBE_ROOT/scripts/install.sh" >/dev/null 2>&1
      state=0
      release_tag_state "$PROBE_TAG" || state=$?
      printf "%s\n" "$state"
   '
}

expect_tag_state() { # <tag> <expected state> <what that state means>
   local got
   got="$(probe_tag_state "$1")"
   if [ "$got" != "$2" ]; then
      echo "release_tag_state $1 answered $got, expected $2 ($3)"
      exit 1
   fi
   echo "  ok  $1 -> $got  ($3)"
}

LATEST_TAG="$(VEYYON_INSTALL_SOURCED=1 PROBE_ROOT="$ROOT_DIR" sh -c \
   '. "$PROBE_ROOT/scripts/install.sh" >/dev/null 2>&1; resolve_latest_tag')"
[ -n "$LATEST_TAG" ] || {
   echo "could not resolve the latest release tag from github.com"
   exit 1
}
expect_tag_state "$LATEST_TAG" 0 "a published release with assets"
expect_tag_state v1.0.39 2 "a real tag that was never released"
expect_tag_state v0.0.0-does-not-exist 1 "no such tag"

section "Published release install (no --local: the real download path)"
# No mode argument at all, which is the default and the documented command.
installer_end_to_end "$WORK_DIR"

# The no-clobber rules are deliberately NOT repeated here. They are about what
# the installer does to files the user already owns, which cannot depend on where
# the binary came from, and each extra phase is another ~280 MB download.

echo ""
echo "The published release installs, reinstalls and uninstalls cleanly"
