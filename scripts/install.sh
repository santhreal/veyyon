#!/bin/sh
set -e

# Veyyon installer
# Usage: curl -fsSL https://get.veyyon.dev | sh
#   or:  curl -fsSL https://raw.githubusercontent.com/santhreal/veyyon/main/scripts/install.sh | sh
#
# By default this installs the prebuilt self-contained binary: one download, no
# toolchain, nothing from a package registry. Pass --source to build from a
# local checkout with bun instead (needed only to run an unreleased ref).
#
# Options:
#   --local         Install the locally compiled binary from dist/vey
#   --source        Build and run from a git checkout with bun (installs bun if needed)
#   --binary        Install the prebuilt binary (the default)
#   --ref <ref>     Install a specific tag/commit/branch (implies --source)
#   -r <ref>        Shorthand for --ref
#   --uninstall     Remove veyyon, the `vey` alias, completions, and any source checkout
#   --no-verify     Skip binary checksum verification (NOT recommended)
#
# After install, launch with `vey` in any repo.

REPO="santhreal/veyyon"
PACKAGE="@veyyon/coding-agent"
BIN_NAME="veyyon"
ALIAS_NAME="vey"
INSTALL_DIR="${VEYYON_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.14"

# Retry transient network failures on every download (a dropped connection or a
# 5xx/429 from GitHub should not fail the whole install on the first blip). Kept
# in one place so every curl fetch below retries the same way. Only `--retry`
# and `--retry-delay` are used: both are in curl since 7.12 (2004), so this does
# not break an old curl the way `--retry-connrefused` (7.52+) would.
# NOTE: this is expanded UNQUOTED at each call site ($CURL_RETRY, not
# "$CURL_RETRY") on purpose, so the flags word-split into separate curl
# arguments. Do not quote it (shellcheck SC2086 is wrong here): quoting passes
# the whole string as one argument and curl rejects it.
CURL_RETRY="--retry 3 --retry-delay 1"

MODE=""
REF=""
VERIFY=1
DO_UNINSTALL=0

while [ $# -gt 0 ]; do
    case "$1" in
        --local) MODE="local"; shift ;;
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

# ---- GitHub API fetch, optionally authenticated ----
# Unauthenticated api.github.com is capped at 60 requests/hr per IP; a token
# raises that limit. Use this ONLY for api.github.com JSON calls (release
# metadata), never for the binary/sidecar asset download: those redirect to a
# separate storage host, and a manually-set `-H Authorization` is resent across
# a cross-host redirect, which would leak the token to that host. The token is
# always optional — anonymous installs must keep working with no token set.
gh_curl() {
    tok="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
    if [ -n "$tok" ]; then
        curl -fsSL $CURL_RETRY -H "Authorization: Bearer $tok" "$@"
    else
        curl -fsSL $CURL_RETRY "$@"
    fi
}

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
        bash)
            # macOS Terminal.app opens *login* bash shells, which read
            # ~/.bash_profile (then ~/.bash_login, ~/.profile) and NOT ~/.bashrc,
            # so a PATH line written only to ~/.bashrc never takes effect there.
            # Linux terminals open interactive non-login shells that read ~/.bashrc.
            if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
                if [ -f "$HOME/.bash_profile" ]; then rc="$HOME/.bash_profile"
                elif [ -f "$HOME/.bash_login" ]; then rc="$HOME/.bash_login"
                elif [ -f "$HOME/.profile" ]; then rc="$HOME/.profile"
                else rc="$HOME/.bash_profile"
                fi
            else
                rc="$HOME/.bashrc"
            fi
            ;;
        fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path $dir" ;;
        *) rc="$HOME/.profile" ;;
    esac
    # Three distinct outcomes, three distinct messages. Collapsing them (as this
    # did) meant a REINSTALL — where the rc already carries the line — told the
    # user to "add $dir to your PATH" even though it was already configured and
    # all they needed was a new shell. The manual-action warning is now reserved
    # for the case where the installer genuinely could not do it.
    if [ -z "$rc" ]; then
        warn "add $dir to your PATH, then run '$ALIAS_NAME'"
    elif [ -f "$rc" ] && grep -Fq "$dir" "$rc"; then
        ok "$dir is already on PATH in $rc (restart your shell or: source $rc)"
    else
        mkdir -p "$(dir_of "$rc")" 2>/dev/null || true
        printf '\n# added by the veyyon installer\n%s\n' "$line" >> "$rc" \
            && ok "added $dir to PATH in $rc (restart your shell or: source $rc)" \
            || warn "could not write $rc — add $dir to your PATH, then run '$ALIAS_NAME'"
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

