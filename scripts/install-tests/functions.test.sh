#!/bin/sh
# Behavior tests for scripts/install.sh helper functions — the security-critical
# (checksum) and destructive (uninstall) paths, run without any real install.
# Sources install.sh with VEYYON_INSTALL_SOURCED=1 so main() does not run.
#
# Run: sh scripts/install-tests/functions.test.sh
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

# Isolate the install dir so uninstall/link tests never touch the real ~/.local/bin.
export VEYYON_INSTALL_DIR="$SANDBOX/bin"
export HOME="$SANDBOX/home"
mkdir -p "$VEYYON_INSTALL_DIR" "$HOME"

VEYYON_INSTALL_SOURCED=1 . "$ROOT/scripts/install.sh"
set +e # install.sh sets -e; tests intentionally exercise failing paths

PASS=0
FAIL=0
check() { # desc, actual, expected
    if [ "$2" = "$3" ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); printf 'FAIL: %s\n  expected [%s]\n  got      [%s]\n' "$1" "$3" "$2"; fi
}

# --- verify_sha256: correct hash passes, wrong hash fails closed ---
payload="$SANDBOX/payload.bin"
printf 'veyyon-integrity-fixture' > "$payload"
if command -v sha256sum >/dev/null 2>&1; then real=$(sha256sum "$payload" | awk '{print $1}')
else real=$(shasum -a 256 "$payload" | awk '{print $1}'); fi

( verify_sha256 "$payload" "$real" >/dev/null 2>&1 ); check "verify_sha256 accepts matching hash" "$?" "0"
( verify_sha256 "$payload" "deadbeef" >/dev/null 2>&1 ); check "verify_sha256 fails closed on mismatch" "$?" "1"

# --- verify_release_binary: sidecar fetch paths, curl shadowed per-case ---
# Shadow functions simulate the ${url}.sha256 fetch without any network.
url="https://example.invalid/veyyon-linux-x64"

( curl() { printf '%s  veyyon-linux-x64\n' "$real"; }
  VERIFY=1 verify_release_binary "$payload" "$url" "veyyon-linux-x64" "v0.0.0" >/dev/null 2>&1 )
check "verify_release_binary accepts a good sidecar" "$?" "0"

( curl() { printf 'deadbeef  veyyon-linux-x64\n'; }
  VERIFY=1 verify_release_binary "$payload" "$url" "veyyon-linux-x64" "v0.0.0" >/dev/null 2>&1 )
check "verify_release_binary fails closed on sidecar mismatch" "$?" "1"

( curl() { return 22; }
  VERIFY=1 verify_release_binary "$payload" "$url" "veyyon-linux-x64" "v0.0.0" >/dev/null 2>&1 )
check "verify_release_binary fails closed on missing sidecar" "$?" "1"

( curl() { printf '\n'; }
  VERIFY=1 verify_release_binary "$payload" "$url" "veyyon-linux-x64" "v0.0.0" >/dev/null 2>&1 )
check "verify_release_binary fails closed on empty sidecar" "$?" "1"

( curl() { return 22; }
  VERIFY=0 verify_release_binary "$payload" "$url" "veyyon-linux-x64" "v0.0.0" >/dev/null 2>&1 )
check "verify_release_binary honors --no-verify override" "$?" "0"

# --- link_alias: creates `vey` -> veyyon in the given dir ---
printf '#!/bin/sh\necho veyyon/0.0.0-test\n' > "$VEYYON_INSTALL_DIR/veyyon"
chmod +x "$VEYYON_INSTALL_DIR/veyyon"
link_alias "$VEYYON_INSTALL_DIR" >/dev/null 2>&1
check "link_alias created the vey symlink" "$( [ -L "$VEYYON_INSTALL_DIR/vey" ] && echo yes || echo no )" "yes"
check "vey resolves to veyyon" "$(readlink "$VEYYON_INSTALL_DIR/vey")" "$VEYYON_INSTALL_DIR/veyyon"

