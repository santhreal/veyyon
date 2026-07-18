#!/bin/sh
set -e

# Veyyon installer
# Usage: curl -fsSL https://get.veyyon.dev | sh
#   or:  curl -fsSL https://raw.githubusercontent.com/santhreal/veyyon/main/scripts/install.sh | sh
#
# Options:
#   --source        Install from source via bun (installs bun if needed)
#   --binary        Always install the prebuilt binary
#   --ref <ref>     Install a specific tag/commit/branch (implies --source)
#   -r <ref>        Shorthand for --ref
#   --uninstall     Remove veyyon, the `vey` alias, and completions
#   --no-verify     Skip binary checksum verification (NOT recommended)
#
# After install, launch with `vey` in any repo.

REPO="santhreal/veyyon"
PACKAGE="@veyyon/coding-agent"
BIN_NAME="veyyon"
ALIAS_NAME="vey"
INSTALL_DIR="${VEYYON_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.14"

MODE=""
REF=""
VERIFY=1
DO_UNINSTALL=0

while [ $# -gt 0 ]; do
    case "$1" in
        --source) MODE="source"; shift ;;
        --binary) MODE="binary"; shift ;;
        --uninstall) DO_UNINSTALL=1; shift ;;
        --no-verify) VERIFY=0; shift ;;
        --ref)
            shift
            [ -z "$1" ] && { echo "Missing value for --ref" >&2; exit 1; }
            REF="$1"; shift ;;
        --ref=*)
            REF="${1#*=}"
            [ -z "$REF" ] && { echo "Missing value for --ref" >&2; exit 1; }
            shift ;;
        -r)
            shift
            [ -z "$1" ] && { echo "Missing value for -r" >&2; exit 1; }
            REF="$1"; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# Default to source when a ref is pinned.
if [ -n "$REF" ] && [ -z "$MODE" ]; then MODE="source"; fi

# ---- small ui helpers (silver-on-black brand voice: quiet, honest) ----
say()  { printf '%s\n' "$*"; }
ok()   { printf '  ok  %s\n' "$*"; }
warn() { printf '  !!  %s\n' "$*" >&2; }
die()  { printf '  xx  %s\n' "$*" >&2; exit 1; }

has() { command -v "$1" >/dev/null 2>&1; }

# ---- the `vey` alias: one short launch command next to the binary ----
link_alias() {
    # $1 = directory containing BIN_NAME
    target="$1/$BIN_NAME"
    link="$1/$ALIAS_NAME"
    [ -e "$target" ] || return 0
    ln -sf "$target" "$link" 2>/dev/null && ok "linked '$ALIAS_NAME' -> $BIN_NAME" || warn "could not link '$ALIAS_NAME' (launch with '$BIN_NAME')"
}

# ---- ensure the install dir is actually on PATH (binary mode) ----
ensure_on_path() {
    dir="$1"
    case ":$PATH:" in *":$dir:"*) return 0 ;; esac
    # Add to the user's shell rc, idempotently, and announce it.
    line="export PATH=\"$dir:\$PATH\""
    rc=""
    case "${SHELL##*/}" in
        zsh) rc="$HOME/.zshrc" ;;
        bash) rc="$HOME/.bashrc" ;;
        fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path $dir" ;;
        *) rc="$HOME/.profile" ;;
    esac
    if [ -n "$rc" ] && ! ( [ -f "$rc" ] && grep -Fq "$dir" "$rc" ); then
        mkdir -p "$(dirname "$rc")" 2>/dev/null || true
        printf '\n# added by the veyyon installer\n%s\n' "$line" >> "$rc" \
            && ok "added $dir to PATH in $rc (restart your shell or: source $rc)" \
            || warn "add $dir to your PATH, then run '$ALIAS_NAME'"
    else
        warn "add $dir to your PATH, then run '$ALIAS_NAME'"
    fi
}

# ---- shell completions (best-effort, loud if unavailable — never silent) ----
completions_dir_for() {
    case "$1" in
        bash) echo "${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion/completions" ;;
        zsh)  echo "${XDG_DATA_HOME:-$HOME/.local/share}/zsh/site-functions" ;;
        fish) echo "${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions" ;;
    esac
}