# The filename each shell autoloads for a given command name. Single owner: both
# install_completions and do_uninstall derive every path from this, so the two can
# never disagree about what was written and what must be removed.
completion_file_for() {
    # $1 = shell, $2 = command name (BIN_NAME or ALIAS_NAME)
    case "$1" in
        bash) echo "$2" ;;
        zsh)  echo "_$2" ;;
        fish) echo "$2.fish" ;;
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
        name=$(completion_file_for "$sh" "$BIN_NAME")
        # Generate to a temp first, then move into place: a completion file is
        # sourced by the shell at startup, so a half-written one (disk full, the
        # install killed mid-write) breaks every new shell the user opens. The
        # binary path gets the same treatment in finalize_binary.
        tmp="$out/.$name.$$"
        if "$bin" completions "$sh" > "$tmp" 2>/dev/null && [ -s "$tmp" ] && mv -f "$tmp" "$out/$name"; then
            ok "installed $sh completions"
            # bash and fish autoload a completion file by the command name being
            # completed, so the `vey` alias needs its own file or it gets nothing
            # (zsh needs none: the generated script's `#compdef` line names both).
            alias_name=$(completion_file_for "$sh" "$ALIAS_NAME")
            if [ -n "$alias_name" ] && [ "$sh" != "zsh" ]; then
                if cp -f "$out/$name" "$out/$alias_name" 2>/dev/null; then
                    ok "installed $sh completions for '$ALIAS_NAME'"
                else
                    warn "could not install $sh completions for '$ALIAS_NAME' (tab completion for '$ALIAS_NAME' unavailable)"
                fi
            fi
        else
            # Remove the empty/partial file and say so: this function's contract is
            # best-effort but never silent, so a failed shell must be visible.
            rm -f "$tmp" 2>/dev/null || true
            warn "could not generate $sh completions (skipped)"
        fi
    done
}

# Where a command name actually resolves from, or "" when it is not on PATH.
# Compared by DIRECTORY rather than by full path: the alias is a symlink to the
# binary beside it, so the two names legitimately resolve to different files in
# the same directory, and comparing dirs avoids needing a portable realpath.
# Uses parameter expansion rather than `dirname`: doctor must keep working when
# PATH is minimal or misconfigured, which is exactly the situation it exists to
# diagnose, and forking an external for a string operation would fail there.
dir_of() {
    case "$1" in
        */*) d="${1%/*}"; [ -n "$d" ] || d="/"; printf '%s' "$d" ;;
        *)   printf '%s' "." ;;
    esac
}

resolved_dir_for() {
    p=$(command -v "$1" 2>/dev/null) || return 1
    [ -n "$p" ] || return 1
    dir_of "$p"
}

# Report whether `$1` on PATH is the copy we just installed into $2.
# A stale copy earlier on PATH (an old `bun add -g` global, a distro package, a
# previous manual install) silently wins every future invocation, so this is
# checked and reported LOUDLY rather than assumed from mere presence on PATH.
check_not_shadowed() {
    name="$1"; want_dir="$2"
    got_dir=$(resolved_dir_for "$name") || {
        warn "'$name' not on PATH yet (restart your shell, or add $want_dir to PATH)"
        return 0
    }
    if [ "$got_dir" = "$want_dir" ]; then
        ok "'$name' on PATH resolves to this install"
    else
        warn "'$name' on PATH resolves to $got_dir/$name, NOT the copy just installed in $want_dir — that older copy shadows this one and will keep running instead. Remove it, or put $want_dir earlier in PATH."
    fi
}

# Pull the semver out of a `--version` line ("veyyon/1.0.37" -> "1.0.37").
# Prints nothing and returns 1 when the line carries no x.y.z token, so a
# format change is visible as a failed check rather than a silent pass.
version_from_output() {
    for tok in $1; do
        cand="${tok##*/}"
        case "$cand" in
            [0-9]*.[0-9]*.[0-9]*) printf '%s' "$cand"; return 0 ;;
        esac
    done
    return 1
}