# --- completions_dir_for: per-shell XDG paths ---
# The runner may export XDG_DATA_HOME/XDG_CONFIG_HOME (GitHub's does), so the
# fallback assertions must unset them explicitly — otherwise "fish completions
# dir" resolves to $XDG_CONFIG_HOME/... and the check is environment-dependent
# (this exact drift failed CI). Cover BOTH the unset-fallback and the honored
# XDG-override branch so the contract install.sh implements is pinned either way.
( unset XDG_DATA_HOME XDG_CONFIG_HOME
  check "bash completions dir (XDG unset)" "$(completions_dir_for bash)" "$HOME/.local/share/bash-completion/completions"
  check "fish completions dir (XDG unset)" "$(completions_dir_for fish)" "$HOME/.config/fish/completions"
  check "zsh completions dir (XDG unset)" "$(completions_dir_for zsh)" "$HOME/.local/share/zsh/site-functions" )
( export XDG_DATA_HOME="/xdg/data" XDG_CONFIG_HOME="/xdg/config"
  check "bash completions dir honors XDG_DATA_HOME" "$(completions_dir_for bash)" "/xdg/data/bash-completion/completions"
  check "fish completions dir honors XDG_CONFIG_HOME" "$(completions_dir_for fish)" "/xdg/config/fish/completions" )

# --- ensure_on_path: writes the PATH line to the rc a NEW shell actually reads ---
# Locks the macOS login-shell bug: Terminal.app opens *login* bash shells, which
# read ~/.bash_profile (then ~/.bash_login, ~/.profile) and NOT ~/.bashrc, so a
# PATH line written only to ~/.bashrc never took effect and `veyyon` stayed
# off PATH after a fresh install. `uname` is shadowed to pin the OS, and SHELL
# selects the login shell; each case uses a dir that is NOT already on PATH so
# the early return does not short-circuit the rc-selection logic under test.
eop_home() { printf '%s' "$SANDBOX/eop-$1"; } # a fresh, empty HOME per case
run_eop() { # os, shell, dir  — returns nothing; writes into a per-case HOME
    _os="$1"; _shell="$2"; _dir="$3"; _h="$4"
    mkdir -p "$_h"
    ( uname() { [ "$1" = "-s" ] && printf '%s\n' "$_os" || command uname "$@"; }
      HOME="$_h"; SHELL="$_shell"
      ensure_on_path "$_dir" >/dev/null 2>&1 )
}
rc_has_dir() { [ -f "$1" ] && grep -Fq "$2" "$1" && echo yes || echo no; }

h="$(eop_home mac-bash)"
run_eop Darwin /bin/bash "/opt/mac-bash-bin" "$h"
check "macOS bash writes PATH to ~/.bash_profile, not ~/.bashrc" "$(rc_has_dir "$h/.bash_profile" /opt/mac-bash-bin)" "yes"
check "macOS bash did NOT write to ~/.bashrc" "$(rc_has_dir "$h/.bashrc" /opt/mac-bash-bin)" "no"

# macOS with a pre-existing ~/.profile: honor it (login bash reads it) rather
# than creating a second ~/.bash_profile that would then shadow ~/.profile.
h="$(eop_home mac-profile)"; mkdir -p "$h"; printf '# existing\n' > "$h/.profile"
run_eop Darwin /bin/bash "/opt/mac-profile-bin" "$h"
check "macOS bash appends to an existing ~/.profile" "$(rc_has_dir "$h/.profile" /opt/mac-profile-bin)" "yes"
check "macOS bash did not create a shadowing ~/.bash_profile" "$( [ -f "$h/.bash_profile" ] && echo present || echo absent )" "absent"

h="$(eop_home linux-bash)"
run_eop Linux /bin/bash "/opt/linux-bash-bin" "$h"
check "Linux bash writes PATH to ~/.bashrc" "$(rc_has_dir "$h/.bashrc" /opt/linux-bash-bin)" "yes"
check "Linux bash did NOT write to ~/.bash_profile" "$(rc_has_dir "$h/.bash_profile" /opt/linux-bash-bin)" "no"

