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
INSTALLER_HOME="$WORK_DIR/installer-home"
INSTALLER_BIN="$INSTALLER_HOME/bin"
mkdir -p "$INSTALLER_HOME"

installer_env() {
   # A minimal PATH, deliberately: it keeps the run independent of whatever
   # veyyon the machine running the gate already has installed (which would
   # otherwise shadow the sandbox copy and make doctor's output depend on the
   # host), and it leaves the install dir off PATH, which is the state a fresh
   # install is actually in and the reason the installer writes the rc line.
   env PATH="/usr/bin:/bin" \
       HOME="$INSTALLER_HOME" \
       XDG_DATA_HOME="$INSTALLER_HOME/.local/share" \
       XDG_CONFIG_HOME="$INSTALLER_HOME/.config" \
       VEYYON_INSTALL_DIR="$INSTALLER_BIN" \
       VEYYON_SRC_DIR="$INSTALLER_HOME/.veyyon/src" \
       SHELL=/bin/bash \
       "$@"
}

# Assert on real paths and real file contents; a "the installer exited 0" check
# would pass for an install that placed nothing.
expect_exists() {
   [ -e "$1" ] || { echo "installer end-to-end: expected $1 to exist ($2)"; exit 1; }
}
expect_absent() {
   [ ! -e "$1" ] || { echo "installer end-to-end: expected $1 to be gone ($2)"; exit 1; }
}

installer_env sh "$ROOT_DIR/scripts/install.sh" --local

expect_exists "$INSTALLER_BIN/veyyon" "the binary itself"
[ -x "$INSTALLER_BIN/veyyon" ] || { echo "installer end-to-end: $INSTALLER_BIN/veyyon is not executable"; exit 1; }
expect_exists "$INSTALLER_BIN/vey" "the vey launch alias"
[ -L "$INSTALLER_BIN/vey" ] || { echo "installer end-to-end: vey should be a symlink to the binary"; exit 1; }

# Completions: one file per shell, plus the alias's own file for the two shells
# that key autoload on the command name.
expect_exists "$INSTALLER_HOME/.local/share/bash-completion/completions/veyyon" "bash completions"
expect_exists "$INSTALLER_HOME/.local/share/bash-completion/completions/vey" "bash completions for the alias"
expect_exists "$INSTALLER_HOME/.local/share/zsh/site-functions/_veyyon" "zsh completions"
expect_exists "$INSTALLER_HOME/.config/fish/completions/veyyon.fish" "fish completions"
expect_exists "$INSTALLER_HOME/.config/fish/completions/vey.fish" "fish completions for the alias"

# The PATH line, with the marker that makes it recognizable on uninstall.
grep -Fqx "export PATH=\"$INSTALLER_BIN:\$PATH\"" "$INSTALLER_HOME/.bashrc" || {
   echo "installer end-to-end: the PATH line is missing from .bashrc"
   exit 1
}
grep -Fqx "# added by the veyyon installer" "$INSTALLER_HOME/.bashrc" || {
   echo "installer end-to-end: the PATH line has no marker comment"
   exit 1
}

# A user's own rc content must survive the uninstall untouched.
echo "alias ll='ls -la'" >> "$INSTALLER_HOME/.bashrc"

# Reinstalling over an existing install must be clean and idempotent: no
# duplicate PATH line, no staging litter, no failure.
installer_env sh "$ROOT_DIR/scripts/install.sh" --local
path_lines="$(grep -Fxc "export PATH=\"$INSTALLER_BIN:\$PATH\"" "$INSTALLER_HOME/.bashrc" || true)"
[ "$path_lines" = "1" ] || {
   echo "installer end-to-end: reinstall wrote the PATH line $path_lines times, expected 1"
   exit 1
}

installer_env sh "$ROOT_DIR/scripts/install.sh" --uninstall

expect_absent "$INSTALLER_BIN/veyyon" "the binary after uninstall"
expect_absent "$INSTALLER_BIN/vey" "the alias after uninstall"
expect_absent "$INSTALLER_HOME/.local/share/bash-completion/completions/veyyon" "bash completions after uninstall"
expect_absent "$INSTALLER_HOME/.local/share/bash-completion/completions/vey" "alias bash completions after uninstall"
expect_absent "$INSTALLER_HOME/.local/share/zsh/site-functions/_veyyon" "zsh completions after uninstall"
expect_absent "$INSTALLER_HOME/.config/fish/completions/veyyon.fish" "fish completions after uninstall"
expect_absent "$INSTALLER_HOME/.config/fish/completions/vey.fish" "alias fish completions after uninstall"