# ---- post-install self-check: prove the thing actually runs ----
# $2 (optional) is the release tag that was installed. When given, the binary
# must report exactly that version.
doctor() {
    bin="$1"; want_tag="${2:-}"
    say ""
    say "doctor:"
    if ver=$("$bin" --version 2>/dev/null); then
        ok "$BIN_NAME runs — $ver"
    else
        die "$BIN_NAME did not run after install (\`$bin --version\` failed)"
    fi
    # The checksum proved the bytes match the published asset; this proves the
    # published asset is the version the release claims. A release that uploaded
    # the wrong binary for its tag, or a stale cached download, otherwise
    # installs "successfully" and silently runs the wrong version forever. The
    # self-updater enforces the same gate before keeping a swapped-in binary.
    if [ -n "$want_tag" ]; then
        want="${want_tag#v}"
        got=$(version_from_output "$ver") || die "could not read a version from \`$bin --version\` output: $ver"
        if [ "$got" = "$want" ]; then
            ok "reported version matches the $want_tag release"
        else
            die "installed $BIN_NAME reports $got but the $want_tag release was requested — the release may have published a mismatched binary. The file at $bin is NOT the version you asked for; re-run the installer or pin with --ref."
        fi
    fi
    # Both names are checked: a user who types `veyyon` and a user who types the
    # documented `vey` must each reach the binary that was just installed.
    bin_dir=$(dir_of "$bin")
    check_not_shadowed "$BIN_NAME" "$bin_dir"
    check_not_shadowed "$ALIAS_NAME" "$bin_dir"
}

# A staging path in the install dir that no concurrent installer can collide on.
#
# Both staging paths used to be fixed names (`.veyyon.download`, `.veyyon.local`),
# so two installers running at once wrote the SAME file: one truncated the
# other's partial download mid-transfer, and whichever finished first had its
# bytes replaced under it before the checksum ran. Worse, each process installs
# an EXIT trap removing that path, so the first to finish deleted the second's
# staging file out from under it. $$ makes the path per-process; the binary
# updater keeps its temp unique for exactly the same reason.
#
# It stays inside $INSTALL_DIR on purpose: finalize_binary renames it into place,
# and a rename is only atomic within one filesystem.
staging_path() {
    printf '%s/.%s.%s.%s' "$INSTALL_DIR" "$BIN_NAME" "$1" "$$"
}

# ---- place a downloaded binary at its final path, atomically ----
# Refuses an empty download, makes the file executable BEFORE the move (so it is
# never visible non-executable at the final path), then moves it into place.
# `mv` within one filesystem is atomic and preserves the mode set here; the temp
# file lives in the same dir as the destination so the move never crosses a
# filesystem boundary. args: <tmpfile> <dest>
finalize_binary() {
    tmp="$1"; dest="$2"
    [ -s "$tmp" ] || die "downloaded binary is empty — refusing to install (try again or use --source)"
    chmod +x "$tmp" || die "could not make $tmp executable"
    mv -f "$tmp" "$dest" || die "could not move binary into place at $dest"
}