h="$(eop_home zsh)"
run_eop Darwin /bin/zsh "/opt/zsh-bin" "$h"
check "zsh writes PATH to ~/.zshrc on any OS" "$(rc_has_dir "$h/.zshrc" /opt/zsh-bin)" "yes"

# --- do_uninstall: removes veyyon + vey from the sandboxed install dir only ---
do_uninstall >/dev/null 2>&1
check "uninstall removed veyyon" "$( [ -e "$VEYYON_INSTALL_DIR/veyyon" ] && echo present || echo gone )" "gone"
check "uninstall removed vey" "$( [ -e "$VEYYON_INSTALL_DIR/vey" ] && echo present || echo gone )" "gone"

# --- doctor: fails loudly when the binary does not run ---
printf '#!/bin/sh\nexit 3\n' > "$VEYYON_INSTALL_DIR/veyyon"
chmod +x "$VEYYON_INSTALL_DIR/veyyon"
( doctor "$VEYYON_INSTALL_DIR/veyyon" >/dev/null 2>&1 ); check "doctor dies when the binary fails --version" "$?" "1"

# --- finalize_binary: refuses an empty download, installs a good one atomically ---
# Locks the robustness fixes: a 0-byte download must NOT be installed (a wrong
# file would otherwise only be caught later by doctor, or not at all under
# --no-verify), and a good download must land executable with the temp file gone
# (chmod happens before the move, so the final path is never non-executable).
empty="$VEYYON_INSTALL_DIR/.veyyon.empty"
: > "$empty"
( finalize_binary "$empty" "$VEYYON_INSTALL_DIR/veyyon-empty-dest" >/dev/null 2>&1 )
check "finalize_binary rejects an empty download" "$?" "1"
check "finalize_binary left no dest for the empty case" "$( [ -e "$VEYYON_INSTALL_DIR/veyyon-empty-dest" ] && echo present || echo gone )" "gone"

good="$VEYYON_INSTALL_DIR/.veyyon.good"
dest="$VEYYON_INSTALL_DIR/veyyon-good-dest"
printf '#!/bin/sh\necho ok\n' > "$good"
( finalize_binary "$good" "$dest" >/dev/null 2>&1 ); check "finalize_binary installs a good download" "$?" "0"
check "finalize_binary moved the temp file away" "$( [ -e "$good" ] && echo present || echo gone )" "gone"
check "finalize_binary made the dest executable" "$( [ -x "$dest" ] && echo yes || echo no )" "yes"

# --- parse_release_tag: anchored extraction of the release tag ---
# Locks the hardened parse: the tag must come from the "tag_name" key
# specifically, survive extra fields / different key order / a single-line blob,
# and yield nothing (never a wrong token) when the key is absent.
check "parse_release_tag extracts a pretty-printed tag" \
    "$(printf '{\n  "url": "x",\n  "tag_name": "v1.2.3",\n  "name": "Release v1.2.3"\n}' | parse_release_tag)" "v1.2.3"
check "parse_release_tag is unfazed by key order" \
    "$(printf '{ "name": "later", "tag_name": "v9.9.9" }' | parse_release_tag)" "v9.9.9"
check "parse_release_tag handles a single-line blob" \
    "$(printf '{"assets":[],"tag_name":"v0.0.1-rc1","draft":false}' | parse_release_tag)" "v0.0.1-rc1"
check "parse_release_tag yields empty when tag_name is absent" \
    "$(printf '{ "name": "no tag here", "id": 42 }' | parse_release_tag)" ""