install_completions() {
    bin="$1"
    "$bin" completions --help >/dev/null 2>&1 || {
        warn "this build has no 'completions' command yet — skipping (shell completions not installed)"
        return 0
    }
    for sh in bash zsh fish; do
        out=$(completions_dir_for "$sh")
        [ -n "$out" ] || continue
        mkdir -p "$out" 2>/dev/null || continue
        name="$BIN_NAME"; [ "$sh" = "zsh" ] && name="_$BIN_NAME"; [ "$sh" = "fish" ] && name="$BIN_NAME.fish"
        if "$bin" completions "$sh" > "$out/$name" 2>/dev/null && [ -s "$out/$name" ]; then
            ok "installed $sh completions"
        else
            rm -f "$out/$name" 2>/dev/null || true
        fi
    done
}

# ---- post-install self-check: prove the thing actually runs ----
doctor() {
    bin="$1"
    say ""
    say "doctor:"
    if ver=$("$bin" --version 2>/dev/null); then
        ok "$BIN_NAME runs — $ver"
    else
        die "$BIN_NAME did not run after install (\`$bin --version\` failed)"
    fi
    if has "$ALIAS_NAME"; then ok "'$ALIAS_NAME' is on PATH"; else warn "'$ALIAS_NAME' not on PATH yet (restart your shell)"; fi
}

# ---- checksum verification (fail closed on mismatch) ----
verify_sha256() {
    file="$1"; expected="$2"
    if has sha256sum; then actual=$(sha256sum "$file" | awk '{print $1}')
    elif has shasum; then actual=$(shasum -a 256 "$file" | awk '{print $1}')
    else die "no sha256 tool (sha256sum/shasum) available — cannot verify download integrity (use --no-verify to override)"; fi
    [ "$actual" = "$expected" ] || die "checksum mismatch (expected $expected, got $actual) — refusing to install a tampered binary"
    ok "verified sha256"
}

# Verify a downloaded release binary against its published .sha256 sidecar.
# Fail closed: a missing or unparseable sidecar refuses the install unless
# --no-verify was passed (only needed for old pre-sidecar releases).
# args: <file> <binary_url> <asset_name> <release_tag>
verify_release_binary() {
    file="$1"; url="$2"; asset="$3"; tag="$4"
    if [ "$VERIFY" -ne 1 ]; then
        warn "checksum verification skipped (--no-verify)"
        return 0
    fi
    if sum=$(curl -fsSL --connect-timeout 10 --max-time 30 "${url}.sha256" 2>/dev/null); then
        expected=$(printf '%s' "$sum" | awk '{print $1}')
        [ -n "$expected" ] || die "published checksum for $asset is empty/unparseable — refusing to install (pass --no-verify to override)"
        verify_sha256 "$file" "$expected"
    else
        die "no published checksum for $asset ($tag) — refusing to install unverified. Current releases publish .sha256 sidecars; for an old pre-sidecar release, pass --no-verify to override."
    fi
}

# ---- uninstall ----
do_uninstall() {
    removed=0
    for d in "$INSTALL_DIR" "$HOME/.bun/bin"; do
        for f in "$BIN_NAME" "$ALIAS_NAME"; do
            if [ -e "$d/$f" ] || [ -L "$d/$f" ]; then rm -f "$d/$f" && { ok "removed $d/$f"; removed=1; }; fi
        done
    done
    if has bun; then bun remove -g "$PACKAGE" >/dev/null 2>&1 && ok "removed global $PACKAGE" || true; fi
    for sh in bash zsh fish; do
        out=$(completions_dir_for "$sh")
        for name in "$BIN_NAME" "_$BIN_NAME" "$BIN_NAME.fish"; do
            [ -n "$out" ] && [ -e "$out/$name" ] && rm -f "$out/$name" && ok "removed $sh completion"
        done
    done
    [ "$removed" -eq 1 ] && say "veyyon uninstalled." || say "nothing to uninstall."
}