# ---- parse the release tag from a GitHub release JSON blob ----
# Reads JSON on stdin, prints the `tag_name` value (empty if absent). Anchored
# on the `"tag_name":` key specifically, not "the last quoted string on the
# first line that mentions tag_name" — the old form would grab a wrong token if
# the JSON were formatted differently or put on one line. `head -n1` keeps a
# single value even if the blob somehow contains more than one match.
parse_release_tag() {
    sed -n -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n1
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
    if sum=$(curl -fsSL $CURL_RETRY --connect-timeout 10 --max-time 30 "${url}.sha256" 2>/dev/null); then
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
        # A compiled binary probes for a staged addon next to itself; clear any
        # `veyyon_natives.*.node` left beside the removed binary so uninstall does
        # not leave orphaned native artifacts behind.
        for n in "$d"/veyyon_natives.*.node; do
            [ -e "$n" ] && rm -f "$n" && { ok "removed $n"; removed=1; }
        done
    done
    if has bun; then bun remove -g "$PACKAGE" >/dev/null 2>&1 && ok "removed global $PACKAGE" || true; fi
    src="${VEYYON_SRC_DIR:-$HOME/.veyyon/src}"
    if [ -d "$src" ]; then
        # Never rm -rf a checkout that holds uncommitted edits or unpushed local
        # branches (e.g. a `veyyon-local-*` preservation branch carrying the
        # user's AGENTS.md). Move it aside so uninstall can never destroy work
        # the installer did not create; only a pristine tree is deleted outright.
        if src_has_local_work "$src"; then
            move_aside_existing_src "$src"
            removed=1
        else
            rm -rf "$src" && { ok "removed source checkout $src"; removed=1; }
        fi
    fi
    for sh in bash zsh fish; do
        out=$(completions_dir_for "$sh")
        [ -n "$out" ] || continue
        # Derive both filenames from the same owner install_completions writes
        # through, so an alias completion can never be orphaned by an uninstall.
        for cmd in "$BIN_NAME" "$ALIAS_NAME"; do
            name=$(completion_file_for "$sh" "$cmd")
            [ -n "$name" ] && [ -e "$out/$name" ] && rm -f "$out/$name" && ok "removed $sh completion for '$cmd'"
        done
    done
    # Remove the per-version native addon cache a binary install stages there
    # (~150MB per version). The path shape is owned by getNativesDir() in
    # packages/natives/native/loader-state.js — mirror it EXACTLY: honor
    # $XDG_DATA_HOME/veyyon/natives only when $XDG_DATA_HOME/veyyon already
    # exists (the loader's condition), otherwise ~/.veyyon/natives. Only the
    # `natives` cache subdir is removed; the user's auth/config/sessions under
    # ~/.veyyon are left untouched.
    if [ -n "${XDG_DATA_HOME:-}" ] && [ -d "$XDG_DATA_HOME/veyyon" ]; then
        natives_cache="$XDG_DATA_HOME/veyyon/natives"
    else
        natives_cache="$HOME/.veyyon/natives"
    fi
    if [ -d "$natives_cache" ]; then
        rm -rf "$natives_cache" && { ok "removed native addon cache $natives_cache"; removed=1; }
    fi
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

# Veyyon's packages resolve one another through Bun workspace and catalog
# protocols, which only work inside a full checkout. A source install therefore
# keeps a real clone under $VEYYON_SRC_DIR, installs the workspace once, and
# links the launcher (packages/coding-agent/scripts/veyyon) onto PATH. The
# launcher runs straight from TypeScript, so there is no build step; --ref pins
# a tag, branch, or commit.
VEYYON_SRC_DIR="${VEYYON_SRC_DIR:-$HOME/.veyyon/src}"
REPO_URL="https://github.com/${REPO}.git"

# Commit any uncommitted local edits in a source checkout onto a durable backup
# branch BEFORE the update resets over them. The update path runs
# `git reset --hard origin/<ref>`, which would otherwise silently discard a
# user's local edits to a tracked file (this is how an edited ~/.veyyon/src
# AGENTS.md kept vanishing on every update). Preserving-then-resetting means the
# installer never destroys work it did not create: the edits live on branch
# `veyyon-local-<stamp>` and are printed for recovery.
#
# Uses `git commit-tree` so the backup commit is built from the staged tree
# without moving HEAD or the current branch — the checkout is left exactly as it
# was for the reset that follows. `git add -A` honors .gitignore, so build
# artifacts (node_modules, dist) are not swept into the backup, only real edits.
# Identity is forced inline so this works in a checkout with no configured git
# user. Returns non-zero if preservation cannot complete, so the caller can
# refuse to reset rather than risk destroying the changes (fail closed).
preserve_local_src_changes() {
    src="${1:-$VEYYON_SRC_DIR}"
    [ -d "$src/.git" ] || return 0
    [ -n "$( cd "$src" 2>/dev/null && git status --porcelain 2>/dev/null )" ] || return 0
    # pid keeps two installer runs in the same second from colliding on the
    # branch name (a collision would fail closed and needlessly block the update).
    stamp=$(date -u +%Y%m%d-%H%M%S)-$$
    branch="veyyon-local-$stamp"
    (
        cd "$src" || exit 1
        git add -A || exit 1
        tree=$(git write-tree) || exit 1
        parent=$(git rev-parse -q --verify HEAD 2>/dev/null || true)
        msg="veyyon: preserve local changes before update ($stamp)"
        if [ -n "$parent" ]; then
            commit=$(git -c user.name="veyyon-installer" -c user.email="installer@veyyon.dev" \
                commit-tree "$tree" -p "$parent" -m "$msg") || exit 1
        else
            commit=$(git -c user.name="veyyon-installer" -c user.email="installer@veyyon.dev" \
                commit-tree "$tree" -m "$msg") || exit 1
        fi
        git branch "$branch" "$commit" || exit 1
    ) || { warn "could not preserve local changes in $src; refusing to reset over them"; return 1; }
    warn "preserved your local changes on branch '$branch'"
    warn "recover them with: git -C $src checkout $branch"
    return 0
}

# Move an existing tree aside instead of deleting it. The clone path used to
# `rm -rf "$VEYYON_SRC_DIR"` before cloning, which destroys any files a user put
# there (or a partial/corrupt checkout with no .git). Moving to
# `<dir>.bak-<stamp>` preserves everything and lets the fresh clone proceed.
# An empty directory is simply removed (nothing to preserve). Fail closed: if
# the move cannot happen, die rather than fall back to a destructive delete.
move_aside_existing_src() {
    src="${1:-$VEYYON_SRC_DIR}"
    [ -e "$src" ] || return 0
    if [ -d "$src" ] && [ -z "$(ls -A "$src" 2>/dev/null)" ]; then
        rmdir "$src" 2>/dev/null || true
        return 0
    fi
    stamp=$(date -u +%Y%m%d-%H%M%S)-$$
    backup="$src.bak-$stamp"
    mv "$src" "$backup" || die "refusing to clone: could not move existing $src aside to $backup"
    warn "moved existing $src aside to $backup (nothing was deleted)"
}

# Report (exit 0) whether a source checkout holds work the installer did not
# create and must not delete on uninstall: uncommitted edits, or commits on any
# local branch that live on no remote (this includes the `veyyon-local-*`
# preservation branches from a prior update, so a preserved AGENTS.md is never
# silently `rm -rf`'d out from under the user by `--uninstall`). A non-git but
# non-empty tree is also treated as local work (user files / partial checkout).
# Exit 1 means the tree is pristine and safe to remove outright.
src_has_local_work() {
    src="${1:-$VEYYON_SRC_DIR}"
    [ -d "$src" ] || return 1
    if [ ! -d "$src/.git" ]; then
        [ -n "$(ls -A "$src" 2>/dev/null)" ] && return 0 || return 1
    fi
    [ -n "$( cd "$src" 2>/dev/null && git status --porcelain 2>/dev/null )" ] && return 0
    [ -n "$( cd "$src" 2>/dev/null && git log --branches --not --remotes --oneline 2>/dev/null )" ] && return 0
    return 1
}

fetch_source_tree() {
    if [ -d "$VEYYON_SRC_DIR/.git" ]; then
        say "updating veyyon source in $VEYYON_SRC_DIR..."
        # Commit local edits to a backup branch before resetting. If that fails,
        # refuse the update rather than destroy uncommitted work.
        preserve_local_src_changes "$VEYYON_SRC_DIR" \
            || die "refusing to update: could not preserve local changes in $VEYYON_SRC_DIR"
        ( cd "$VEYYON_SRC_DIR" && git fetch --tags --force origin ) || die "failed to update $VEYYON_SRC_DIR"
        ref="$REF"
        if [ -z "$ref" ]; then
            ref=$( cd "$VEYYON_SRC_DIR" && git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p' )
            [ -z "$ref" ] && ref="main"
        fi
        ( cd "$VEYYON_SRC_DIR" && git checkout --force "$ref" && { git reset --hard "origin/$ref" 2>/dev/null || git reset --hard "$ref"; } ) \
            || die "failed to check out '$ref' in $VEYYON_SRC_DIR"
    else
        say "cloning veyyon source into $VEYYON_SRC_DIR..."
        mkdir -p "$(dirname "$VEYYON_SRC_DIR")"
        # Never rm -rf an existing tree: move it aside so nothing is lost.
        move_aside_existing_src "$VEYYON_SRC_DIR"
        if [ -n "$REF" ]; then
            if git clone --depth 1 --branch "$REF" "$REPO_URL" "$VEYYON_SRC_DIR" >/dev/null 2>&1; then :; else
                git clone "$REPO_URL" "$VEYYON_SRC_DIR" || die "failed to clone $REPO_URL"
                ( cd "$VEYYON_SRC_DIR" && git checkout "$REF" ) || die "ref not found: $REF"
            fi
        else
            git clone --depth 1 "$REPO_URL" "$VEYYON_SRC_DIR" >/dev/null 2>&1 \
                || git clone "$REPO_URL" "$VEYYON_SRC_DIR" \
                || die "failed to clone $REPO_URL"
        fi
    fi
    has git-lfs && ( cd "$VEYYON_SRC_DIR" && git lfs pull ) || true
}

install_via_bun() {
    has git || die "git is required to install veyyon from source"
    say "installing veyyon from source (bun)..."
    fetch_source_tree
    [ -d "$VEYYON_SRC_DIR/packages/coding-agent" ] || die "expected package at $VEYYON_SRC_DIR/packages/coding-agent"
    launcher="$VEYYON_SRC_DIR/packages/coding-agent/scripts/$BIN_NAME"
    [ -x "$launcher" ] || die "source launcher not found or not executable: $launcher"
    say "installing workspace dependencies (bun install)..."
    ( cd "$VEYYON_SRC_DIR" && bun install ) || die "failed to install workspace dependencies"
    # Bun runs no root lifecycle scripts on workspace installs, so gitignored
    # build artifacts must be generated explicitly: without this, the checkout
    # ships a stale or missing tool-views bundle (missing = launch relies on
    # the launcher's self-heal; the installer should hand over a complete tree).
    say "generating build artifacts (gen:tool-views)..."
    ( cd "$VEYYON_SRC_DIR" && bun --cwd=packages/collab-web run gen:tool-views ) \
        || die "failed to generate build artifacts (bun --cwd=packages/collab-web run gen:tool-views)"
    # The native addon is the other gitignored built artifact: a fresh clone has
    # none and veyyon dies at boot without it. The ensure script provisions it
    # (prebuilt release download, else local cargo build) or fails with the fix.
    say "ensuring native addon (packages/natives)..."
    ( cd "$VEYYON_SRC_DIR" && bun --cwd=packages/natives run ensure ) \
        || die "failed to provision the native addon (bun --cwd=packages/natives run ensure)"
    mkdir -p "$INSTALL_DIR"
    ln -sfn "$launcher" "$INSTALL_DIR/$BIN_NAME" || die "failed to link $BIN_NAME into $INSTALL_DIR"
    ok "installed $BIN_NAME (source) -> $launcher"
    link_alias "$INSTALL_DIR"
    install_completions "$INSTALL_DIR/$BIN_NAME"
    ensure_on_path "$INSTALL_DIR"
    doctor "$INSTALL_DIR/$BIN_NAME"
    say ""
    say "done. run '$ALIAS_NAME' in any repo to launch."
}

# ---- local binary install (from local checkout build) ----
install_local() {
    local_bin=""
    for candidate in "$PWD/packages/coding-agent/dist/vey" "$PWD/dist/vey" "$PWD/../coding-agent/dist/vey"; do
        if [ -f "$candidate" ]; then local_bin="$candidate"; break; fi
    done
    [ -n "$local_bin" ] || die "local compiled binary not found — run 'bun scripts/build-binary.ts' in packages/coding-agent first"
    mkdir -p "$INSTALL_DIR"
    tmpbin=$(staging_path local)
    cp -f "$local_bin" "$tmpbin"
    finalize_binary "$tmpbin" "$INSTALL_DIR/$BIN_NAME"
    ok "installed $BIN_NAME to $INSTALL_DIR/$BIN_NAME"
    link_alias "$INSTALL_DIR"
    install_completions "$INSTALL_DIR/$BIN_NAME"
    ensure_on_path "$INSTALL_DIR"
    doctor "$INSTALL_DIR/$BIN_NAME"
    say ""
    say "✓ Installation complete."
    say ""
    say "Next steps:"
    say "  1. Launch in any repository: $ALIAS_NAME"
    say "  2. Connect API providers:    $ALIAS_NAME setup"
    say "  3. Run system diagnostics:  $ALIAS_NAME plugin doctor"
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
        RELEASE_JSON=$(gh_curl --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/tags/${REF}") \
            || die "release tag not found: $REF (for a branch/commit, use --source --ref)"
    else
        say "fetching latest release..."
        RELEASE_JSON=$(gh_curl --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/latest") \
            || die "could not reach GitHub releases (network error or rate limit — set GITHUB_TOKEN to raise the API limit, retry, or use --source)"
    fi
    LATEST=$(printf '%s' "$RELEASE_JSON" | parse_release_tag)
    [ -z "$LATEST" ] && die "failed to parse release tag"
    say "version: $LATEST"

    mkdir -p "$INSTALL_DIR"
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    tmpbin=$(staging_path download)
    # Never leave a partial or tampered download behind: a failed curl, a
    # checksum mismatch (die inside verify_release_binary), or a Ctrl-C must all
    # clean up the temp file. Cleared after the atomic move succeeds.
    trap 'rm -f "$tmpbin"' EXIT INT TERM
    say "downloading $BINARY..."
    curl -fsSL $CURL_RETRY --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "$tmpbin" \
        || die "download failed ($BINARY not published for this release?) — try --source"

    verify_release_binary "$tmpbin" "$BINARY_URL" "$BINARY" "$LATEST"

    finalize_binary "$tmpbin" "$INSTALL_DIR/$BIN_NAME"
    trap - EXIT INT TERM
    ok "installed $BIN_NAME to $INSTALL_DIR/$BIN_NAME"
    link_alias "$INSTALL_DIR"
    install_completions "$INSTALL_DIR/$BIN_NAME"
    ensure_on_path "$INSTALL_DIR"
    doctor "$INSTALL_DIR/$BIN_NAME" "$LATEST"
    say ""
    say "✓ Installation complete."
    say ""
    say "Next steps:"
    say "  1. Launch in any repository: $ALIAS_NAME"
    say "  2. Connect API providers:    $ALIAS_NAME setup"
    say "  3. Run system diagnostics:  $ALIAS_NAME plugin doctor"
}

# ---- main ----
# Tests source this file with VEYYON_INSTALL_SOURCED=1 to exercise the helper
# functions without triggering an install.
if [ "${VEYYON_INSTALL_SOURCED:-0}" != "1" ]; then
    if [ "$DO_UNINSTALL" -eq 1 ]; then
        do_uninstall
    else
        case "$MODE" in
            local) install_local ;;
            source) has bun || install_bun; require_bun_version; install_via_bun ;;
            binary) install_binary ;;
            *) install_binary ;;
        esac
    fi
fi