# --- gh_curl: attaches the auth header only when a token is set ---
# Raising the api.github.com rate limit must be opt-in via GITHUB_TOKEN/GH_TOKEN
# and must never send an Authorization header when no token is set (anonymous
# installs must keep working). curl is shadowed to echo its own arguments.
gh_args() { curl() { printf '%s\n' "$*"; }; gh_curl --max-time 5 "https://api.github.com/x"; }
check "gh_curl sends no auth header without a token" \
    "$( ( unset GITHUB_TOKEN GH_TOKEN; gh_args ) | grep -c 'Authorization' )" "0"
check "gh_curl sends a bearer header when GITHUB_TOKEN is set" \
    "$( ( GITHUB_TOKEN=secret123; unset GH_TOKEN; gh_args ) | grep -c 'Authorization: Bearer secret123' )" "1"
check "gh_curl falls back to GH_TOKEN" \
    "$( ( unset GITHUB_TOKEN; GH_TOKEN=ghsecret; gh_args ) | grep -c 'Authorization: Bearer ghsecret' )" "1"

# --- CURL_RETRY: every download retries transient failures ---
# Guards the ONE-PLACE retry knob so a refactor cannot silently drop retries
# from the network fetches. Uses only the ancient --retry flag for old-curl
# compatibility, so it must not pull in the 7.52+ --retry-connrefused.
check "CURL_RETRY requests retries" "$(printf '%s' "$CURL_RETRY" | grep -c -- '--retry ')" "1"
check "CURL_RETRY avoids the newer --retry-connrefused" "$(printf '%s' "$CURL_RETRY" | grep -c -- '--retry-connrefused')" "0"

# --- preserve_local_src_changes: never reset over uncommitted edits ---
# Locks the data-loss fix: the source update path runs `git reset --hard`, which
# used to silently discard a user's local edits to a tracked file in
# ~/.veyyon/src (an edited AGENTS.md vanished on every update). preserve_ now
# commits those edits to a durable `veyyon-local-<stamp>` branch first, so the
# reset never destroys work the installer did not create. These prove the edit
# survives an actual hard reset, that ignored build artifacts are not swept in,
# and that a clean tree stays a no-op.
if command -v git >/dev/null 2>&1; then
    make_repo() { # dir — a committed checkout with a gitignore
        d="$1"; rm -rf "$d"; mkdir -p "$d"
        ( cd "$d" && git init -q \
            && git config user.name t && git config user.email t@t \
            && printf 'committed\n' > AGENTS.md \
            && printf 'node_modules/\n' > .gitignore \
            && git add -A && git commit -qm init )
    }
    backup_branch() { ( cd "$1" && git branch --list 'veyyon-local-*' | tr -d ' *' | head -1 ); }

    make_repo "$SANDBOX/clean"
    ( preserve_local_src_changes "$SANDBOX/clean" >/dev/null 2>&1 ); check "preserve is a no-op on a clean repo" "$?" "0"
    check "clean repo gets no backup branch" "$( cd "$SANDBOX/clean" && git branch --list 'veyyon-local-*' | wc -l | tr -d ' ' )" "0"

    make_repo "$SANDBOX/dirty"
    printf 'MY LOCAL EDIT\n' > "$SANDBOX/dirty/AGENTS.md"
    ( preserve_local_src_changes "$SANDBOX/dirty" >/dev/null 2>&1 ); check "preserve succeeds on a modified tracked file" "$?" "0"
    bd=$(backup_branch "$SANDBOX/dirty")
    check "preserve created exactly one backup branch" "$( cd "$SANDBOX/dirty" && git branch --list 'veyyon-local-*' | wc -l | tr -d ' ' )" "1"
    # Simulate the update's destructive step: a hard reset discards the working edit...
    ( cd "$SANDBOX/dirty" && git reset -q --hard HEAD )
    check "hard reset cleared the working-tree edit" "$(cat "$SANDBOX/dirty/AGENTS.md")" "committed"
    # ...but the exact bytes are recoverable from the backup branch.
    check "backup branch preserves the exact edited bytes" "$( cd "$SANDBOX/dirty" && git show "$bd:AGENTS.md" )" "MY LOCAL EDIT"

    make_repo "$SANDBOX/untracked"
    printf 'brand new\n' > "$SANDBOX/untracked/notes.txt"
    ( preserve_local_src_changes "$SANDBOX/untracked" >/dev/null 2>&1 ); check "preserve succeeds with an untracked file" "$?" "0"
    bu=$(backup_branch "$SANDBOX/untracked")
    check "untracked file is captured on the backup branch" "$( cd "$SANDBOX/untracked" && git show "$bu:notes.txt" )" "brand new"

    make_repo "$SANDBOX/mixed"
    printf 'real edit\n' > "$SANDBOX/mixed/AGENTS.md"
    mkdir -p "$SANDBOX/mixed/node_modules"; printf 'junk\n' > "$SANDBOX/mixed/node_modules/x"
    ( preserve_local_src_changes "$SANDBOX/mixed" >/dev/null 2>&1 ); check "preserve succeeds on mixed real+ignored changes" "$?" "0"
    bm=$(backup_branch "$SANDBOX/mixed")
    check "backup holds the real edit" "$( cd "$SANDBOX/mixed" && git show "$bm:AGENTS.md" )" "real edit"
    check "backup does NOT sweep in gitignored node_modules" "$( cd "$SANDBOX/mixed" && git ls-tree -r --name-only "$bm" | grep -c node_modules )" "0"

    make_repo "$SANDBOX/ignored-only"
    mkdir -p "$SANDBOX/ignored-only/node_modules"; printf 'junk\n' > "$SANDBOX/ignored-only/node_modules/x"
    ( preserve_local_src_changes "$SANDBOX/ignored-only" >/dev/null 2>&1 ); check "ignored-only change is a no-op" "$?" "0"
    check "no backup branch for ignored-only changes" "$( cd "$SANDBOX/ignored-only" && git branch --list 'veyyon-local-*' | wc -l | tr -d ' ' )" "0"