# ---- bun (source) install ----
require_bun_version() {
    raw=$(bun --version 2>/dev/null || true)
    [ -z "$raw" ] && die "failed to read bun version"
    clean=${raw%%-*}
    # numeric-ish compare major.minor.patch
    a_major=${clean%%.*}; rest=${clean#*.}; a_minor=${rest%%.*}; a_patch=${rest#*.}; a_patch=${a_patch%%.*}
    b_major=${MIN_BUN_VERSION%%.*}; rest=${MIN_BUN_VERSION#*.}; b_minor=${rest%%.*}; b_patch=${rest#*.}; b_patch=${b_patch%%.*}
    if [ "$a_major" -gt "$b_major" ] || \
       { [ "$a_major" -eq "$b_major" ] && [ "$a_minor" -gt "$b_minor" ]; } || \
       { [ "$a_major" -eq "$b_major" ] && [ "$a_minor" -eq "$b_minor" ] && [ "$a_patch" -ge "$b_patch" ]; }; then
        return 0
    fi
    die "bun $MIN_BUN_VERSION or newer is required (have $clean). Upgrade: https://bun.sh/docs/installation"
}

install_bun() {
    say "installing bun..."
    if has bash; then curl -fsSL https://bun.sh/install | bash; else curl -fsSL https://bun.sh/install | sh; fi
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    require_bun_version
}

bun_global_bin() {
    # where bun links global binaries
    if b=$(bun pm bin -g 2>/dev/null) && [ -n "$b" ]; then echo "$b"; else echo "$HOME/.bun/bin"; fi
}

install_via_bun() {
    say "installing veyyon from source (bun)..."
    if [ -n "$REF" ]; then
        has git || die "git is required for --ref source installs"
        TMP_DIR="$(mktemp -d)"; trap 'rm -rf "$TMP_DIR"' EXIT
        if git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then :; else
            git clone "https://github.com/${REPO}.git" "$TMP_DIR"; ( cd "$TMP_DIR" && git checkout "$REF" )
        fi
        has git-lfs && ( cd "$TMP_DIR" && git lfs pull ) || true
        [ -d "$TMP_DIR/packages/coding-agent" ] || die "expected package at $TMP_DIR/packages/coding-agent"
        bun install -g "$TMP_DIR/packages/coding-agent" || die "failed to install veyyon from source"
    else
        bun install -g "$PACKAGE" || die "failed to install $PACKAGE"
    fi
    gbin=$(bun_global_bin)
    ok "installed veyyon via bun ($gbin)"
    link_alias "$gbin"
    install_completions "$gbin/$BIN_NAME"
    ensure_on_path "$gbin"
    doctor "$gbin/$BIN_NAME"
    say ""
    say "done. run '$ALIAS_NAME' in any repo to launch."
}

# ---- prebuilt binary install ----
install_binary() {
    OS="$(uname -s)"; ARCH="$(uname -m)"
    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *) die "unsupported OS: $OS (try --source)" ;;
    esac
    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *) die "unsupported architecture: $ARCH (try --source)" ;;
    esac
    BINARY="${BIN_NAME}-${PLATFORM}-${ARCH}"

    if [ -n "$REF" ]; then
        say "fetching release $REF..."
        RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/tags/${REF}") \
            || die "release tag not found: $REF (for a branch/commit, use --source --ref)"
    else
        say "fetching latest release..."
        RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/latest") \
            || die "could not reach GitHub releases"
    fi
    LATEST=$(printf '%s' "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    [ -z "$LATEST" ] && die "failed to parse release tag"
    say "version: $LATEST"

    mkdir -p "$INSTALL_DIR"
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    tmpbin="$INSTALL_DIR/.$BIN_NAME.download"
    say "downloading $BINARY..."
    curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "$tmpbin" \
        || die "download failed ($BINARY not published for this release?) — try --source"

    verify_release_binary "$tmpbin" "$BINARY_URL" "$BINARY" "$LATEST"

    mv "$tmpbin" "$INSTALL_DIR/$BIN_NAME"
    chmod +x "$INSTALL_DIR/$BIN_NAME"
    ok "installed $BIN_NAME to $INSTALL_DIR/$BIN_NAME"
    link_alias "$INSTALL_DIR"
    install_completions "$INSTALL_DIR/$BIN_NAME"
    ensure_on_path "$INSTALL_DIR"
    doctor "$INSTALL_DIR/$BIN_NAME"
    say ""
    say "done. run '$ALIAS_NAME' in any repo to launch."
}

# ---- main ----
# Tests source this file with VEYYON_INSTALL_SOURCED=1 to exercise the helper
# functions without triggering an install.
if [ "${VEYYON_INSTALL_SOURCED:-0}" != "1" ]; then
    if [ "$DO_UNINSTALL" -eq 1 ]; then
        do_uninstall
    else
        case "$MODE" in
            source) has bun || install_bun; require_bun_version; install_via_bun ;;
            binary) install_binary ;;
            *) if has bun; then require_bun_version; install_via_bun; else install_binary; fi ;;
        esac
    fi
fi