if grep -Fq "$INSTALLER_BIN" "$INSTALLER_HOME/.bashrc"; then
   echo "installer end-to-end: uninstall left the PATH line in .bashrc"
   exit 1
fi
grep -Fqx "alias ll='ls -la'" "$INSTALLER_HOME/.bashrc" || {
   echo "installer end-to-end: uninstall removed the user's own .bashrc content"
   exit 1
}

# Nothing of ours may remain in the install directory, staging files included.
leftovers="$(ls -A "$INSTALLER_BIN" 2>/dev/null || true)"
[ -z "$leftovers" ] || {
   echo "installer end-to-end: uninstall left files behind: $leftovers"
   exit 1
}

section "Installer end-to-end (a 'vey' the user already owns)"
# The no-clobber rule, driven for real. A user who already has a `vey` command
# must keep it, keep its completions, AND not have our completions bound to it:
# every generated script normally completes both names, so declining to write
# the alias FILE was never enough on its own.
FOREIGN_HOME="$WORK_DIR/foreign-home"
FOREIGN_BIN="$FOREIGN_HOME/bin"
mkdir -p "$FOREIGN_BIN" "$FOREIGN_HOME/.local/share/bash-completion/completions"

foreign_env() {
   env PATH="/usr/bin:/bin" \
       HOME="$FOREIGN_HOME" \
       XDG_DATA_HOME="$FOREIGN_HOME/.local/share" \
       XDG_CONFIG_HOME="$FOREIGN_HOME/.config" \
       VEYYON_INSTALL_DIR="$FOREIGN_BIN" \
       VEYYON_SRC_DIR="$FOREIGN_HOME/.veyyon/src" \
       SHELL=/bin/bash \
       "$@"
}

printf '#!/bin/sh\necho their tool\n' > "$FOREIGN_BIN/vey"
chmod +x "$FOREIGN_BIN/vey"
printf 'complete -F _their_tool vey\n' > "$FOREIGN_HOME/.local/share/bash-completion/completions/vey"

foreign_env sh "$ROOT_DIR/scripts/install.sh" --local

grep -Fqx "echo their tool" "$FOREIGN_BIN/vey" || {
   echo "installer end-to-end: the user's own vey was overwritten"
   exit 1
}
grep -Fqx "complete -F _their_tool vey" "$FOREIGN_HOME/.local/share/bash-completion/completions/vey" || {
   echo "installer end-to-end: the user's own vey completion was overwritten"
   exit 1
}
# The decisive one: our own completion script must not bind their name.
if grep -Eq '^complete -F _veyyon veyyon vey$' "$FOREIGN_HOME/.local/share/bash-completion/completions/veyyon"; then
   echo "installer end-to-end: our bash completion still binds a vey we do not own"
   exit 1
fi
if grep -Eq '^#compdef veyyon vey$' "$FOREIGN_HOME/.local/share/zsh/site-functions/_veyyon"; then
   echo "installer end-to-end: our zsh completion still binds a vey we do not own"
   exit 1
fi
if grep -q 'complete -c vey -w veyyon' "$FOREIGN_HOME/.config/fish/completions/veyyon.fish"; then
   echo "installer end-to-end: our fish completion still binds a vey we do not own"
   exit 1
fi
# Our own name must still complete fully; the alias is the only thing dropped.
grep -Fq "complete -F _veyyon veyyon" "$FOREIGN_HOME/.local/share/bash-completion/completions/veyyon" || {
   echo "installer end-to-end: our own bash completion is missing"
   exit 1
}

foreign_env sh "$ROOT_DIR/scripts/install.sh" --uninstall

grep -Fqx "echo their tool" "$FOREIGN_BIN/vey" || {
   echo "installer end-to-end: uninstall removed the user's own vey"
   exit 1
}
grep -Fqx "complete -F _their_tool vey" "$FOREIGN_HOME/.local/share/bash-completion/completions/vey" || {
   echo "installer end-to-end: uninstall removed the user's own vey completion"
   exit 1
}

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
