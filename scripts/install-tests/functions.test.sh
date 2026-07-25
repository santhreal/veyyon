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

# Results are tallied through a file, NOT shell variables. Many tests below run
# inside `( ... )` subshells to sandbox $HOME/$XDG_*; a variable incremented in a
# subshell is discarded when it exits, so an in-subshell failure used to print
# "FAIL:" and still leave the suite reporting "0 failed" with exit 0 — a green CI
# run hiding a real regression. Appending one line per assertion survives the
# subshell boundary, and single-line appends from concurrent subshells interleave
# safely.
RESULTS="$SANDBOX/.results"
: > "$RESULTS"
check() { # desc, actual, expected
    if [ "$2" = "$3" ]; then
        printf 'P\n' >> "$RESULTS"
    else
        printf 'F\n' >> "$RESULTS"
        printf 'FAIL: %s\n  expected [%s]\n  got      [%s]\n' "$1" "$3" "$2"
    fi
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

# --- link_alias: never destroy a file the installer did not create ---
# `ln -sf` unlinks whatever sits at the alias path first, so a user's OWN `vey`
# script in the install dir was silently deleted and replaced, unrecoverably.
# Only a link this installer could have made may be replaced.
( _d="$SANDBOX/alias-guard"
  mkdir -p "$_d"
  printf '#!/bin/sh\necho real veyyon\n' > "$_d/veyyon"; chmod +x "$_d/veyyon"

  # A user's own script at the alias path must survive, byte for byte.
  printf '#!/bin/sh\necho MY OWN SCRIPT\n' > "$_d/vey"; chmod +x "$_d/vey"
  out=$(link_alias "$_d" 2>&1)
  check "a user's own vey file is not deleted" "$(cat "$_d/vey")" "$(printf '#!/bin/sh\necho MY OWN SCRIPT\n')"
  check "the collision is reported, not silent" "$(printf '%s' "$out" | grep -c "left 'vey' alone")" "1"
  check "the message tells the user how to proceed" "$(printf '%s' "$out" | grep -c "launch with 'veyyon'")" "1"

  # A symlink pointing somewhere else is equally not ours to remove.
  rm -f "$_d/vey"; printf 'other\n' > "$_d/other-tool"; ln -s "$_d/other-tool" "$_d/vey"
  out=$(link_alias "$_d" 2>&1)
  check "a symlink to another tool is left in place" "$(readlink "$_d/vey")" "$_d/other-tool"
  check "the foreign symlink is reported" "$(printf '%s' "$out" | grep -c "symlink to something else")" "1"

  # Our own link is idempotent: a reinstall keeps it and says so.
  rm -f "$_d/vey"; ln -s "$_d/veyyon" "$_d/vey"
  out=$(link_alias "$_d" 2>&1)
  check "an existing correct link is kept" "$(readlink "$_d/vey")" "$_d/veyyon"
  check "a reinstall reports the alias already points at the binary" "$(printf '%s' "$out" | grep -c "already points at veyyon")" "1"

  # A dangling link has nothing to lose, so it is repaired rather than warned about.
  rm -f "$_d/vey"; ln -s "$_d/gone-away" "$_d/vey"
  out=$(link_alias "$_d" 2>&1)
  check "a broken link is repaired" "$(readlink "$_d/vey")" "$_d/veyyon"
  check "repairing a broken link is reported" "$(printf '%s' "$out" | grep -c "replaced a broken 'vey' link")" "1" )

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

# fish does not use `export PATH=`; it needs `fish_add_path`, written to
# ~/.config/fish/config.fish (a directory the installer may have to create).
h="$(eop_home fish)"
run_eop Linux /usr/bin/fish "/opt/fish-bin" "$h"
check "fish writes PATH to ~/.config/fish/config.fish" "$(rc_has_dir "$h/.config/fish/config.fish" /opt/fish-bin)" "yes"
check "fish uses fish_add_path, not export PATH" \
    "$(grep -c 'fish_add_path /opt/fish-bin' "$h/.config/fish/config.fish" 2>/dev/null)" "1"
check "fish config got no bash-style export line" \
    "$(grep -c 'export PATH' "$h/.config/fish/config.fish" 2>/dev/null)" "0"

# An unknown shell falls back to ~/.profile rather than writing nothing.
h="$(eop_home unknown-shell)"
run_eop Linux /usr/bin/somesh "/opt/unknown-bin" "$h"
check "an unrecognized shell falls back to ~/.profile" "$(rc_has_dir "$h/.profile" /opt/unknown-bin)" "yes"

# --- ensure_on_path: a reinstall must not tell you to do it yourself ---
# The three outcomes (no rc, already configured, freshly written) used to
# collapse into two, so a REINSTALL — where the rc already carries the line —
# warned "add $dir to your PATH" even though it was already configured and all
# the user needed was a new shell. The manual-action warning is reserved for the
# case where the installer genuinely could not do it.
h="$(eop_home already)"
run_eop Linux /bin/bash "/opt/already-bin" "$h"
check "first run writes the PATH line" "$(rc_has_dir "$h/.bashrc" /opt/already-bin)" "yes"
first_lines=$(grep -c 'already-bin' "$h/.bashrc")
out=$( uname() { printf 'Linux\n'; }; HOME="$h"; SHELL=/bin/bash; ensure_on_path "/opt/already-bin" 2>&1 )
check "a reinstall reports the dir is already configured" "$(printf '%s' "$out" | grep -c 'is already on PATH in')" "1"
check "a reinstall does NOT tell the user to add it manually" "$(printf '%s' "$out" | grep -c 'add /opt/already-bin to your PATH')" "0"
check "a reinstall points at the shell restart instead" "$(printf '%s' "$out" | grep -c 'restart your shell')" "1"
check "a reinstall does not duplicate the PATH line" "$(grep -c 'already-bin' "$h/.bashrc")" "$first_lines"

# --- completion_file_for: the one owner of per-shell completion filenames ---
# install_completions writes through this and do_uninstall removes through it, so
# a drift here used to mean an orphaned file surviving uninstall forever.
check "bash completion filename is the bare command name" "$(completion_file_for bash veyyon)" "veyyon"
check "zsh completion filename is underscore-prefixed" "$(completion_file_for zsh veyyon)" "_veyyon"
check "fish completion filename carries the .fish suffix" "$(completion_file_for fish veyyon)" "veyyon.fish"
check "the alias uses the same per-shell convention (bash)" "$(completion_file_for bash vey)" "vey"
check "the alias uses the same per-shell convention (fish)" "$(completion_file_for fish vey)" "vey.fish"

# --- install_completions: writes atomically, and covers the `vey` alias ---
# Two bugs locked out here. (1) The generated script was redirected straight onto
# its final path, so a half-written file (disk full, install killed) was left for
# the shell to source at next startup, breaking every new shell. (2) bash and fish
# autoload a completion file by the command name being completed, so binding only
# `veyyon` left `vey` — the alias the installer creates and the docs tell users to
# launch with — with no tab completion at all.
( _h="$SANDBOX/comp-home"
  export HOME="$_h"; export XDG_DATA_HOME="$_h/share"; export XDG_CONFIG_HOME="$_h/config"
  mkdir -p "$_h/bin"
  fakebin="$_h/bin/veyyon"
  # Stands in for the real binary: `completions --help` succeeds, and each shell
  # emits a marker line so the test can assert real content, not just a nonempty file.
  printf '#!/bin/sh\ncase "$1 $2" in\n  "completions --help") exit 0 ;;\n  "completions bash") echo "complete -F _veyyon veyyon vey"; exit 0 ;;\n  "completions zsh") echo "#compdef veyyon vey"; exit 0 ;;\n  "completions fish") echo "complete -c vey -w veyyon"; exit 0 ;;\nesac\nexit 1\n' > "$fakebin"
  chmod +x "$fakebin"
  # link_alias runs before install_completions, so the alias is already ours here.
  ln -s "$fakebin" "$_h/bin/vey"
  install_completions "$fakebin" >/dev/null 2>&1

  bashdir="$(completions_dir_for bash)"; zshdir="$(completions_dir_for zsh)"; fishdir="$(completions_dir_for fish)"
  check "bash completion installed for veyyon" "$(cat "$bashdir/veyyon" 2>/dev/null)" "complete -F _veyyon veyyon vey"
  check "bash completion installed for the vey alias" "$(cat "$bashdir/vey" 2>/dev/null)" "complete -F _veyyon veyyon vey"
  check "zsh completion installed as _veyyon" "$(cat "$zshdir/_veyyon" 2>/dev/null)" "#compdef veyyon vey"
  # zsh binds both names from the one autoloaded file's #compdef line, so a second
  # file would be dead weight — assert it is deliberately NOT written.
  check "zsh gets no redundant alias file (#compdef names both)" "$( [ -e "$zshdir/_vey" ] && echo present || echo absent )" "absent"
  check "fish completion installed for veyyon" "$(cat "$fishdir/veyyon.fish" 2>/dev/null)" "complete -c vey -w veyyon"
  check "fish completion installed for the vey alias" "$(cat "$fishdir/vey.fish" 2>/dev/null)" "complete -c vey -w veyyon"
  check "no temp completion files were left behind" "$(ls -A "$bashdir" | grep -c '^\.')" "0"

  # A failing generator must leave NO file at the final path — not an empty one,
  # and not a stale partial. This is the atomic-write half of the contract.
  failbin="$_h/veyyon-failing"
  printf '#!/bin/sh\n[ "$1 $2" = "completions --help" ] && exit 0\nexit 7\n' > "$failbin"
  chmod +x "$failbin"
  rm -f "$bashdir/veyyon" "$bashdir/vey"
  install_completions "$failbin" >/dev/null 2>&1
  check "a failing generator installs no bash completion" "$( [ -e "$bashdir/veyyon" ] && echo present || echo absent )" "absent"
  check "a failing generator leaves no temp file" "$(ls -A "$bashdir" | wc -l | tr -d ' ')" "0"

  # Uninstall reclaims every file install wrote, alias included.
  install_completions "$fakebin" >/dev/null 2>&1
  ( INSTALL_DIR="$SANDBOX/nowhere" do_uninstall >/dev/null 2>&1 )
  check "uninstall removed the bash completion" "$( [ -e "$bashdir/veyyon" ] && echo present || echo absent )" "absent"
  check "uninstall removed the bash alias completion" "$( [ -e "$bashdir/vey" ] && echo present || echo absent )" "absent"
  check "uninstall removed the zsh completion" "$( [ -e "$zshdir/_veyyon" ] && echo present || echo absent )" "absent"
  check "uninstall removed the fish completion" "$( [ -e "$fishdir/veyyon.fish" ] && echo present || echo absent )" "absent"
  check "uninstall removed the fish alias completion" "$( [ -e "$fishdir/vey.fish" ] && echo present || echo absent )" "absent" )

# --- ALIAS_IS_OURS: the completion half of the no-clobber rule ---
# link_alias refuses to overwrite a `vey` the user owns. install_completions ran
# afterwards regardless, writing completions/vey — a file that both describes the
# wrong command (it completes OUR subcommands for THEIR tool) and destroys the
# completion script their tool shipped. Declining the alias has to decline its
# completion too, or the no-clobber fix only half holds.
( _h="$SANDBOX/comp-foreign"
  export HOME="$_h"; export XDG_DATA_HOME="$_h/share"; export XDG_CONFIG_HOME="$_h/config"
  mkdir -p "$_h/bin"
  fakebin="$_h/bin/veyyon"
  printf '#!/bin/sh\ncase "$1 $2" in\n  "completions --help") exit 0 ;;\n  "completions bash") echo "complete -F _veyyon veyyon vey"; exit 0 ;;\n  "completions zsh") echo "#compdef veyyon vey"; exit 0 ;;\n  "completions fish") echo "complete -c vey -w veyyon"; exit 0 ;;\nesac\nexit 1\n' > "$fakebin"
  chmod +x "$fakebin"

  # link_alias is the single owner of the verdict, and every one of its exits
  # must set it: a path that forgets leaves a stale value from the previous call
  # and the completion/doctor decisions silently follow the wrong answer.
  ALIAS_IS_OURS=1
  link_alias "$_h/bin" >/dev/null 2>&1
  check "no alias present at all: link_alias creates one and claims it" "$ALIAS_IS_OURS" "1"

  # Someone else's `vey`: a real file, exactly what link_alias leaves untouched.
  rm -f "$_h/bin/vey"; printf '#!/bin/sh\necho other tool\n' > "$_h/bin/vey"; chmod +x "$_h/bin/vey"
  link_alias "$_h/bin" >/dev/null 2>&1
  check "a regular file named vey is not ours" "$ALIAS_IS_OURS" "0"

  # A symlink, but to something else entirely — still not ours to replace.
  rm -f "$_h/bin/vey"; printf 'x\n' > "$_h/bin/somebody-else"; ln -s "$_h/bin/somebody-else" "$_h/bin/vey"
  link_alias "$_h/bin" >/dev/null 2>&1
  check "a symlink to another target is not ours" "$ALIAS_IS_OURS" "0"

  # A dangling link has nothing to lose: link_alias repairs it and it is ours.
  rm -f "$_h/bin/vey"; ln -s "$_h/bin/gone-away" "$_h/bin/vey"
  link_alias "$_h/bin" >/dev/null 2>&1
  check "a repaired broken link is ours" "$ALIAS_IS_OURS" "1"

  rm -f "$_h/bin/vey"; ln -s "$fakebin" "$_h/bin/vey"
  link_alias "$_h/bin" >/dev/null 2>&1
  check "a symlink to our binary is ours" "$ALIAS_IS_OURS" "1"

  # Now the behavior: restore the foreign `vey` plus the completion file its own
  # installer wrote, and prove install_completions leaves both alone.
  rm -f "$_h/bin/vey"; printf '#!/bin/sh\necho other tool\n' > "$_h/bin/vey"
  bashdir="$(completions_dir_for bash)"; fishdir="$(completions_dir_for fish)"
  mkdir -p "$bashdir" "$fishdir"
  printf 'complete -F _their_tool vey\n' > "$bashdir/vey"
  printf 'complete -c vey -a their-subcommand\n' > "$fishdir/vey.fish"
  link_alias "$_h/bin" >/dev/null 2>&1
  install_completions "$fakebin" >/dev/null 2>&1

  check "our own bash completion is still installed" "$(cat "$bashdir/veyyon" 2>/dev/null)" "complete -F _veyyon veyyon vey"
  check "a foreign vey keeps its bash completion" "$(cat "$bashdir/vey" 2>/dev/null)" "complete -F _their_tool vey"
  check "a foreign vey keeps its fish completion" "$(cat "$fishdir/vey.fish" 2>/dev/null)" "complete -c vey -a their-subcommand"

  # And uninstall must not reclaim what install declined to write, either.
  ( INSTALL_DIR="$SANDBOX/nowhere" do_uninstall >/dev/null 2>&1 )
  check "uninstall leaves a foreign vey bash completion" "$(cat "$bashdir/vey" 2>/dev/null)" "complete -F _their_tool vey"
  check "uninstall leaves a foreign vey fish completion" "$(cat "$fishdir/vey.fish" 2>/dev/null)" "complete -c vey -a their-subcommand" )
unset XDG_DATA_HOME XDG_CONFIG_HOME
export HOME="$SANDBOX/home"

# --- do_uninstall: removes veyyon + vey from the sandboxed install dir only ---
do_uninstall >/dev/null 2>&1
check "uninstall removed veyyon" "$( [ -e "$VEYYON_INSTALL_DIR/veyyon" ] && echo present || echo gone )" "gone"
check "uninstall removed vey" "$( [ -e "$VEYYON_INSTALL_DIR/vey" ] && echo present || echo gone )" "gone"

# --- do_uninstall: reclaims the native addon cache but never user data ---
# A binary install stages ~150MB per version under getNativesDir()
# (~/.veyyon/natives/<version>/*.node). Uninstall must reclaim that cache, or a
# reinstall silently inherits stale addons and the disk is never freed. It must
# do so surgically: sibling auth/config/sessions under ~/.veyyon are the user's
# data and survive an uninstall. This locks both halves.
( _h="$SANDBOX/uninst-natives-home"
  export HOME="$_h"; unset XDG_DATA_HOME
  mkdir -p "$_h/.veyyon/natives/1.0.37" "$_h/.veyyon/sessions"
  printf 'STAGED-ADDON' > "$_h/.veyyon/natives/1.0.37/veyyon_natives.linux-x64-modern.node"
  printf '{"token":"keep-me"}' > "$_h/.veyyon/auth.json"
  printf 'session-data' > "$_h/.veyyon/sessions/a.json"
  ( INSTALL_DIR="$SANDBOX/nowhere" do_uninstall >/dev/null 2>&1 )
  check "uninstall removed the native addon cache (~/.veyyon/natives)" "$( [ -e "$_h/.veyyon/natives" ] && echo present || echo gone )" "gone"
  check "uninstall preserved ~/.veyyon/auth.json (user credentials)" "$(cat "$_h/.veyyon/auth.json" 2>/dev/null)" '{"token":"keep-me"}'
  check "uninstall preserved ~/.veyyon/sessions (user data)" "$( [ -d "$_h/.veyyon/sessions" ] && echo present || echo gone )" "present" )

# --- do_uninstall: honors XDG_DATA_HOME exactly as getNativesDir() does ---
# getNativesDir() uses $XDG_DATA_HOME/veyyon/natives ONLY when $XDG_DATA_HOME/veyyon
# already exists; uninstall must remove the same path it would have written, and
# must NOT invent an XDG cache when the loader would have fallen back to ~/.veyyon.
( _h="$SANDBOX/uninst-xdg-home"; _x="$SANDBOX/uninst-xdg-data"
  export HOME="$_h" XDG_DATA_HOME="$_x"
  mkdir -p "$_x/veyyon/natives/1.0.37" "$_h/.veyyon/natives/1.0.37"
  printf 'XDG-ADDON' > "$_x/veyyon/natives/1.0.37/veyyon_natives.linux-x64-modern.node"
  printf 'HOME-ADDON' > "$_h/.veyyon/natives/1.0.37/veyyon_natives.linux-x64-modern.node"
  ( INSTALL_DIR="$SANDBOX/nowhere" do_uninstall >/dev/null 2>&1 )
  check "uninstall removed the XDG native cache when \$XDG_DATA_HOME/veyyon exists" "$( [ -e "$_x/veyyon/natives" ] && echo present || echo gone )" "gone"
  # The loader would resolve to the XDG path here, so ~/.veyyon/natives is NOT the
  # active cache and uninstall leaves it (only the active getNativesDir cache is
  # reclaimed — matching the loader's single-location contract, never both).
  check "uninstall left the inactive ~/.veyyon/natives when XDG is active" "$( [ -e "$_h/.veyyon/natives" ] && echo present || echo gone )" "present" )

# --- do_uninstall: sweeps an addon staged beside the binary ---
# A compiled binary probes for a sibling addon, so one left behind by the version
# being removed would be loaded by whatever binary lands there next.
( _d="$SANDBOX/sibling-addon-bin"
  mkdir -p "$_d"
  printf 'ADDON' > "$_d/veyyon_natives.linux-x64-modern.node"
  printf 'BIN' > "$_d/veyyon"
  ( INSTALL_DIR="$_d" do_uninstall >/dev/null 2>&1 )
  check "uninstall swept the addon staged beside the binary" "$( [ -e "$_d/veyyon_natives.linux-x64-modern.node" ] && echo present || echo gone )" "gone" )
unset XDG_DATA_HOME
export HOME="$SANDBOX/home"

# --- doctor: fails loudly when the binary does not run ---
printf '#!/bin/sh\nexit 3\n' > "$VEYYON_INSTALL_DIR/veyyon"
chmod +x "$VEYYON_INSTALL_DIR/veyyon"
( doctor "$VEYYON_INSTALL_DIR/veyyon" >/dev/null 2>&1 ); check "doctor dies when the binary fails --version" "$?" "1"

# --- dir_of: pure-shell dirname, so doctor survives a broken PATH ---
# doctor exists to diagnose PATH problems, so it cannot depend on forking an
# external `dirname` that a broken PATH would fail to resolve. These pin the
# edge cases that separate parameter expansion from real dirname.
check "dir_of returns the parent of a normal path" "$(dir_of /home/u/.local/bin/veyyon)" "/home/u/.local/bin"
check "dir_of returns / for a path directly under root" "$(dir_of /veyyon)" "/"
check "dir_of returns . for a bare name with no slash" "$(dir_of veyyon)" "."
check "dir_of handles a relative path" "$(dir_of ./dist/vey)" "./dist"
check "dir_of handles a path containing spaces" "$(dir_of "/opt/my apps/bin/veyyon")" "/opt/my apps/bin"

# --- staging_path: concurrent installers must not share a staging file ---
# Both staging paths were fixed names, so two installers running at once wrote
# the SAME file: one truncated the other's partial download mid-transfer, and
# each process's EXIT trap deleted that path out from under the other. The path
# must be per-process, and must stay inside the install dir so finalize_binary's
# rename remains within one filesystem (a cross-device rename is not atomic).
check "staging_path lives in the install dir" "$(staging_path download | sed "s|/[^/]*$||")" "$VEYYON_INSTALL_DIR"
check "staging_path is hidden and carries the kind" "$(staging_path download | sed 's|.*/||' | cut -d. -f1-3)" ".veyyon.download"
check "staging_path ends with this process id" "$(staging_path download | sed 's|.*\.||')" "$$"
check "the two staging kinds never collide" "$( [ "$(staging_path download)" = "$(staging_path local)" ] && echo same || echo distinct )" "distinct"
# A different process must yield a different path — the whole point of the
# change. Resolved in a real child shell (so $$ genuinely differs) and asserted
# non-empty first, otherwise a failed child would make "distinct" pass for the
# wrong reason.
# The root goes through the environment, not a positional: install.sh parses
# "$@" even when sourced, so an extra argument is read as an unknown option and
# aborts the child.
other_staging=$(VEYYON_INSTALL_SOURCED=1 VEYYON_INSTALL_DIR="$VEYYON_INSTALL_DIR" VEYYON_TEST_ROOT="$ROOT" \
    sh -c '. "$VEYYON_TEST_ROOT/scripts/install.sh" >/dev/null 2>&1; staging_path download')
check "a child shell resolves a staging path at all" "$( [ -n "$other_staging" ] && echo yes || echo no )" "yes"
check "another process gets a different staging path" \
    "$( [ "$(staging_path download)" = "$other_staging" ] && echo same || echo distinct )" "distinct"

# --- version_from_output: pull the semver out of a --version line ---
# doctor compares the installed binary's reported version against the release
# tag, so this parser is what stands between a mismatched release and a silent
# wrong-version install. It must return nothing (non-zero) rather than guess.
check "version_from_output reads the standard name/semver form" "$(version_from_output 'veyyon/1.0.37')" "1.0.37"
check "version_from_output keeps a prerelease suffix" "$(version_from_output 'veyyon/1.0.0-rc.2')" "1.0.0-rc.2"
check "version_from_output ignores trailing platform detail" "$(version_from_output 'veyyon/1.2.3 linux-x64')" "1.2.3"
check "version_from_output reads a bare semver" "$(version_from_output '2.0.1')" "2.0.1"
( version_from_output 'veyyon (no version here)' >/dev/null 2>&1 ); check "version_from_output fails on a line with no semver" "$?" "1"

# --- doctor: the installed binary must report the version the release claims ---
# The checksum proves the bytes match the published asset; this proves the asset
# is the version the tag claims. A release that uploaded a mismatched binary, or
# a stale cached download, otherwise installs "successfully" and runs the wrong
# version forever. The self-updater enforces the same gate before keeping a
# swapped-in binary; install.sh did not, which is the parity gap this closes.
( _d="$SANDBOX/vercheck"
  mkdir -p "$_d"
  printf '#!/bin/sh\necho veyyon/1.0.37\n' > "$_d/veyyon"; chmod +x "$_d/veyyon"

  out=$( PATH="$_d:$PATH" doctor "$_d/veyyon" "v1.0.37" 2>&1 )
  check "doctor confirms a matching version" "$(printf '%s' "$out" | grep -c 'reported version matches the v1.0.37 release')" "1"
  ( PATH="$_d:$PATH" doctor "$_d/veyyon" "v1.0.37" >/dev/null 2>&1 ); check "a matching version exits 0" "$?" "0"

  # Mismatch is fatal: the installer must not print "Installation complete" over
  # a binary that is not the requested version.
  out=$( PATH="$_d:$PATH" doctor "$_d/veyyon" "v1.0.40" 2>&1 )
  ( PATH="$_d:$PATH" doctor "$_d/veyyon" "v1.0.40" >/dev/null 2>&1 ); check "a version mismatch is fatal" "$?" "1"
  check "the mismatch names the version actually installed" "$(printf '%s' "$out" | grep -c 'reports 1.0.37')" "1"
  check "the mismatch names the release that was requested" "$(printf '%s' "$out" | grep -c 'v1.0.40 release was requested')" "1"
  check "the mismatch tells the user the file on disk is wrong" "$(printf '%s' "$out" | grep -c "$_d/veyyon is NOT the version")" "1"

  # A tag without the leading v compares the same way.
  ( PATH="$_d:$PATH" doctor "$_d/veyyon" "1.0.37" >/dev/null 2>&1 ); check "a bare tag (no leading v) still matches" "$?" "0"

  # No expected tag (source installs) skips the check entirely rather than
  # inventing an expectation.
  ( PATH="$_d:$PATH" doctor "$_d/veyyon" >/dev/null 2>&1 ); check "doctor without a tag skips the version gate" "$?" "0"
  out=$( PATH="$_d:$PATH" doctor "$_d/veyyon" 2>&1 )
  check "no tag means no version-match line" "$(printf '%s' "$out" | grep -c 'reported version matches')" "0"

  # An unparseable --version line fails closed instead of passing the gate.
  printf '#!/bin/sh\necho veyyon build unknown\n' > "$_d/veyyon"; chmod +x "$_d/veyyon"
  ( PATH="$_d:$PATH" doctor "$_d/veyyon" "v1.0.37" >/dev/null 2>&1 ); check "an unreadable version fails closed" "$?" "1" )

# --- doctor: detects a stale copy shadowing the fresh install ---
# The classic silent install failure: an older veyyon/vey earlier on PATH (a
# previous `bun add -g`, a distro package, a manual copy) keeps winning every
# invocation while the installer reports success, so the user "upgrades" and
# nothing changes. doctor used to check only that the name existed SOMEWHERE on
# PATH, which is exactly the state a shadowed install is in. It must now compare
# where the name actually resolves against where the binary was just installed.
( _d="$SANDBOX/shadow"
  mine="$_d/mine"; older="$_d/older"
  mkdir -p "$mine" "$older"
  printf '#!/bin/sh\necho veyyon/9.9.9\n' > "$mine/veyyon"; chmod +x "$mine/veyyon"
  ln -sf "$mine/veyyon" "$mine/vey"
  printf '#!/bin/sh\necho veyyon/0.0.1\n' > "$older/veyyon"; chmod +x "$older/veyyon"
  ln -sf "$older/veyyon" "$older/vey"

  # Healthy: the install dir wins PATH, so both names resolve to it.
  out=$( PATH="$mine:$PATH" doctor "$mine/veyyon" 2>&1 )
  check "doctor confirms veyyon resolves to the fresh install" "$(printf '%s' "$out" | grep -c "'veyyon' on PATH resolves to this install")" "1"
  check "doctor confirms the vey alias resolves to the fresh install" "$(printf '%s' "$out" | grep -c "'vey' on PATH resolves to this install")" "1"
  check "a healthy doctor warns about nothing" "$(printf '%s' "$out" | grep -c '!!')" "0"

  # Shadowed: an older copy earlier on PATH wins. doctor must name the offender.
  out=$( PATH="$older:$mine:$PATH" doctor "$mine/veyyon" 2>&1 )
  check "doctor reports veyyon is shadowed" "$(printf '%s' "$out" | grep -c "'veyyon' on PATH resolves to $older/veyyon")" "1"
  check "doctor reports the vey alias is shadowed" "$(printf '%s' "$out" | grep -c "'vey' on PATH resolves to $older/vey")" "1"
  check "the shadow warning names the install dir that lost" "$(printf '%s' "$out" | grep -c "just installed in $mine")" "2"
  check "shadowing is surfaced as a warning, not swallowed" "$(printf '%s' "$out" | grep -c '!!')" "2"
  # Shadowing must not be fatal: the binary itself is fine and the user can fix
  # PATH, so doctor reports and exits 0 rather than failing the whole install.
  ( PATH="$older:$mine:$PATH" doctor "$mine/veyyon" >/dev/null 2>&1 ); check "a shadowed install is reported but not fatal" "$?" "0"

  # Not on PATH at all: a distinct message telling the user what to add.
  out=$( PATH="/nonexistent-dir-for-test" doctor "$mine/veyyon" 2>&1 )
  check "doctor tells the user to add the dir when the name is absent from PATH" "$(printf '%s' "$out" | grep -c "add $mine to PATH")" "2"

  # The alias branch must survive that same broken PATH. It briefly asked
  # `readlink` whether the alias was ours, which cannot run when PATH is empty —
  # the exact situation doctor exists to diagnose — so the alias silently read as
  # "not ours" and its check was skipped without a word. link_alias records the
  # verdict instead, and reading a variable cannot fail.
  link_alias "$mine" >/dev/null 2>&1
  out=$( PATH="/nonexistent-dir-for-test" doctor "$mine/veyyon" 2>&1 )
  check "doctor still checks our alias with no usable PATH" "$(printf '%s' "$out" | grep -c "'vey' not on PATH yet")" "1"
  check "doctor never claims our own alias is foreign" "$(printf '%s' "$out" | grep -c "'vey' is not ours")" "0" )

# --- doctor: no shadow warning for a `vey` the installer never created ---
# link_alias declines when the user already owns `vey`, but doctor still ran the
# shadow check on that name — so the install ended by telling the user their own
# command "shadows the copy just installed" and to remove it, about an alias this
# installer deliberately did not create. Two sentences flatly contradicting each
# other, one of them false. The alias check now runs only when the alias is ours.
( _d="$SANDBOX/doctor-foreign-alias"
  mkdir -p "$_d"
  printf '#!/bin/sh\necho veyyon/9.9.9\n' > "$_d/veyyon"; chmod +x "$_d/veyyon"
  # The user's own vey, exactly what link_alias refuses to touch.
  printf '#!/bin/sh\necho their tool\n' > "$_d/vey"; chmod +x "$_d/vey"
  # link_alias runs first in every real install and is what records the verdict.
  link_alias "$_d" >/dev/null 2>&1

  out=$( PATH="$_d:$PATH" doctor "$_d/veyyon" 2>&1 )
  check "the binary itself is still checked" "$(printf '%s' "$out" | grep -c "'veyyon' on PATH resolves to this install")" "1"
  check "a foreign vey is never called a shadow" "$(printf '%s' "$out" | grep -c "'vey' on PATH resolves to")" "0"
  check "doctor does not tell the user to remove their own vey" "$(printf '%s' "$out" | grep -c 'Remove it')" "0"
  check "doctor says the alias is not ours" "$(printf '%s' "$out" | grep -c "'vey' is not ours")" "1"
  check "doctor points at the name that does work" "$(printf '%s' "$out" | grep -c "launch with 'veyyon'")" "1"
  check "a foreign alias warns about nothing" "$(printf '%s' "$out" | grep -c '!!')" "0"
  ( PATH="$_d:$PATH" doctor "$_d/veyyon" >/dev/null 2>&1 ); check "a foreign alias is not fatal" "$?" "0"

  # And when the alias IS ours, the shadow check still runs in full.
  rm -f "$_d/vey"; link_alias "$_d" >/dev/null 2>&1
  out=$( PATH="$_d:$PATH" doctor "$_d/veyyon" 2>&1 )
  check "our own alias is still shadow-checked" "$(printf '%s' "$out" | grep -c "'vey' on PATH resolves to this install")" "1" )

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

# --- fetch_lfs_assets: LFS content is fetched or the install stops ---
# The old line was `has git-lfs && ( cd ... && git lfs pull ) || true`. With
# git-lfs absent, or with the pull failing, every LFS-tracked file stays a
# ~130-byte pointer TEXT file while the installer prints success — the file
# looks present and veyyon dies on it later. .gitattributes puts `*.wasm` under
# LFS, so this becomes live the moment a wasm asset lands. These lock the
# decision: no LFS content means no-op, LFS content with no git-lfs means stop.
if command -v git >/dev/null 2>&1; then
  ( _r="$SANDBOX/lfs-none"
    mkdir -p "$_r" && cd "$_r" || exit 0
    git init -q . 2>/dev/null && git config user.email t@t && git config user.name t
    printf 'hi\n' > a.txt && git add a.txt && git commit -qm init 2>/dev/null

    # A checkout with no LFS-tracked file at all.
    check "no LFS-tracked file is reported for a plain checkout" "$(lfs_tracked_file "$_r")" ""
    ( has() { case "$1" in git-lfs) return 1 ;; *) command -v "$1" >/dev/null 2>&1 ;; esac; }
      fetch_lfs_assets "$_r" >/dev/null 2>&1 )
    check "a plain checkout installs fine without git-lfs" "$?" "0"

    # Today's real repo state: .gitattributes DECLARES an LFS filter, but no
    # tracked file matches it. That must not block an install, or every source
    # install without git-lfs breaks on a rule that governs zero files.
    printf '*.wasm filter=lfs diff=lfs merge=lfs -text\n' > .gitattributes
    git add .gitattributes && git commit -qm attrs 2>/dev/null
    check "a declaration matching no file is not LFS-tracked content" "$(lfs_tracked_file "$_r")" ""
    ( has() { case "$1" in git-lfs) return 1 ;; *) command -v "$1" >/dev/null 2>&1 ;; esac; }
      fetch_lfs_assets "$_r" >/dev/null 2>&1 )
    check "an unmatched LFS declaration does not block the install" "$?" "0"

    # Now a file the filter actually matches: this checkout genuinely needs LFS.
    printf 'pointer\n' > shipped.wasm
    git add shipped.wasm && git commit -qm wasm 2>/dev/null
    check "a matching file is reported as LFS-tracked" "$(lfs_tracked_file "$_r")" "shipped.wasm"

    _out=$( ( has() { case "$1" in git-lfs) return 1 ;; *) command -v "$1" >/dev/null 2>&1 ;; esac; }
            fetch_lfs_assets "$_r" ) 2>&1 )
    check "a checkout needing LFS without git-lfs stops the install" "$?" "1"
    # The message has to name the consequence and the fix, not just say no.
    check "the stop names git-lfs as the fix" "$(printf '%s' "$_out" | grep -c 'git-lfs is not installed')" "1"
    check "the stop explains pointer text, not a bare failure" "$(printf '%s' "$_out" | grep -c 'pointer text')" "1"
    check "the stop links where to get git-lfs" "$(printf '%s' "$_out" | grep -c 'https://git-lfs.com')" "1" )
fi

# `grep -c` already prints 0 when nothing matches (and exits 1); a `|| echo 0`
# fallback would append a SECOND zero and make the arithmetic below choke.
PASS=$(grep -c '^P$' "$RESULTS" 2>/dev/null); PASS=${PASS:-0}
FAIL=$(grep -c '^F$' "$RESULTS" 2>/dev/null); FAIL=${FAIL:-0}
# A run that recorded nothing is a broken harness, not a pass: fail closed rather
# than report "0 passed, 0 failed" and exit 0.
if [ "$((PASS + FAIL))" -eq 0 ]; then
    printf '\nno assertions recorded — the harness did not run (%s missing?)\n' "$RESULTS" >&2
    exit 1
fi
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