else
    printf 'SKIP: git not available; preserve_local_src_changes tests skipped\n' >&2
fi

# --- move_aside_existing_src: relocate an existing tree instead of deleting it ---
# The clone path used to `rm -rf "$VEYYON_SRC_DIR"`. A non-empty tree (user files
# or a partial checkout with no .git) must be moved to `<dir>.bak-<stamp>`, never
# deleted; an empty dir is simply removed so a fresh clone can proceed.
nd="$SANDBOX/nongit"; rm -rf "$nd"; mkdir -p "$nd"; printf 'precious\n' > "$nd/keep.txt"
( move_aside_existing_src "$nd" >/dev/null 2>&1 ); check "move_aside relocates a non-empty dir" "$?" "0"
check "original path is cleared for a fresh clone" "$( [ -e "$nd" ] && echo present || echo gone )" "gone"
ndbak=$(ls -d "$nd".bak-* 2>/dev/null | head -1)
check "moved-aside backup keeps the file" "$( [ -f "$ndbak/keep.txt" ] && cat "$ndbak/keep.txt" )" "precious"

ed="$SANDBOX/emptydir"; rm -rf "$ed"; mkdir -p "$ed"
( move_aside_existing_src "$ed" >/dev/null 2>&1 ); check "move_aside removes an empty dir" "$?" "0"
check "empty dir was removed" "$( [ -e "$ed" ] && echo present || echo gone )" "gone"
check "empty dir left no backup" "$( ls -d "$ed".bak-* 2>/dev/null | wc -l | tr -d ' ' )" "0"

# --- src_has_local_work + uninstall never deletes preserved work ---
# Locks the second half of the data-loss fix: `--uninstall` used to `rm -rf`
# ~/.veyyon/src unconditionally, which would destroy a `veyyon-local-*`
# preservation branch (the user's recovered AGENTS.md edits) that a prior update
# had just saved. src_has_local_work must flag uncommitted edits, a non-git tree
# with user files, AND unpushed local branches; uninstall must then move the tree
# aside rather than delete it. A pristine, fully-pushed checkout is still removed.
if command -v git >/dev/null 2>&1; then
    make_cloned_repo() { # dir — a checkout with an origin so pushed == on-remote
        d="$1"; rm -rf "$d" "$d.origin"
        ( git init -q --bare "$d.origin" \
            && git clone -q "$d.origin" "$d" \
            && cd "$d" && git config user.name t && git config user.email t@t \
            && printf 'committed\n' > AGENTS.md && printf 'node_modules/\n' > .gitignore \
            && git add -A && git commit -qm init && git push -q origin HEAD:refs/heads/main \
            && git branch -q --set-upstream-to=origin/main 2>/dev/null ) >/dev/null 2>&1
    }

    make_cloned_repo "$SANDBOX/pristine"
    ( src_has_local_work "$SANDBOX/pristine" ); check "pristine pushed checkout reports no local work" "$?" "1"

    make_cloned_repo "$SANDBOX/dirtywork"
    printf 'MY EDIT\n' > "$SANDBOX/dirtywork/AGENTS.md"
    ( src_has_local_work "$SANDBOX/dirtywork" ); check "uncommitted edit is flagged as local work" "$?" "0"

    make_cloned_repo "$SANDBOX/branchwork"
    # Put a real unpushed commit on a preservation branch, working tree left clean.
    ( cd "$SANDBOX/branchwork" && git checkout -q -b veyyon-local-teststamp \
        && printf 'preserved edit\n' > AGENTS.md && git add -A && git commit -qm wip \
        && git checkout -q main )
    ( src_has_local_work "$SANDBOX/branchwork" ); check "unpushed veyyon-local branch is flagged as local work" "$?" "0"

    ngw="$SANDBOX/nongitwork"; rm -rf "$ngw"; mkdir -p "$ngw"; printf 'x\n' > "$ngw/file.txt"
    ( src_has_local_work "$ngw" ); check "non-git tree with files is flagged as local work" "$?" "0"

    # Full uninstall behavior: VEYYON_SRC_DIR with an unpushed preservation branch
    # must be MOVED ASIDE (recoverable), never rm -rf'd.
    us="$SANDBOX/uninstall-src"
    make_cloned_repo "$us"
    ( cd "$us" && git checkout -q -b veyyon-local-keep \
        && printf 'RECOVER ME\n' > AGENTS.md && git add -A && git commit -qm wip \
        && git checkout -q main )
    ( VEYYON_SRC_DIR="$us" INSTALL_DIR="$SANDBOX/nowhere" do_uninstall >/dev/null 2>&1 )
    check "uninstall did NOT delete a checkout holding unpushed work" "$( [ -e "$us" ] && echo present || echo gone )" "gone"
    usbak=$(ls -d "$us".bak-* 2>/dev/null | head -1)
    check "uninstall moved the checkout aside instead of deleting" "$( [ -d "$usbak/.git" ] && echo yes || echo no )" "yes"
    check "moved-aside checkout still has the recoverable edit" \
        "$( cd "$usbak" && git show veyyon-local-keep:AGENTS.md )" "RECOVER ME"

    # A pristine, fully-pushed checkout is removed outright (normal uninstall).
    up="$SANDBOX/uninstall-pristine"
    make_cloned_repo "$up"
    ( VEYYON_SRC_DIR="$up" INSTALL_DIR="$SANDBOX/nowhere" do_uninstall >/dev/null 2>&1 )
    check "uninstall removes a pristine pushed checkout outright" "$( [ -e "$up" ] && echo present || echo gone )" "gone"
    check "pristine uninstall left no move-aside backup" "$( ls -d "$up".bak-* 2>/dev/null | wc -l | tr -d ' ' )" "0"
else
    printf 'SKIP: git not available; src_has_local_work/uninstall tests skipped\n' >&2
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
