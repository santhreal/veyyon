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

INSTALL_SH="$ROOT/scripts/install.sh"
VEYYON_INSTALL_SOURCED=1 . "$INSTALL_SH"
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

# --- parse_sha256_sidecar: what counts as a published checksum ---
# The sidecar is the only thing standing between a user and a binary someone
# else served. A reader that accepts any first token compares the real digest
# against whatever the body happened to start with, and reports "checksum
# mismatch" — telling the user their download is corrupt when the download was
# fine and the sidecar was an error page. Held to the same contract as the
# TypeScript owner in packages/natives/src/sha256-sidecar.ts.
sixty_four="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

check "parse_sha256_sidecar reads real sha256sum output" \
    "$(parse_sha256_sidecar "$sixty_four  veyyon-linux-x64")" "$sixty_four"
check "parse_sha256_sidecar reads a bare digest with no filename" \
    "$(parse_sha256_sidecar "$sixty_four")" "$sixty_four"
# Lowercasing is what lets an uppercase sidecar verify a byte-identical file;
# a raw string comparison against sha256sum's lowercase output called it tampering.
check "parse_sha256_sidecar lowercases an uppercase digest" \
    "$(parse_sha256_sidecar "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA  veyyon")" "$sixty_four"
check "parse_sha256_sidecar tolerates leading whitespace and a * filename marker" \
    "$(parse_sha256_sidecar "   $sixty_four *veyyon.exe")" "$sixty_four"
check "parse_sha256_sidecar rejects an HTML error page" \
    "$(parse_sha256_sidecar "<!DOCTYPE html>
<html>Not Found</html>")" ""
check "parse_sha256_sidecar rejects a rate-limit JSON body" \
    "$(parse_sha256_sidecar '{"message":"API rate limit exceeded"}')" ""
check "parse_sha256_sidecar rejects a truncated digest" \
    "$(parse_sha256_sidecar "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  veyyon")" ""
check "parse_sha256_sidecar rejects an over-long digest" \
    "$(parse_sha256_sidecar "${sixty_four}a  veyyon")" ""
check "parse_sha256_sidecar rejects 64 non-hex characters" \
    "$(parse_sha256_sidecar "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg  veyyon")" ""
check "parse_sha256_sidecar rejects an empty body" "$(parse_sha256_sidecar "")" ""
check "parse_sha256_sidecar rejects a whitespace-only body" "$(parse_sha256_sidecar "   ")" ""
# sha256sum never emits the filename first. Scanning the whole body for anything
# digest-shaped is how a field elsewhere in a response gets promoted to the
# expected hash.
check "parse_sha256_sidecar rejects a digest that is not the first token" \
    "$(parse_sha256_sidecar "veyyon-linux-x64  $sixty_four")" ""
# A concatenated sidecar must never verify against the wrong asset's digest.
check "parse_sha256_sidecar takes only the first line" \
    "$(parse_sha256_sidecar "$sixty_four  veyyon-linux-x64
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  veyyon-darwin-arm64")" "$sixty_four"

# An HTML sidecar must be refused as unparseable, NOT reported as a mismatch.
( curl() { printf '<!DOCTYPE html>\n<html>Not Found</html>\n'; }
  VERIFY=1 verify_release_binary "$payload" "$url" "veyyon-linux-x64" "v0.0.0" 2>&1 | grep -q "empty/unparseable" )
check "verify_release_binary calls an HTML sidecar unparseable, not a mismatch" "$?" "0"

# --- verify_sha256: an uppercase expected digest is not tampering ---
( verify_sha256 "$payload" "$(printf '%s' "$real" | tr 'a-f' 'A-F')" >/dev/null 2>&1 )
check "verify_sha256 compares case-insensitively" "$?" "0"

# --- doctor_natives: the phase label, and what it refuses ---
# The preflight run probes the STAGED download so a release with no build for
# this platform never reaches the install dir, the alias, the shell profile or
# the completion files. Both runs are the same function; only the wording moves.
nat_dir="$SANDBOX/natives"
mkdir -p "$nat_dir"

# A staged download that runs a search correctly.
cat > "$nat_dir/good" <<'STUB'
#!/bin/sh
[ "$1" = "grep" ] && [ "$2" = "--help" ] && exit 0
[ "$1" = "grep" ] && { printf '%s/probe.txt:1: %s\n' "$3" "$2"; exit 0; }
echo "veyyon/9.9.9"
STUB
chmod +x "$nat_dir/good"

# A staged download whose addon did not load: the musl / wrong-arch shape.
cat > "$nat_dir/noaddon" <<'STUB'
#!/bin/sh
[ "$1" = "grep" ] && [ "$2" = "--help" ] && exit 0
[ "$1" = "grep" ] && { echo "dlopen: libc.musl-x86_64.so.1: not found" >&2; exit 127; }
echo "veyyon/9.9.9"
STUB
chmod +x "$nat_dir/noaddon"

# A build that ran a search, exited 0, and found nothing.
cat > "$nat_dir/empty" <<'STUB'
#!/bin/sh
[ "$1" = "grep" ] && [ "$2" = "--help" ] && exit 0
[ "$1" = "grep" ] && { echo "Total matches: 0"; exit 0; }
echo "veyyon/9.9.9"
STUB
chmod +x "$nat_dir/empty"

( doctor_natives "$nat_dir/good" >/dev/null 2>&1 ); check "doctor_natives accepts a binary whose search works" "$?" "0"
( doctor_natives "$nat_dir/noaddon" >/dev/null 2>&1 ); check "doctor_natives fails closed when the addon did not load" "$?" "1"
( doctor_natives "$nat_dir/empty" >/dev/null 2>&1 ); check "doctor_natives fails closed on a search that finds nothing" "$?" "1"

# The phase word is what tells the user WHEN it broke: a rejected download left
# their system untouched, a rejected install did not.
check "doctor_natives says 'downloaded' when probing the staged file" \
    "$(doctor_natives "$nat_dir/noaddon" "downloaded" 2>&1 | grep -c 'the downloaded veyyon starts but cannot run a search')" "1"
check "doctor_natives defaults to 'installed' for the post-install run" \
    "$(doctor_natives "$nat_dir/noaddon" 2>&1 | grep -c 'the installed veyyon starts but cannot run a search')" "1"
check "doctor_natives labels the success line with its phase" \
    "$(doctor_natives "$nat_dir/good" "downloaded" 2>&1 | grep -c 'native addon loads (downloaded)')" "1"

# An older release with no grep subcommand is not a broken install.
cat > "$nat_dir/nogrep" <<'STUB'
#!/bin/sh
[ "$1" = "grep" ] && exit 1
echo "veyyon/0.0.1"
STUB
chmod +x "$nat_dir/nogrep"
( doctor_natives "$nat_dir/nogrep" >/dev/null 2>&1 ); check "doctor_natives skips a build with no grep command" "$?" "0"

# The probe must not leave its scratch directory behind on either path.
before_probe_dirs=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'veyyon-doctor.*' 2>/dev/null | wc -l)
( doctor_natives "$nat_dir/good" >/dev/null 2>&1 )
( doctor_natives "$nat_dir/noaddon" >/dev/null 2>&1 )
after_probe_dirs=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'veyyon-doctor.*' 2>/dev/null | wc -l)
check "doctor_natives removes its probe directory on success and failure" "$after_probe_dirs" "$before_probe_dirs"

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
    "$(grep -Fc "fish_add_path '/opt/fish-bin'" "$h/.config/fish/config.fish" 2>/dev/null)" "1"
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

# --- ensure_on_path: "already configured" means OUR line, not a substring ---
# The check was `grep -Fq "$dir" "$rc"`, so an rc that merely MENTIONED the path
# counted as configured. A user with `$HOME/.local/bin2` on PATH, or a comment
# naming the directory, got the add skipped and the directory reported as
# already set up — so a new shell never had it and "restart your shell" was
# advice that could not possibly work. Same prefix-substring bug that
# Test-PathContainsDir already fixed on the Windows side.
h="$(eop_home substring)"
mkdir -p "$h"
printf 'export PATH="/opt/sub-bin2:$PATH"\n' > "$h/.bashrc"
out=$( uname() { printf 'Linux\n'; }; HOME="$h"; SHELL=/bin/bash; ensure_on_path "/opt/sub-bin" 2>&1 )
check "a longer entry sharing the prefix does not count as configured" "$(printf '%s' "$out" | grep -c 'is already on PATH in')" "0"
check "the PATH line is actually written" "$(grep -Fc 'export PATH='"'"'/opt/sub-bin'"'"':"$PATH"' "$h/.bashrc")" "1"
check "the user's own prefix-sharing entry is untouched" "$(grep -c 'sub-bin2' "$h/.bashrc")" "1"

# A comment naming the directory is not configuration either.
h="$(eop_home comment)"
mkdir -p "$h"
printf '# remember to add /opt/comment-bin one day\n' > "$h/.bashrc"
out=$( uname() { printf 'Linux\n'; }; HOME="$h"; SHELL=/bin/bash; ensure_on_path "/opt/comment-bin" 2>&1 )
check "a comment mentioning the dir does not count as configured" "$(printf '%s' "$out" | grep -c 'is already on PATH in')" "0"
check "the PATH line is written past the comment" "$(grep -Fc 'export PATH='"'"'/opt/comment-bin'"'"':"$PATH"' "$h/.bashrc")" "1"

# And the fish form, whose line is a different shape entirely, matches exactly too.
h="$(eop_home fishexact)"
mkdir -p "$h/.config/fish"
printf 'fish_add_path /opt/fish-bin2\n' > "$h/.config/fish/config.fish"
out=$( uname() { printf 'Linux\n'; }; HOME="$h"; SHELL=/usr/bin/fish; ensure_on_path "/opt/fish-bin" 2>&1 )
check "fish: a prefix-sharing fish_add_path does not count as configured" "$(printf '%s' "$out" | grep -c 'is already on PATH in')" "0"
check "fish: the exact fish_add_path line is written" "$(grep -Fxc "fish_add_path '/opt/fish-bin'" "$h/.config/fish/config.fish")" "1"
out=$( uname() { printf 'Linux\n'; }; HOME="$h"; SHELL=/usr/bin/fish; ensure_on_path "/opt/fish-bin" 2>&1 )
check "fish: a reinstall recognizes its own line" "$(printf '%s' "$out" | grep -c 'is already on PATH in')" "1"

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
  # The real binary binds the launch alias in the script itself, and drops that
  # binding when asked with --no-alias; the stand-in mirrors both forms so the
  # tests below can tell which one the installer requested.
  printf '#!/bin/sh\nalias_part=" vey"\nfish_alias="\\ncomplete -c vey -w veyyon"\n[ "$3" = "--no-alias" ] && { alias_part=""; fish_alias=""; }\ncase "$1 $2" in\n  "completions --help") exit 0 ;;\n  "completions bash") echo "complete -F _veyyon veyyon$alias_part"; exit 0 ;;\n  "completions zsh") echo "#compdef veyyon$alias_part"; exit 0 ;;\n  "completions fish") printf "complete -c veyyon -w veyyon%%b\\n" "$fish_alias"; exit 0 ;;\nesac\nexit 1\n' > "$fakebin"
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
  check "fish completion installed for veyyon" "$(cat "$fishdir/veyyon.fish" 2>/dev/null)" "complete -c veyyon -w veyyon
complete -c vey -w veyyon"
  check "fish completion installed for the vey alias" "$(cat "$fishdir/vey.fish" 2>/dev/null)" "complete -c veyyon -w veyyon
complete -c vey -w veyyon"
  check "no temp completion files were left behind" "$(ls -A "$bashdir" | grep -c '^\.')" "0"

  # The positive twin of the no-alias rule: an alias this installer owns MUST be
  # bound by the generated scripts, or the name the docs tell users to type has
  # no completion at all.
  check "an owned alias is bound by the bash script" "$(grep -c 'veyyon vey$' "$bashdir/veyyon")" "1"
  check "an owned alias is bound by the zsh script" "$(grep -c 'veyyon vey$' "$zshdir/_veyyon")" "1"
  check "an owned alias is bound by the fish script" "$(grep -c 'complete -c vey ' "$fishdir/veyyon.fish")" "1"

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
  ( VEYYON_INSTALL_DIR="$SANDBOX/nowhere" do_uninstall >/dev/null 2>&1 )
  check "uninstall removed the bash completion" "$( [ -e "$bashdir/veyyon" ] && echo present || echo absent )" "absent"
  check "uninstall removed the bash alias completion" "$( [ -e "$bashdir/vey" ] && echo present || echo absent )" "absent"
  check "uninstall removed the zsh completion" "$( [ -e "$zshdir/_veyyon" ] && echo present || echo absent )" "absent"
  check "uninstall removed the fish completion" "$( [ -e "$fishdir/veyyon.fish" ] && echo present || echo absent )" "absent"
  check "uninstall removed the fish alias completion" "$( [ -e "$fishdir/vey.fish" ] && echo present || echo absent )" "absent" )

# --- completions_dir_is_loaded: a written file the shell never reads is not a completion ---
# The installer printed "installed zsh completions" for a file dropped into
# $XDG_DATA_HOME/zsh/site-functions, which is NOT on the default $fpath on most
# systems. Same for bash's user directory without the bash-completion loader.
# Both cases looked like success and gave the user nothing when they pressed Tab.
# 0 = the shell loads it, 1 = it does not, 2 = that shell is not installed here.

# fish needs no check: ~/.config/fish/completions is on its complete path by
# construction, so claiming otherwise would produce a warning nobody can act on.
( completions_dir_is_loaded fish "/anywhere" ); check "fish completions dir is always loaded" "$?" "0"

# zsh, shadowed so the test never depends on the host having zsh or on which
# fpath that host's zsh was compiled with.
( _z="$SANDBOX/zsh-loaded"; mkdir -p "$_z"
  has() { [ "$1" = zsh ]; }
  zsh() { printf '/usr/share/zsh/functions\n%s\n' "$_z"; }
  completions_dir_is_loaded zsh "$_z" )
check "zsh dir already on \$fpath reports loaded" "$?" "0"

( _z="$SANDBOX/zsh-unloaded"; mkdir -p "$_z"
  has() { [ "$1" = zsh ]; }
  zsh() { printf '/usr/share/zsh/functions\n'; }
  export HOME="$SANDBOX/zsh-home-empty"; mkdir -p "$HOME"
  completions_dir_is_loaded zsh "$_z" )
check "zsh dir absent from \$fpath and every rc reports NOT loaded" "$?" "1"

# fpath edits conventionally live in .zshrc, which a non-interactive `zsh -c`
# never reads. Missing that would warn at every install on a correctly
# configured machine, which trains the user to ignore the warning.
( _z="$SANDBOX/zsh-rc"; mkdir -p "$_z"
  has() { [ "$1" = zsh ]; }
  zsh() { printf '/usr/share/zsh/functions\n'; }
  export HOME="$SANDBOX/zsh-home-rc"; mkdir -p "$HOME"
  printf 'fpath=(%s $fpath)\nautoload -Uz compinit\n' "$_z" > "$HOME/.zshrc"
  completions_dir_is_loaded zsh "$_z" )
check "a .zshrc fpath line counts as loaded" "$?" "0"

( _z="$SANDBOX/zsh-env"; mkdir -p "$_z"
  has() { [ "$1" = zsh ]; }
  zsh() { printf '/usr/share/zsh/functions\n'; }
  export HOME="$SANDBOX/zsh-home-env"; mkdir -p "$HOME"
  printf 'fpath=(%s $fpath)\n' "$_z" > "$HOME/.zshenv"
  completions_dir_is_loaded zsh "$_z" )
check "a .zshenv fpath line counts as loaded" "$?" "0"

# A prefix-sharing directory in an rc must not be mistaken for ours, or the
# check silently passes for a directory the shell never loads.
( _z="$SANDBOX/zsh-prefix"; mkdir -p "$_z"
  has() { [ "$1" = zsh ]; }
  zsh() { printf '/usr/share/zsh/functions\n'; }
  export HOME="$SANDBOX/zsh-home-prefix"; mkdir -p "$HOME"
  printf 'fpath=(%s-other $fpath)\n' "$_z" > "$HOME/.zshrc"
  completions_dir_is_loaded zsh "$_z" )
check "an unrelated fpath entry does not count as ours" "$?" "1"

# The $fpath comparison is whole-line: a compiled-in entry that merely CONTAINS
# our path as a prefix is a different directory.
( _z="$SANDBOX/zsh-fpath-prefix"; mkdir -p "$_z"
  has() { [ "$1" = zsh ]; }
  zsh() { printf '%s-other\n' "$_z"; }
  export HOME="$SANDBOX/zsh-home-fp"; mkdir -p "$HOME"
  completions_dir_is_loaded zsh "$_z" )
check "a prefix-sharing \$fpath entry does not count as ours" "$?" "1"

# No zsh on the host means the answer is UNKNOWN, not "not loaded": warning
# about a shell the user does not have is noise.
( has() { return 1; }
  completions_dir_is_loaded zsh "/anywhere" )
check "no zsh installed reports unknown, not a failure" "$?" "2"

# bash: the user directory is dead without the bash-completion dynamic loader.
( _loader="$SANDBOX/bash-loader/bash_completion"; mkdir -p "$SANDBOX/bash-loader"; : > "$_loader"
  has() { [ "$1" = bash ]; }
  BASH_COMPLETION_LOADERS="$_loader"
  completions_dir_is_loaded bash "/anywhere" )
check "bash with the completion loader present reports loaded" "$?" "0"

( has() { [ "$1" = bash ]; }
  BASH_COMPLETION_LOADERS="$SANDBOX/definitely-absent-loader"
  unset BASH_COMPLETION_USER_DIR
  completions_dir_is_loaded bash "/anywhere" )
check "bash without any completion loader reports NOT loaded" "$?" "1"

( has() { [ "$1" = bash ]; }
  BASH_COMPLETION_LOADERS="$SANDBOX/definitely-absent-loader"
  export BASH_COMPLETION_USER_DIR="$SANDBOX/whatever"
  completions_dir_is_loaded bash "/anywhere" )
check "an explicit BASH_COMPLETION_USER_DIR counts as loaded" "$?" "0"

( has() { return 1; }
  completions_dir_is_loaded bash "/anywhere" )
check "no bash installed reports unknown, not a failure" "$?" "2"

# The hint has to name the actual directory and the actual file to edit, or the
# warning is a dead end.
check "the zsh hint names the dir and the rc file" "$( ( _hint=$(completions_enable_hint zsh "/some/site-functions"); case "$_hint" in *"/some/site-functions"*"~/.zshrc"*) echo yes ;; *) echo "$_hint" ;; esac ) )" "yes"
check "the bash hint names the package to install" "$( completions_enable_hint bash "/x" | grep -c 'bash-completion package' )" "1"

# End to end: the warning reaches the user's screen, and does not appear when
# the directory is loaded.
check "an unloaded zsh dir produces a visible warning" "$( ( _h="$SANDBOX/comp-warn2"
  export HOME="$_h"; export XDG_DATA_HOME="$_h/share"; export XDG_CONFIG_HOME="$_h/config"
  mkdir -p "$_h/bin"
  fakebin="$_h/bin/veyyon"
  printf '#!/bin/sh\ncase "$1" in\n  completions) [ "$2" = "--help" ] && exit 0; echo "# completions for $2"; exit 0 ;;\nesac\nexit 1\n' > "$fakebin"
  chmod +x "$fakebin"
  has() { case "$1" in zsh|bash) return 0 ;; *) command -v "$1" >/dev/null 2>&1 ;; esac; }
  zsh() { printf '/usr/share/zsh/functions\n'; }
  BASH_COMPLETION_LOADERS="$SANDBOX/definitely-absent-loader"
  unset BASH_COMPLETION_USER_DIR
  out=$(install_completions "$fakebin" 2>&1)
  case "$out" in *"zsh does not load"*) echo warned ;; *) echo missing ;; esac ) )" "warned"

check "a loaded zsh dir produces no such warning" "$( ( _h="$SANDBOX/comp-quiet"
  export HOME="$_h"; export XDG_DATA_HOME="$_h/share"; export XDG_CONFIG_HOME="$_h/config"
  mkdir -p "$_h/bin"
  fakebin="$_h/bin/veyyon"
  printf '#!/bin/sh\ncase "$1" in\n  completions) [ "$2" = "--help" ] && exit 0; echo "# completions for $2"; exit 0 ;;\nesac\nexit 1\n' > "$fakebin"
  chmod +x "$fakebin"
  has() { case "$1" in zsh|bash) return 0 ;; *) command -v "$1" >/dev/null 2>&1 ;; esac; }
  zsh() { printf '%s\n' "$(completions_dir_for zsh)"; }
  BASH_COMPLETION_LOADERS="$SANDBOX/definitely-absent-loader"
  export BASH_COMPLETION_USER_DIR="$_h/share/bash-completion"
  out=$(install_completions "$fakebin" 2>&1)
  case "$out" in *"does not load"*) echo warned ;; *) echo quiet ;; esac ) )" "quiet"

# The check is advisory: an unloaded directory must not fail the install, since
# the binary itself is fine and the user can fix their rc afterwards.
( _h="$SANDBOX/comp-nonfatal"
  export HOME="$_h"; export XDG_DATA_HOME="$_h/share"; export XDG_CONFIG_HOME="$_h/config"
  mkdir -p "$_h/bin"
  fakebin="$_h/bin/veyyon"
  printf '#!/bin/sh\ncase "$1" in\n  completions) [ "$2" = "--help" ] && exit 0; echo "# c"; exit 0 ;;\nesac\nexit 1\n' > "$fakebin"
  chmod +x "$fakebin"
  has() { case "$1" in zsh|bash) return 0 ;; *) command -v "$1" >/dev/null 2>&1 ;; esac; }
  zsh() { printf '/usr/share/zsh/functions\n'; }
  BASH_COMPLETION_LOADERS="$SANDBOX/definitely-absent-loader"
  unset BASH_COMPLETION_USER_DIR
  install_completions "$fakebin" >/dev/null 2>&1 )
check "an unloaded completions dir never fails the install" "$?" "0"

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
  # The real binary binds the launch alias in the script itself, and drops that
  # binding when asked with --no-alias; the stand-in mirrors both forms so the
  # tests below can tell which one the installer requested.
  printf '#!/bin/sh\nalias_part=" vey"\nfish_alias="\\ncomplete -c vey -w veyyon"\n[ "$3" = "--no-alias" ] && { alias_part=""; fish_alias=""; }\ncase "$1 $2" in\n  "completions --help") exit 0 ;;\n  "completions bash") echo "complete -F _veyyon veyyon$alias_part"; exit 0 ;;\n  "completions zsh") echo "#compdef veyyon$alias_part"; exit 0 ;;\n  "completions fish") printf "complete -c veyyon -w veyyon%%b\\n" "$fish_alias"; exit 0 ;;\nesac\nexit 1\n' > "$fakebin"
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

  check "our own bash completion is still installed" "$(cat "$bashdir/veyyon" 2>/dev/null)" "complete -F _veyyon veyyon"
  check "a foreign vey keeps its bash completion" "$(cat "$bashdir/vey" 2>/dev/null)" "complete -F _their_tool vey"
  check "a foreign vey keeps its fish completion" "$(cat "$fishdir/vey.fish" 2>/dev/null)" "complete -c vey -a their-subcommand"

  # Skipping only the alias FILE was never enough. The script written under OUR
  # OWN name binds the alias too (`complete -F _veyyon veyyon vey`, `#compdef
  # veyyon vey`), so bash and zsh applied our completions to the user's `vey`
  # regardless of which files we did or did not copy. The installer now asks the
  # binary not to bind it at all.
  check "our bash script does not bind a foreign vey" \
      "$(grep -c ' vey$' "$bashdir/veyyon" 2>/dev/null)" "0"
  check "our zsh script does not bind a foreign vey" \
      "$(grep -c ' vey$' "$(completions_dir_for zsh)/_veyyon" 2>/dev/null)" "0"
  check "our fish script does not bind a foreign vey" \
      "$(grep -c 'complete -c vey ' "$fishdir/veyyon.fish" 2>/dev/null)" "0"

  # And uninstall must not reclaim what install declined to write, either.
  ( VEYYON_INSTALL_DIR="$SANDBOX/nowhere" do_uninstall >/dev/null 2>&1 )
  check "uninstall leaves a foreign vey bash completion" "$(cat "$bashdir/vey" 2>/dev/null)" "complete -F _their_tool vey"
  check "uninstall leaves a foreign vey fish completion" "$(cat "$fishdir/vey.fish" 2>/dev/null)" "complete -c vey -a their-subcommand" )
unset XDG_DATA_HOME XDG_CONFIG_HOME
export HOME="$SANDBOX/home"

# --- remove_path_line_from_rc: a failed rewrite must not destroy the rc ---
# `cat "$tmp" > "$rc"` TRUNCATES the rc before cat runs, so a cat that fails
# partway (full disk, I/O error) leaves the rc empty and the temp file holding
# the only copy of the user's content. The failure branch then deleted that temp,
# destroying a file the uninstall had just emptied. It is kept now, and named.
# Shadow cat inside each subshell so the rewrite fails exactly where the real
# hazard is: after the redirection has already emptied the rc.
check "a failed rewrite keeps the only copy of the rc" \
    "$( ( _h="$SANDBOX/rc-rewrite-fail"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n%s\n%s\n' "alias ll=ls" "# added by the veyyon installer" 'export PATH="/opt/veyyon:$PATH"' > "$rc"
  cat() { return 1; }
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1
  ls "$_h"/.bashrc.veyyon-uninstall.* >/dev/null 2>&1 && echo kept || echo lost ) )" "kept"

# And the kept copy really holds what the rc had, not an empty file.
check "the kept copy holds the user's own rc content" \
    "$( ( _h="$SANDBOX/rc-rewrite-content"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n%s\n%s\n' "alias ll=ls" "# added by the veyyon installer" 'export PATH="/opt/veyyon:$PATH"' > "$rc"
  cat() { return 1; }
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1
  command cat "$_h"/.bashrc.veyyon-uninstall.* ) )" "alias ll=ls"

check "the warning tells the user how to restore it" \
    "$( ( _h="$SANDBOX/rc-rewrite-fail2"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n' 'export PATH="/opt/veyyon:$PATH"' > "$rc"
  cat() { return 1; }
  remove_path_line_from_rc "$rc" "/opt/veyyon" 2>&1 | grep -c "restore it with: cp" ) )" "1"

check "the warning names the file that holds the contents" \
    "$( ( _h="$SANDBOX/rc-rewrite-fail3"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n' 'export PATH="/opt/veyyon:$PATH"' > "$rc"
  cat() { return 1; }
  remove_path_line_from_rc "$rc" "/opt/veyyon" 2>&1 | grep -c "veyyon-uninstall" ) )" "2"

check "a failed rewrite still reports failure to the caller" \
    "$( ( _h="$SANDBOX/rc-rewrite-fail4"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n' 'export PATH="/opt/veyyon:$PATH"' > "$rc"
  cat() { return 1; }
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1; echo $? ) )" "1"

# The success path must still clean up after itself: a kept temp there would
# litter the user's home on every uninstall.
check "a successful rewrite leaves no temp file behind" \
    "$( ( _h="$SANDBOX/rc-rewrite-ok"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n%s\n' "# added by the veyyon installer" 'export PATH="/opt/veyyon:$PATH"' > "$rc"
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1
  ls -A "$_h" | tr '\n' ' ' ) )" ".bashrc "

# --- remove_path_line_from_rc: a short temp must never replace the rc ---
# Only the final `cat` was checked, so a write that failed while BUILDING the
# temp (a full disk part-way through a long rc) produced a truncated file that
# was then copied over the user's rc and reported as a clean uninstall. Shadow
# printf so the append fails after the first few lines, which is exactly the
# shape of a disk filling up mid-write.
check "a truncated rewrite does not replace the rc" \
    "$( ( _h="$SANDBOX/rc-short-temp"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n' "one" "two" "three" "# added by the veyyon installer" 'export PATH="/opt/veyyon:$PATH"' "five" > "$rc"
  _n=0
  printf() { _n=$((_n + 1)); [ "$_n" -gt 2 ] && return 1; command printf "$@"; }
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1
  command cat "$rc" | tr '\n' ' ' ) )" "one two three # added by the veyyon installer export PATH=\"/opt/veyyon:\$PATH\" five "

check "a truncated rewrite reports failure to the caller" \
    "$( ( _h="$SANDBOX/rc-short-temp2"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n' "one" "two" "three" "# added by the veyyon installer" 'export PATH="/opt/veyyon:$PATH"' "five" > "$rc"
  _n=0
  printf() { _n=$((_n + 1)); [ "$_n" -gt 2 ] && return 1; command printf "$@"; }
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1; echo $? ) )" "1"

# `warn` is itself a printf, so the shadow above would silence the very message
# under test. Drive the guard through the line count instead: its contract is
# about the length it sees, whatever produced it. The second awk call is the one
# that measures the temp.
check "a truncated rewrite says the file is untouched and names the partial" \
    "$( ( _h="$SANDBOX/rc-short-temp3"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n' "one" "two" "three" "# added by the veyyon installer" 'export PATH="/opt/veyyon:$PATH"' "five" > "$rc"
  count_lines() { case "$1" in *veyyon-uninstall*) echo 1 ;; *) command awk 'END { print NR }' "$1" ;; esac; }
  remove_path_line_from_rc "$rc" "/opt/veyyon" 2>&1 | grep -c "your file is untouched" ) )" "1"

check "the refusal names the expected length and the partial file" \
    "$( ( _h="$SANDBOX/rc-short-temp4"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n' "one" "two" "three" "# added by the veyyon installer" 'export PATH="/opt/veyyon:$PATH"' "five" > "$rc"
  count_lines() { case "$1" in *veyyon-uninstall*) echo 1 ;; *) command awk 'END { print NR }' "$1" ;; esac; }
  remove_path_line_from_rc "$rc" "/opt/veyyon" 2>&1 | grep -c "has 1 lines, expected 5" ) )" "1"

check "a refused rewrite leaves the rc byte-for-byte intact" \
    "$( ( _h="$SANDBOX/rc-short-temp5"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n' "one" "two" "three" "# added by the veyyon installer" 'export PATH="/opt/veyyon:$PATH"' "five" > "$rc"
  _snapshot=$(command cat "$rc")
  count_lines() { case "$1" in *veyyon-uninstall*) echo 1 ;; *) command awk 'END { print NR }' "$1" ;; esac; }
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1
  [ "$_snapshot" = "$(command cat "$rc")" ] && echo intact || echo changed ) )" "intact"

# The guard must not reject the two shapes a real removal produces: our line
# alone (one line fewer) and our line under its marker (two fewer).
check "removing the line alone passes the length guard" \
    "$( ( _h="$SANDBOX/rc-len-one"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n' "alias ll=ls" 'export PATH="/opt/veyyon:$PATH"' "alias gs=git" > "$rc"
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1
  command cat "$rc" | tr '\n' ' ' ) )" "alias ll=ls alias gs=git "

check "removing the line and its marker passes the length guard" \
    "$( ( _h="$SANDBOX/rc-len-two"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n' "alias ll=ls" "# added by the veyyon installer" 'export PATH="/opt/veyyon:$PATH"' > "$rc"
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1
  command cat "$rc" | tr '\n' ' ' ) )" "alias ll=ls "

check "an rc whose only content is our line still empties cleanly" \
    "$( ( _h="$SANDBOX/rc-len-only"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n' 'export PATH="/opt/veyyon:$PATH"' > "$rc"
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1; echo $?
  command cat "$rc" | wc -c | tr -d ' ' ) )" "0
0"

# POSIX sh has no `local`, so every variable a function sets belongs to its
# caller too. `_before` was one of them, and it silently overwrote a caller
# holding a variable under that name — the kind of collision that shows up as a
# wrong value somewhere else entirely, long after the call. Every name this
# function introduces must therefore be either an argument name it documents or
# prefixed distinctively enough that no caller would pick it by accident.
check "remove_path_line_from_rc introduces no ordinary global names" \
    "$( ( _h="$SANDBOX/rc-globals"; mkdir -p "$_h"
  export HOME="$_h"
  _target="$_h/.bashrc"
  printf '%s\n' "alias ll=ls" "# added by the veyyon installer" 'export PATH="/opt/veyyon:$PATH"' > "$_target"
  _seen_before=$(set | sed -n 's/^\([A-Za-z_][A-Za-z_0-9]*\)=.*/\1/p' | sort)
  remove_path_line_from_rc "$_target" "/opt/veyyon" >/dev/null 2>&1
  set | sed -n 's/^\([A-Za-z_][A-Za-z_0-9]*\)=.*/\1/p' | sort > "$_h/after"
  printf '%s\n' "$_seen_before" > "$_h/before"
  comm -13 "$_h/before" "$_h/after" |
    grep -vx -e rc -e dir -e line -e tmp -e _pending -e _have_pending -e _cur -e _cand \
             -e _rc_lines_before -e _rc_lines_after -e _seen_before -e _target |
    tr '\n' ' ' ) )" ""

# --- the PATH line quotes the directory, and uninstall still knows the old form ---
# An install directory whose name contains `$` was written into a DOUBLE-quoted
# string, so `export PATH="/home/a$PATH/bin:$PATH"` expanded `$PATH` inside the
# directory NAME on the next login and put a nonsense entry on PATH. The user saw
# `veyyon: command not found` in a shell whose rc plainly named the right
# directory. A backtick, a backslash, a space or a glob character is the same
# class of bug. The directory is single-quoted now, and these pin the exact bytes
# for each hostile name: a shell that sources the line must end up with the
# directory it was given, character for character.
for _q_dir in '/opt/plain/bin' '/opt/a$PATH/bin' "/opt/it's me/bin" '/opt/a b/bin' '/opt/back`tick/bin' '/opt/a*glob/bin'; do
  check "the PATH line for [$_q_dir] survives being sourced" \
      "$( ( eval "$(path_line_for "$HOME/.bashrc" "$_q_dir")"; printf '%s' "${PATH%%:*}" ) )" "$_q_dir"
  # fish takes the path as an argument rather than building a string, but an
  # unquoted argument still splits on spaces and globs, so it needs the same
  # treatment. There is no fish here to run it, so assert the emitted bytes.
  check "the fish PATH line for [$_q_dir] quotes the directory" \
      "$(path_line_for "$HOME/.config/fish/config.fish" "$_q_dir")" \
      "fish_add_path $(shell_single_quote "$_q_dir")"
done
unset _q_dir

# Changing what install WRITES silently changed what uninstall could RECOGNIZE:
# `remove_path_line_from_rc` rebuilds the line through the same single owner, so
# an rc written by an installer from before the quoting fix stopped matching and
# would have kept its PATH line forever, pointing at a directory that no longer
# holds veyyon. That is the exact complaint the uninstall exists to prevent, so
# the old spelling is matched too.
check "uninstall removes a legacy double-quoted PATH line" \
    "$( ( _h="$SANDBOX/rc-legacy-form"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n%s\n%s\n%s\n' "alias ll=ls" "# added by the veyyon installer" 'export PATH="/opt/veyyon:$PATH"' "alias gs='git status'" > "$rc"
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1
  command cat "$rc" | tr '\n' '|' ) )" "alias ll=ls|alias gs='git status'|"

check "uninstall removes a legacy fish PATH line" \
    "$( ( _h="$SANDBOX/rc-legacy-fish"; mkdir -p "$_h/.config/fish"
  export HOME="$_h"
  rc="$_h/.config/fish/config.fish"
  printf '%s\n%s\n%s\n' "# added by the veyyon installer" "fish_add_path /opt/veyyon" "set -x EDITOR vim" > "$rc"
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1
  command cat "$rc" | tr '\n' '|' ) )" "set -x EDITOR vim|"

check "uninstall removes the current single-quoted PATH line" \
    "$( ( _h="$SANDBOX/rc-current-form"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  { printf 'alias ll=ls\n# added by the veyyon installer\n'
    path_line_for "$rc" '/opt/a$PATH/bin'; printf '\n' ; } > "$rc"
  remove_path_line_from_rc "$rc" '/opt/a$PATH/bin' >/dev/null 2>&1
  command cat "$rc" | tr '\n' '|' ) )" "alias ll=ls|"

# The legacy matcher widens what uninstall will delete, so it has to stay just as
# narrow about lines it did not write. A PATH line for a DIFFERENT directory is
# the user's own, in either spelling.
check "uninstall leaves a PATH line for another directory alone" \
    "$( ( _h="$SANDBOX/rc-foreign-line"; mkdir -p "$_h"
  export HOME="$_h"
  rc="$_h/.bashrc"
  printf '%s\n' 'export PATH="/opt/somethingelse:$PATH"' > "$rc"
  remove_path_line_from_rc "$rc" "/opt/veyyon" >/dev/null 2>&1; echo $?
  command cat "$rc" ) )" "1
export PATH=\"/opt/somethingelse:\$PATH\""

# One owner writes, one owner enumerates what may be removed, and the first entry
# the enumerator produces is what the writer produces. If they ever drift, an
# install writes a line its own uninstall does not list.
check "the first removal candidate is exactly what install writes" \
    "$( ( _w=$(path_line_for "$HOME/.bashrc" "/opt/veyyon")
  _c=$(path_line_candidates_for "$HOME/.bashrc" "/opt/veyyon" | sed -n 1p)
  [ "$_w" = "$_c" ] && echo same || printf 'write=[%s] first-candidate=[%s]\n' "$_w" "$_c" ) )" "same"

# --- do_uninstall: the closing verdict must match what it actually removed ---
# `rc_candidates | while ...` ran the PATH-line loop in a SUBSHELL, so the
# `removed` flag set inside it was discarded: an uninstall whose only remaining
# artifact was the PATH line printed "removed the veyyon PATH line from ..." and
# then "nothing to uninstall." on the very next line. The completion removals had
# the same defect for a different reason: they never set the flag at all.
check "removing only the PATH line still counts as an uninstall" \
    "$( ( _h="$SANDBOX/uninst-verdict-path"
  export HOME="$_h"; export VEYYON_INSTALL_DIR="$_h/bin"
  unset XDG_DATA_HOME XDG_CONFIG_HOME
  mkdir -p "$(install_dir)"
  printf '%s\n%s\n' "# added by the veyyon installer" "export PATH=\"$(install_dir):\$PATH\"" > "$_h/.bashrc"
  do_uninstall 2>&1 | tail -1 ) )" "veyyon uninstalled."

check "removing only completions still counts as an uninstall" \
    "$( ( _h="$SANDBOX/uninst-verdict-comp"
  export HOME="$_h"; export XDG_DATA_HOME="$_h/share"; export XDG_CONFIG_HOME="$_h/config"
  export VEYYON_INSTALL_DIR="$_h/bin"
  mkdir -p "$(install_dir)" "$(completions_dir_for bash)"
  printf 'complete -F _veyyon veyyon\n' > "$(completions_dir_for bash)/veyyon"
  do_uninstall 2>&1 | tail -1 ) )" "veyyon uninstalled."

# The negative twin: a home with nothing of ours in it must still say so, or the
# verdict means nothing.
check "an empty home still reports nothing to uninstall" \
    "$( ( _h="$SANDBOX/uninst-verdict-empty"
  export HOME="$_h"; export XDG_DATA_HOME="$_h/share"; export XDG_CONFIG_HOME="$_h/config"
  export VEYYON_INSTALL_DIR="$_h/bin"
  mkdir -p "$(install_dir)"
  do_uninstall 2>&1 | tail -1 ) )" "nothing to uninstall."

# A rc the user owns but that never held our line must not flip the verdict.
check "an unrelated rc does not count as something removed" \
    "$( ( _h="$SANDBOX/uninst-verdict-foreign-rc"
  export HOME="$_h"; export XDG_DATA_HOME="$_h/share"; export XDG_CONFIG_HOME="$_h/config"
  export VEYYON_INSTALL_DIR="$_h/bin"
  mkdir -p "$(install_dir)"
  printf 'alias ll=ls\n' > "$_h/.bashrc"
  do_uninstall 2>&1 | tail -1 ) )" "nothing to uninstall."

# --- print_next_steps: never tell the user to run a command that is not ours ---
# The closing block was pasted into all three install modes and hardcoded the
# alias, so an install that had just said "left 'vey' alone, launch with
# 'veyyon'" immediately told the user to run `vey` — which runs THEIR tool.
check "the closing advice uses the alias when it is ours" \
    "$( ( ALIAS_IS_OURS=1; print_next_steps | grep -c 'Launch in any repository: vey$' ) )" "1"
check "the closing advice uses the binary name when the alias is not ours" \
    "$( ( ALIAS_IS_OURS=0; print_next_steps | grep -c 'Launch in any repository: veyyon$' ) )" "1"
check "no line tells the user to run a foreign vey" \
    "$( ( ALIAS_IS_OURS=0; print_next_steps | grep -c '\bvey\b' ) )" "0"
# Every line of the block moves together, so steps 2 and 3 cannot name a
# different command than the launch line.
check "the later steps follow the same command" \
    "$( ( ALIAS_IS_OURS=0; print_next_steps | grep -c '^  [23]\..* veyyon ' ) )" "2"
check "launch_command is the single owner of that choice" \
    "$( ( ALIAS_IS_OURS=1; launch_command ) )" "vey"

# Step 3 read "Run system diagnostics: <cmd> plugin doctor". There is no `doctor`
# command; `plugin doctor` reports on plugins alone and on a fresh install prints
# three slots all "not created yet". A user following the installer's own third
# step was told they were checking their system and shown a report about a
# subsystem they had never used. Found by dogfooding the real install in a clean
# container (BACKLOG INSTALL-DOGFOOD-2). These pin the label to the command.
check "step 3 no longer claims to run system diagnostics" \
    "$( ( ALIAS_IS_OURS=1; print_next_steps | grep -ci 'diagnostic' ) )" "0"
check "step 3 does not send a fresh install into the plugin subsystem" \
    "$( ( ALIAS_IS_OURS=1; print_next_steps | grep -c 'plugin doctor' ) )" "0"
check "step 3 names the command list, and names it exactly" \
    "$( ( ALIAS_IS_OURS=1; print_next_steps | grep -c '^  3\. See every command: *vey --help$' ) )" "1"
# Each step is a label, then a command. A step whose label promises something the
# command does not do is the bug above; asserting the shape of all three keeps a
# future edit from reintroducing it silently in a different step.
check "every step is exactly one label and one command" \
    "$( ( ALIAS_IS_OURS=1; print_next_steps | grep -c '^  [123]\. [A-Z][^:]*: *vey\b' ) )" "3"

# --- print_next_steps: a step the user cannot yet run must not come first ---
# The install directory goes onto PATH through a shell profile, and a profile is
# read when a shell STARTS. The shell running the installer already started, so
# `vey` is not a command in it, and the block opened with "1. Launch in any
# repository: vey" regardless — the first thing a new user types after a
# successful install answered `command not found`, which reads as a broken
# install rather than as a shell that has not caught up. The reload is a step
# now, ahead of the command that depends on it, and the rest renumber around it.
check "a reload is the first step when PATH was just changed" \
    "$( ( ALIAS_IS_OURS=1; PATH_NEEDS_RELOAD=1; PATH_RELOAD_RC="$HOME/.bashrc"
  print_next_steps | grep -c '^  1\. Reload your shell: *exec \$SHELL -l$' ) )" "1"
check "the launch step moves to 2 behind it" \
    "$( ( ALIAS_IS_OURS=1; PATH_NEEDS_RELOAD=1; PATH_RELOAD_RC="$HOME/.bashrc"
  print_next_steps | grep -c '^  2\. Launch in any repository: vey$' ) )" "1"
check "the whole list renumbers, so no number is used twice" \
    "$( ( ALIAS_IS_OURS=1; PATH_NEEDS_RELOAD=1; PATH_RELOAD_RC="$HOME/.bashrc"
  print_next_steps | sed -n 's/^  \([0-9]*\)\..*/\1/p' | tr '\n' ' ' ) )" "1 2 3 4 "
# Sourcing the profile is the way to get the new PATH without losing the shell,
# and it is only offered when there is a file to source.
# The profile path is long, and this line ran off a 40- and a 60-column terminal
# in the adversarial matrix: it was printed with a plain `say`, which is the only
# line in the closing block that does not go through the wrapper. Everything the
# installer prints wraps now, through one owner.
check "the source hint wraps to a narrow terminal" \
    "$( ( ALIAS_IS_OURS=1; PATH_NEEDS_RELOAD=1; IS_TTY=1; COLUMNS=40
  PATH_RELOAD_RC="/home/somebody/dotfiles/shell/.profile"
  print_next_steps | awk '{ t = $0; sub(/^ +/, "", t); if (length($0) > 40 && t ~ / /) print NR": "$0 }' ) )" ""
check "and the path itself is never broken across lines" \
    "$( ( ALIAS_IS_OURS=1; PATH_NEEDS_RELOAD=1; IS_TTY=1; COLUMNS=40
  PATH_RELOAD_RC="/home/somebody/dotfiles/shell/.profile"
  print_next_steps | grep -c '/home/somebody/dotfiles/shell/.profile$' ) )" "1"
check "the reload step names the profile to source" \
    "$( ( ALIAS_IS_OURS=1; PATH_NEEDS_RELOAD=1; PATH_RELOAD_RC="/home/u/.zshrc"
  print_next_steps | grep -c 'source /home/u/.zshrc' ) )" "1"
check "no file to source means no source line" \
    "$( ( ALIAS_IS_OURS=1; PATH_NEEDS_RELOAD=1; PATH_RELOAD_RC=""
  print_next_steps | grep -c 'source ' ) )" "0"
# And an install onto a directory that was ALREADY on PATH must not tell anyone
# to restart anything: the command works right now, and a spurious reload step is
# the same kind of wrong advice in the other direction.
check "an install onto a PATH already carrying the directory adds no reload step" \
    "$( ( ALIAS_IS_OURS=1; PATH_NEEDS_RELOAD=0
  print_next_steps | grep -c -e 'Reload' -e 'exec \$SHELL' ) )" "0"
check "and its list still starts at the launch step" \
    "$( ( ALIAS_IS_OURS=1; PATH_NEEDS_RELOAD=0
  print_next_steps | grep -c '^  1\. Launch in any repository: vey$' ) )" "1"

# `ensure_on_path` is the one place that knows the answer, and it returns EARLY
# when the directory is already on PATH — that early return is what keeps the
# flag off. Every other path through it means this shell cannot see the
# directory, including the reinstall branch where the rc already holds the line:
# the line being in the file is not the same as the file having been read.
check "ensure_on_path sets no reload flag when the directory is already on PATH" \
    "$( ( _h="$SANDBOX/reload-already"; mkdir -p "$_h"
  export HOME="$_h"; PATH="$_h/bin:$PATH"; PATH_NEEDS_RELOAD=0
  ensure_on_path "$_h/bin" >/dev/null 2>&1; echo "$PATH_NEEDS_RELOAD" ) )" "0"
check "ensure_on_path asks for a reload after writing the line" \
    "$( ( _h="$SANDBOX/reload-written"; mkdir -p "$_h"
  export HOME="$_h"; SHELL=/bin/bash; PATH_NEEDS_RELOAD=0
  uname() { printf 'Linux\n'; }
  ensure_on_path "$_h/bin" >/dev/null 2>&1
  echo "$PATH_NEEDS_RELOAD $(basename "$PATH_RELOAD_RC")" ) )" "1 .bashrc"
check "ensure_on_path asks for a reload on a reinstall too" \
    "$( ( _h="$SANDBOX/reload-reinstall"; mkdir -p "$_h"
  export HOME="$_h"; SHELL=/bin/bash; PATH_NEEDS_RELOAD=0
  uname() { printf 'Linux\n'; }
  ensure_on_path "$_h/bin" >/dev/null 2>&1
  PATH_NEEDS_RELOAD=0
  ensure_on_path "$_h/bin" >/dev/null 2>&1
  echo "$PATH_NEEDS_RELOAD" ) )" "1"

# --- do_uninstall: a `vey` the installer never created is not ours to delete ---
# link_alias refuses to overwrite a `vey` the user owns, and install_completions
# refuses to write its completion file. Uninstall deleted the command itself
# anyway, so removing veyyon destroyed the user's own tool. Same identity gate,
# applied where it was missing.
check "uninstall removes our binary but keeps a foreign vey" \
    "$( ( _h="$SANDBOX/uninst-foreign-alias2"
  export HOME="$_h"; export VEYYON_INSTALL_DIR="$_h/bin"
  mkdir -p "$(install_dir)"
  printf '#!/bin/sh\necho veyyon\n' > "$(install_dir)/veyyon"
  printf '#!/bin/sh\necho their tool\n' > "$(install_dir)/vey"
  do_uninstall >/dev/null 2>&1
  echo "$( [ -e "$(install_dir)/veyyon" ] && echo bin-present || echo bin-gone ) $(tail -1 "$(install_dir)/vey" 2>/dev/null)" ) )" \
    "bin-gone echo their tool"

# It says so rather than removing it silently: the user needs to know a `vey`
# still on their PATH is theirs, not a leftover of ours.
check "uninstall says it left a foreign vey alone" \
    "$( ( _h="$SANDBOX/uninst-foreign-alias3"
  export HOME="$_h"; export VEYYON_INSTALL_DIR="$_h/bin"
  mkdir -p "$(install_dir)"
  printf '#!/bin/sh\necho veyyon\n' > "$(install_dir)/veyyon"
  printf '#!/bin/sh\necho their tool\n' > "$(install_dir)/vey"
  do_uninstall 2>&1 | grep -c "left $(install_dir)/vey alone" ) )" "1"

# A symlink pointing somewhere ELSE is not ours either: link_alias only ever
# writes one pointing at the binary beside it.
check "uninstall keeps a vey symlinked to another tool" \
    "$( ( _h="$SANDBOX/uninst-foreign-link"
  export HOME="$_h"; export VEYYON_INSTALL_DIR="$_h/bin"
  mkdir -p "$(install_dir)"
  printf '#!/bin/sh\necho veyyon\n' > "$(install_dir)/veyyon"
  printf '#!/bin/sh\necho other\n' > "$_h/their-tool"
  ln -s "$_h/their-tool" "$(install_dir)/vey"
  do_uninstall >/dev/null 2>&1
  [ -L "$(install_dir)/vey" ] && echo kept || echo removed ) )" "kept"

# The positive twin: an alias we DID create is still reclaimed, or uninstall
# leaves a dangling `vey` on the user's PATH forever.
check "uninstall removes an alias it created" \
    "$( ( _h="$SANDBOX/uninst-own-alias"
  export HOME="$_h"; export VEYYON_INSTALL_DIR="$_h/bin"
  mkdir -p "$(install_dir)"
  printf '#!/bin/sh\necho veyyon\n' > "$(install_dir)/veyyon"
  ln -s "$(install_dir)/veyyon" "$(install_dir)/vey"
  do_uninstall >/dev/null 2>&1
  [ -e "$(install_dir)/vey" ] || [ -L "$(install_dir)/vey" ] && echo present || echo gone ) )" "gone"

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
  ( VEYYON_INSTALL_DIR="$SANDBOX/nowhere" do_uninstall >/dev/null 2>&1 )
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
  ( VEYYON_INSTALL_DIR="$SANDBOX/nowhere" do_uninstall >/dev/null 2>&1 )
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
  ( VEYYON_INSTALL_DIR="$_d" do_uninstall >/dev/null 2>&1 )
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

# A stub binary that behaves like a real one for the two things doctor asks of
# it: report a version, and run a search that finds the file it is pointed at.
# The old stubs echoed their version for ANY argv, so they answered `grep` by
# accident and could never have caught a doctor gate that depends on the search
# actually working.
write_stub_binary() {
    _sb_path="$1"; _sb_version="$2"
    printf '%s\n' '#!/bin/sh' \
        'case "$1" in' \
        '  grep)' \
        '    shift' \
        '    [ "$1" = "--help" ] && exit 0' \
        '    printf "%s/probe.txt:1: %s\\n" "$2" "$1"' \
        '    ;;' \
        "  *) echo veyyon/$_sb_version ;;" \
        'esac' > "$_sb_path"
    chmod +x "$_sb_path"
}

# --- a $HOME with a space in it ---
# Every path in this suite is space-free, so an unquoted expansion anywhere in
# the uninstall path would pass all of it and break for a real user whose home
# is "C:\\Users\\First Last" under WSL, or /Users/first last on a mac. The
# uninstall is the dangerous half: a word-split path removes the wrong thing, or
# reports success having removed nothing.
( _sp="$SANDBOX/spaced/my home dir"
  mkdir -p "$_sp/bin" "$_sp/.veyyon/natives/1.0.0" "$_sp/.veyyon/src/.git"
  export HOME="$_sp"
  export XDG_DATA_HOME="$_sp/.local/share"
  export XDG_CONFIG_HOME="$_sp/.config"
  export VEYYON_INSTALL_DIR="$_sp/bin"
  mkdir -p "$(completions_dir_for bash)" "$(completions_dir_for fish)"
  printf 'x' > "$_sp/bin/veyyon"
  ln -sf "$_sp/bin/veyyon" "$_sp/bin/vey"
  printf 'c' > "$(completions_dir_for bash)/veyyon"
  printf 'c' > "$(completions_dir_for fish)/veyyon.fish"
  printf '%s\n%s\n' "# added by the veyyon installer" "export PATH=\"$_sp/bin:\$PATH\"" > "$_sp/.bashrc"

  # The INSTALL half first, against the same spaced home: these are the units
  # that write, so a word-split here puts files somewhere the uninstall will
  # never look and reports success either way.
  rm -f "$_sp/bin/vey"
  link_alias "$_sp/bin" >/dev/null 2>&1
  check "link_alias creates the alias under a spaced HOME" \
      "$( [ -L "$_sp/bin/vey" ] && echo yes || echo no )" "yes"
  check "the alias points at the binary in the spaced directory" \
      "$(readlink "$_sp/bin/vey")" "$_sp/bin/veyyon"

  printf '%s\n' '#!/bin/sh' 'case "$1" in' '  completions) echo "# generated for $2" ;;' \
      '  *) echo veyyon/1.2.3 ;;' 'esac' > "$_sp/bin/gen"; chmod +x "$_sp/bin/gen"
  install_completions "$_sp/bin/gen" >/dev/null 2>&1
  check "completions land in the spaced HOME's bash directory" \
      "$(cat "$(completions_dir_for bash)/veyyon" 2>/dev/null)" "# generated for bash"
  check "completions land in the spaced HOME's fish directory" \
      "$(cat "$(completions_dir_for fish)/veyyon.fish" 2>/dev/null)" "# generated for fish"
  check "the alias completion is written under a spaced HOME too" \
      "$(cat "$(completions_dir_for fish)/vey.fish" 2>/dev/null)" "# generated for fish"

  printf '%s\n' "alias ll=ls" > "$_sp/.bashrc"
  ensure_on_path "$_sp/bin" >/dev/null 2>&1
  check "the PATH line names the spaced directory intact" \
      "$(grep -Fc "export PATH='$_sp/bin':\"\$PATH\"" "$_sp/.bashrc")" "1"
  check "ensure_on_path keeps the user's own rc content" \
      "$(grep -c 'alias ll=ls' "$_sp/.bashrc")" "1"
  # Running it twice must not append a second line for the same directory.
  ensure_on_path "$_sp/bin" >/dev/null 2>&1
  check "ensure_on_path is idempotent under a spaced HOME" \
      "$(grep -c "$_sp/bin" "$_sp/.bashrc")" "1"

  rm -f "$_sp/bin/gen"
  out=$( do_uninstall 2>&1 )
  check "a spaced HOME still reports a completed uninstall" \
      "$(printf '%s' "$out" | grep -c 'veyyon uninstalled.')" "1"
  check "the binary under a spaced HOME is removed" \
      "$( [ -e "$_sp/bin/veyyon" ] && echo left || echo removed )" "removed"
  check "the alias under a spaced HOME is removed" \
      "$( [ -e "$_sp/bin/vey" ] || [ -L "$_sp/bin/vey" ] && echo left || echo removed )" "removed"
  check "completions under a spaced HOME are removed" \
      "$( [ -e "$(completions_dir_for bash)/veyyon" ] && echo left || echo removed )" "removed"
  check "the native cache under a spaced HOME is removed" \
      "$( [ -e "$_sp/.veyyon/natives" ] && echo left || echo removed )" "removed"
  check "the source checkout under a spaced HOME is removed" \
      "$( [ -e "$_sp/.veyyon/src" ] && echo left || echo removed )" "removed"
  check "the PATH line is removed from a spaced HOME's rc" \
      "$(grep -c 'veyyon' "$_sp/.bashrc" 2>/dev/null)" "0"
  # And the rc is rewritten, not emptied: a word-split path could have produced
  # a plausible-looking success while destroying the file.
  check "the spaced HOME's rc survives the rewrite" \
      "$( [ -f "$_sp/.bashrc" ] && echo present || echo gone )" "present" )
unset XDG_DATA_HOME XDG_CONFIG_HOME
export HOME="$SANDBOX/home"
export VEYYON_INSTALL_DIR="$SANDBOX/bin"

# --- install_dir: one owner, resolved on use ---
# INSTALL_DIR was a top-level assignment reading $HOME at load, and it guards
# removals: an uninstall run under a sandbox HOME resolved the bin directory
# under the REAL one. It was also a second name for VEYYON_INSTALL_DIR, which is
# why the cases in this file used to set BOTH — nobody could tell which was read.
check "install_dir follows a HOME set after this script was sourced" \
    "$( ( unset VEYYON_INSTALL_DIR; HOME="$SANDBOX/bindir-home"; install_dir ) )" "$SANDBOX/bindir-home/.local/bin"

check "an exported VEYYON_INSTALL_DIR still wins over HOME" \
    "$( ( HOME="$SANDBOX/bindir-home"; VEYYON_INSTALL_DIR="$SANDBOX/elsewhere-bin"; install_dir ) )" "$SANDBOX/elsewhere-bin"

# The behavioural half: a VEYYON_INSTALL_DIR set at CALL time has to be the
# directory the uninstall acts on. Under the load-time binding it was ignored
# entirely — the removal went to whatever the value had been when install.sh was
# sourced, which is how a run aimed at a sandbox reached somewhere else.
check "an uninstall acts on the VEYYON_INSTALL_DIR set at call time" \
    "$( ( _sand="$SANDBOX/bindir-sandbox"
  mkdir -p "$_sand/bin"
  printf '#!/bin/sh\necho veyyon\n' > "$_sand/bin/veyyon"
  ( HOME="$_sand" VEYYON_INSTALL_DIR="$_sand/bin" do_uninstall >/dev/null 2>&1 )
  [ -e "$_sand/bin/veyyon" ] && echo left || echo removed ) )" "removed"

# --- src_dir: the checkout path must follow $HOME, not the $HOME at load ---
# `VEYYON_SRC_DIR="${VEYYON_SRC_DIR:-$HOME/.veyyon/src}"` was a TOP-LEVEL
# assignment, so it bound $HOME once when this file sourced install.sh. Every
# case below then sets its own $HOME and the value did not follow: a sandboxed
# `do_uninstall` resolved the checkout under the REAL home and moved a
# developer's own ~/.veyyon/src aside. It found the tree, printed "nothing was
# deleted", and was right about that and wrong about everything else. The same
# default was also written twice, agreeing only because the load-time copy ran
# first.
check "src_dir follows a HOME set after this script was sourced" \
    "$( ( HOME="$SANDBOX/srcdir-home"; src_dir ) )" "$SANDBOX/srcdir-home/.veyyon/src"

check "src_dir tracks a second HOME in the same process" \
    "$( ( HOME="$SANDBOX/srcdir-other"; src_dir ) )" "$SANDBOX/srcdir-other/.veyyon/src"

check "an exported VEYYON_SRC_DIR still wins over HOME" \
    "$( ( HOME="$SANDBOX/srcdir-home"; VEYYON_SRC_DIR="$SANDBOX/elsewhere"; src_dir ) )" "$SANDBOX/elsewhere"

# The behavioural proof. The old bug bound $HOME as it stood when install.sh was
# SOURCED, which in this file is $SANDBOX/home — so that is where a checkout has
# to be planted for the escape to be visible. An uninstall run under a different
# HOME must not touch it. (Planting under some third directory proves nothing:
# the buggy version never pointed there either.)
check "an uninstall under one HOME leaves the load-time HOME's checkout alone" \
    "$( ( _loadtime="$SANDBOX/home"; _sand="$SANDBOX/sandbox-home"
  mkdir -p "$_loadtime/.veyyon/src/.git" "$_sand/.veyyon/src/.git" "$_sand/bin"
  printf 'planted\n' > "$_loadtime/.veyyon/src/marker"
  HOME="$_sand" VEYYON_INSTALL_DIR="$_sand/bin" do_uninstall >/dev/null 2>&1
  [ -f "$_loadtime/.veyyon/src/marker" ] && echo untouched || echo clobbered ) )" "untouched"

check "and it does remove the checkout under the HOME it was given" \
    "$( ( _sand="$SANDBOX/sandbox-home2"
  mkdir -p "$_sand/.veyyon/src/.git" "$_sand/bin"
  HOME="$_sand" VEYYON_INSTALL_DIR="$_sand/bin" do_uninstall >/dev/null 2>&1
  [ -e "$_sand/.veyyon/src" ] && echo left || echo removed ) )" "removed"

# --- doctor_natives: prove the addon loads, not just that the binary starts ---
# `--version` is served entirely by the JS entry point, so it succeeds on an
# install whose native addon is missing, staged for the wrong architecture, or
# built against a libc this machine does not have. doctor printed
# "veyyon runs" for exactly that install and the user met the failure on their
# first real command. `grep` is the cheapest command that goes through the
# native walker and returns a result worth checking.
( _n="$SANDBOX/natives"
  mkdir -p "$_n"

  write_stub_binary "$_n/veyyon" 1.2.3
  out=$( doctor_natives "$_n/veyyon" 2>&1 )
  check "a working binary reports the addon loads" "$(printf '%s' "$out" | grep -c 'native addon loads')" "1"
  ( doctor_natives "$_n/veyyon" >/dev/null 2>&1 ); check "a working binary exits 0" "$?" "0"

  # The failure this exists to catch: the binary starts, and the search does not.
  printf '%s\n' '#!/bin/sh' 'case "$1" in' '  grep)' '    shift' \
      '    [ "$1" = "--help" ] && exit 0' \
      '    echo "dlopen failed: libc.musl-x86_64.so.1: No such file" >&2; exit 127 ;;' \
      '  *) echo veyyon/1.2.3 ;;' 'esac' > "$_n/broken"; chmod +x "$_n/broken"
  ( doctor_natives "$_n/broken" >/dev/null 2>&1 ); check "an addon that cannot load is fatal" "$?" "1"
  out=$( doctor_natives "$_n/broken" 2>&1 || true )
  check "the failure names the exit status of the search" "$(printf '%s' "$out" | grep -c 'exited 127')" "1"
  check "the failure names the likely cause" "$(printf '%s' "$out" | grep -c 'platform mismatch')" "1"
  check "the failure offers the source install as the remedy" "$(printf '%s' "$out" | grep -c 'sh -s -- --source')" "1"
  check "the failure quotes what the binary actually said" "$(printf '%s' "$out" | grep -c 'dlopen failed')" "1"

  # Worse than a crash: a search that exits 0 and finds nothing. Trusting the
  # exit code alone would report a healthy install for a walker returning empty.
  printf '%s\n' '#!/bin/sh' 'case "$1" in' '  grep)' '    shift' \
      '    [ "$1" = "--help" ] && exit 0' \
      '    echo "Total matches: 0" ;;' \
      '  *) echo veyyon/1.2.3 ;;' 'esac' > "$_n/empty"; chmod +x "$_n/empty"
  ( doctor_natives "$_n/empty" >/dev/null 2>&1 ); check "a search that finds nothing is fatal" "$?" "1"
  check "the empty-result failure says the install is not usable" \
      "$( ( doctor_natives "$_n/empty" 2>&1 || true ) | grep -c 'not usable' )" "1"

  # An older build with no `grep` subcommand is not a broken install.
  printf '#!/bin/sh\ncase "$1" in grep) exit 1 ;; *) echo veyyon/0.9.0 ;; esac\n' > "$_n/nogrep"
  chmod +x "$_n/nogrep"
  ( doctor_natives "$_n/nogrep" >/dev/null 2>&1 ); check "a build with no grep command is not fatal" "$?" "0"
  check "a build with no grep command says the test was skipped" \
      "$(doctor_natives "$_n/nogrep" 2>&1 | grep -c 'skipping the native addon self-test')" "1"

  # The probe must not litter: it writes a file into TMPDIR on every install.
  _tmp="$_n/tmpdir"; mkdir -p "$_tmp"
  ( TMPDIR="$_tmp" doctor_natives "$_n/veyyon" >/dev/null 2>&1 )
  check "the self-test removes its own temp directory" "$(ls -A "$_tmp" | wc -l | tr -d ' ')" "0"
  ( TMPDIR="$_tmp" doctor_natives "$_n/broken" >/dev/null 2>&1 || true )
  check "the self-test cleans up even when it fails" "$(ls -A "$_tmp" | wc -l | tr -d ' ')" "0" )

# --- doctor: the installed binary must report the version the release claims ---
# The checksum proves the bytes match the published asset; this proves the asset
# is the version the tag claims. A release that uploaded a mismatched binary, or
# a stale cached download, otherwise installs "successfully" and runs the wrong
# version forever. The self-updater enforces the same gate before keeping a
# swapped-in binary; install.sh did not, which is the parity gap this closes.
( _d="$SANDBOX/vercheck"
  mkdir -p "$_d"
  write_stub_binary "$_d/veyyon" 1.0.37

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
  write_stub_binary "$mine/veyyon" 9.9.9
  ln -sf "$mine/veyyon" "$mine/vey"
  write_stub_binary "$older/veyyon" 0.0.1
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
  write_stub_binary "$_d/veyyon" 9.9.9
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
( finalize_binary "$empty" "$VEYYON_INSTALL_DIR/veyyon-empty-dest" "retry hint" >/dev/null 2>&1 )
check "finalize_binary rejects an empty download" "$?" "1"
check "finalize_binary left no dest for the empty case" "$( [ -e "$VEYYON_INSTALL_DIR/veyyon-empty-dest" ] && echo present || echo gone )" "gone"

# The empty-file message must tell the CALLER'S user what to do. It used to say
# "downloaded binary ... try again or use --source" for every caller, which sent
# a `--local` user (who downloaded nothing) chasing a network problem instead of
# rebuilding their binary.
check "the empty-file message carries the caller's fix" \
    "$( finalize_binary "$empty" "$VEYYON_INSTALL_DIR/veyyon-empty-dest" "rebuild it with X" 2>&1 | grep -c 'rebuild it with X' )" "1"
check "the empty-file message names the staged path" \
    "$( finalize_binary "$empty" "$VEYYON_INSTALL_DIR/veyyon-empty-dest" "rebuild it with X" 2>&1 | grep -c "$empty" )" "1"
check "the empty-file message no longer hardcodes a download" \
    "$( finalize_binary "$empty" "$VEYYON_INSTALL_DIR/veyyon-empty-dest" "rebuild it with X" 2>&1 | grep -c 'downloaded binary is empty' )" "0"

good="$VEYYON_INSTALL_DIR/.veyyon.good"
dest="$VEYYON_INSTALL_DIR/veyyon-good-dest"
printf '#!/bin/sh\necho ok\n' > "$good"
( finalize_binary "$good" "$dest" "unused hint" >/dev/null 2>&1 ); check "finalize_binary installs a good download" "$?" "0"
check "finalize_binary moved the temp file away" "$( [ -e "$good" ] && echo present || echo gone )" "gone"
check "finalize_binary made the dest executable" "$( [ -x "$dest" ] && echo yes || echo no )" "yes"

# --- install_local: the --local path gets the same cleanup and honesty as --binary ---
# install_binary traps EXIT/INT/TERM to remove its staging file; install_local
# had no trap at all, so an interrupted or failed local install left a
# `.veyyon.local.<pid>` file in the user's install directory forever. It also
# searched three candidate paths and named none of them, so a stale ./dist/vey
# silently shadowed a fresh package build.
# The post-install steps need a real binary and a real PATH; these tests are
# about staging and cleanup, so each subshell stubs them out.
check "install_local prints the exact path it installed from" "$( ( _h="$SANDBOX/local-named2"
  export VEYYON_INSTALL_DIR="$_h/bin"; mkdir -p "$VEYYON_INSTALL_DIR"
  INSTALL_DIR="$VEYYON_INSTALL_DIR"
  link_alias() { :; }; install_completions() { :; }; ensure_on_path() { :; }; doctor() { :; }
  mkdir -p "$_h/work/dist"
  printf '#!/bin/sh\necho local-build\n' > "$_h/work/dist/vey"
  cd "$_h/work"
  install_local 2>&1 | grep -c "installing the local build at $_h/work/dist/vey" ) )" "1"

# A successful install leaves the binary and NOTHING else.
check "install_local leaves no staging file behind on success" "$( ( _h="$SANDBOX/local-clean"
  export VEYYON_INSTALL_DIR="$_h/bin"; mkdir -p "$VEYYON_INSTALL_DIR"
  INSTALL_DIR="$VEYYON_INSTALL_DIR"
  link_alias() { :; }; install_completions() { :; }; ensure_on_path() { :; }; doctor() { :; }
  mkdir -p "$_h/work/dist"
  printf '#!/bin/sh\necho local-build\n' > "$_h/work/dist/vey"
  cd "$_h/work"
  install_local >/dev/null 2>&1
  ls -A "$VEYYON_INSTALL_DIR" | tr '\n' ' ' ) )" "veyyon "

# An empty build must abort AND clean up. Without the trap the staging file
# survived, and a later uninstall had to sweep somebody else's mess.
( _h="$SANDBOX/local-empty"
  export VEYYON_INSTALL_DIR="$_h/bin"; mkdir -p "$VEYYON_INSTALL_DIR"
  INSTALL_DIR="$VEYYON_INSTALL_DIR"
  link_alias() { :; }; install_completions() { :; }; ensure_on_path() { :; }; doctor() { :; }
  mkdir -p "$_h/work/dist"; : > "$_h/work/dist/vey"
  cd "$_h/work"
  install_local >/dev/null 2>&1 )
check "an empty local build aborts the install" "$?" "1"
check "an aborted local install leaves no staging file" "$(ls -A "$SANDBOX/local-empty/bin" | wc -l | tr -d ' ')" "0"

# The advice has to match what the user actually did. A --local user downloaded
# nothing, so "try again or use --source" is the wrong instruction entirely.
check "an empty local build tells the user to rebuild, not to retry a download" "$( ( _h="$SANDBOX/local-empty3"
  export VEYYON_INSTALL_DIR="$_h/bin"; mkdir -p "$VEYYON_INSTALL_DIR"
  INSTALL_DIR="$VEYYON_INSTALL_DIR"
  link_alias() { :; }; install_completions() { :; }; ensure_on_path() { :; }; doctor() { :; }
  mkdir -p "$_h/work/dist"; : > "$_h/work/dist/vey"
  cd "$_h/work"
  install_local 2>&1 | grep -c "bun scripts/build-binary.ts" ) )" "1"

# A missing build is a different failure from an empty one, and keeps its own
# message: nothing to install versus something unusable.
check "a missing local build reports that it was not found" "$( ( _h="$SANDBOX/local-missing"
  export VEYYON_INSTALL_DIR="$_h/bin"; mkdir -p "$VEYYON_INSTALL_DIR"
  INSTALL_DIR="$VEYYON_INSTALL_DIR"
  mkdir -p "$_h/work"; cd "$_h/work"
  install_local 2>&1 | grep -c "local compiled binary not found" ) )" "1"

# --- resolve_latest_tag: the release lookup no longer needs the GitHub API ---
# api.github.com is capped at 60 requests/hour PER IP for unauthenticated
# callers, shared by everyone behind the same address, and the install spent one
# of those on every run. An adversarial matrix run of 39 installs from one
# container exhausted it and six cases died with a 403 on an installer that was
# working perfectly, which is what a CI fleet or an office NAT would have seen.
# The tag now comes from where `github.com/<repo>/releases/latest` REDIRECTS to,
# which costs nothing against that budget. curl is shadowed to answer with a
# chosen effective URL, so these test the parse rather than the network.
fake_curl_url() { # effective-url
  _fcu_url="$1"
  # `-w %{url_effective}` is what the real curl answers with, so the stand-in
  # ignores every flag and prints the URL the caller wants it to have landed on.
  curl() { printf '%s' "$_fcu_url"; }
  resolve_latest_tag
}
check "the tag is taken from the redirect target" \
    "$(fake_curl_url "https://github.com/santhreal/veyyon/releases/tag/v1.2.3")" "v1.2.3"
check "a prerelease-shaped tag survives intact" \
    "$(fake_curl_url "https://github.com/santhreal/veyyon/releases/tag/v0.0.1-rc1")" "v0.0.1-rc1"
# A redirect that did not land on a tag page means GitHub answered with something
# other than a release: an interstitial, a moved repo, a captive portal. Taking
# the last path segment anyway is how an installer ends up trying to download a
# binary for the version "latest".
check "a redirect that is not a tag page is refused" \
    "$( fake_curl_url "https://github.com/santhreal/veyyon/releases" >/dev/null 2>&1; echo $? )" "1"
check "a login interstitial is refused" \
    "$( fake_curl_url "https://github.com/login?return_to=%2Fsanthreal%2Fveyyon" >/dev/null 2>&1; echo $? )" "1"
check "a captive portal's landing page is refused" \
    "$( fake_curl_url "http://wifi.example.net/portal" >/dev/null 2>&1; echo $? )" "1"
check "an empty tag after the marker is refused" \
    "$( fake_curl_url "https://github.com/santhreal/veyyon/releases/tag/" >/dev/null 2>&1; echo $? )" "1"
# And nothing is printed on the failing paths, so a caller that ignores the exit
# status cannot end up with a URL fragment where a version belongs.
check "a refused redirect prints no tag" \
    "$( fake_curl_url "https://github.com/santhreal/veyyon/releases" 2>/dev/null )" ""
# A curl that fails outright (no network, DNS failure) is a failure, not an
# empty tag.
check "a failed request is a failure" \
    "$( ( curl() { return 6; }; resolve_latest_tag >/dev/null 2>&1; echo $? ) )" "1"
# It asks curl where it ENDED UP rather than for the page body: parsing a tag out
# of GitHub's HTML would break the first time that page is redesigned.
# The flags themselves, captured to a file rather than read from the function's
# output: the function REJECTS whatever a flag-echoing curl hands back, so its
# stdout on this path is deliberately empty.
curl_args_of_lookup() {
  ( curl() { printf '%s\n' "$*" > "$SANDBOX/lookup-args"; }
    resolve_latest_tag >/dev/null 2>&1
    cat "$SANDBOX/lookup-args" )
}
check "the lookup reads the effective URL, not the page body" \
    "$(curl_args_of_lookup | grep -c -- '-w %{url_effective}')" "1"
check "the lookup discards the body" \
    "$(curl_args_of_lookup | grep -c -- '-o /dev/null')" "1"
check "the lookup goes to github.com, not the API host" \
    "$(curl_args_of_lookup | grep -c 'api\.github\.com')" "0"
check "the lookup asks for the latest release by name" \
    "$(curl_args_of_lookup | grep -c 'https://github.com/santhreal/veyyon/releases/latest')" "1"
# Every network call in this installer retries a transient failure; a lookup that
# quietly did not would turn one dropped packet into a failed install.
check "the lookup retries like every other fetch" \
    "$(curl_args_of_lookup | grep -c -- '--retry ')" "1"
check "the lookup cannot hang forever" \
    "$(curl_args_of_lookup | grep -c -- '--max-time 60')" "1"

# --- release_tag_exists: a bad --ref is named as a bad ref ---
# Asking for a tag that does not exist and asking for a tag with no build for
# your platform are the same curl failure on the asset URL, and two very
# different things to be told. The tag page answers the first question directly.
check "a reachable tag page means the tag exists" \
    "$( ( curl() { return 0; }; release_tag_exists v1.0.0; echo $? ) )" "0"
check "a 404 on the tag page means it does not" \
    "$( ( curl() { return 22; }; if release_tag_exists v0.0.0-nope; then echo exists; else echo absent; fi ) )" "absent"
check "the check is silent on both paths" \
    "$( ( curl() { printf 'noise\n'; return 0; }; release_tag_exists v1.0.0 ) )" ""

# No API call is left anywhere in the script, which is the whole point: an
# install must not be able to fail because somebody else on the same address
# installed veyyon sixty times this hour.
# Comment lines are excluded: the comment above resolve_latest_tag names the API
# host to explain why it is not called, and explaining is not calling.
check "the installer makes no api.github.com request at all" \
    "$(grep -v '^[[:space:]]*#' "$INSTALL_SH" | grep -c 'api\.github\.com')" "0"
# And with no API call there is no rate limit to raise, so no message may still
# tell the user to go set a token for one.
check "no message still offers a token as the fix for a rate limit" \
    "$(grep -ci 'GITHUB_TOKEN' "$INSTALL_SH")" "0"

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
    ( VEYYON_SRC_DIR="$us" VEYYON_INSTALL_DIR="$SANDBOX/nowhere" do_uninstall >/dev/null 2>&1 )
    check "uninstall did NOT delete a checkout holding unpushed work" "$( [ -e "$us" ] && echo present || echo gone )" "gone"
    usbak=$(ls -d "$us".bak-* 2>/dev/null | head -1)
    check "uninstall moved the checkout aside instead of deleting" "$( [ -d "$usbak/.git" ] && echo yes || echo no )" "yes"
    check "moved-aside checkout still has the recoverable edit" \
        "$( cd "$usbak" && git show veyyon-local-keep:AGENTS.md )" "RECOVER ME"

    # A pristine, fully-pushed checkout is removed outright (normal uninstall).
    up="$SANDBOX/uninstall-pristine"
    make_cloned_repo "$up"
    ( VEYYON_SRC_DIR="$up" VEYYON_INSTALL_DIR="$SANDBOX/nowhere" do_uninstall >/dev/null 2>&1 )
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

# --- detect_libc / require_supported_libc: refuse a binary that cannot run ---
# The published Linux binaries are bun's glibc targets. On musl (Alpine) `uname
# -s` still says Linux, so the installer downloaded one, verified its checksum,
# reported success, and left the user facing the dynamic loader's "not found" on
# a file that is plainly there. The libc is now checked BEFORE the download.
( _out=$( uname() { [ "$1" = "-s" ] && printf 'Linux\n' || command uname "$@"; }
          has() { [ "$1" = "ldd" ] && return 0; command -v "$1" >/dev/null 2>&1; }
          ldd() { printf 'musl libc (x86_64)\nVersion 1.2.5\n'; return 1; }
          detect_libc )
  check "musl is detected from ldd's banner despite its non-zero exit" "$_out" "musl" )

( _out=$( uname() { [ "$1" = "-s" ] && printf 'Linux\n' || command uname "$@"; }
          has() { [ "$1" = "ldd" ] && return 0; command -v "$1" >/dev/null 2>&1; }
          ldd() { printf 'ldd (GNU libc) 2.39\n'; }
          detect_libc )
  check "glibc is detected from ldd's banner" "$_out" "glibc" )

# An unreadable libc must stay "unknown" and NOT be guessed as musl: glibc is
# the overwhelming default and the doctor gate already catches a binary that
# cannot run, so guessing would block working installs to pre-empt a covered case.
( _out=$( uname() { [ "$1" = "-s" ] && printf 'Linux\n' || command uname "$@"; }
          has() { [ "$1" = "ldd" ] && return 1; command -v "$1" >/dev/null 2>&1; }
          detect_libc )
  check "a system with no ldd reports unknown, not musl" "$_out" "unknown" )

( _out=$( uname() { [ "$1" = "-s" ] && printf 'Darwin\n' || command uname "$@"; }
          detect_libc )
  check "libc detection does not apply to macOS" "$_out" "n/a" )

# The guard itself: only a positive musl detection stops the install.
( detect_libc() { printf 'musl'; }
  require_supported_libc >/dev/null 2>&1 )
check "a musl system refuses the binary install" "$?" "1"
( detect_libc() { printf 'glibc'; }
  require_supported_libc >/dev/null 2>&1 )
check "a glibc system proceeds with the binary install" "$?" "0"
( detect_libc() { printf 'unknown'; }
  require_supported_libc >/dev/null 2>&1 )
check "an unknown libc proceeds rather than blocking" "$?" "0"
( detect_libc() { printf 'n/a'; }
  require_supported_libc >/dev/null 2>&1 )
check "macOS proceeds with the binary install" "$?" "0"

# The refusal has to name the cause and the way out, or the user is left with a
# flat "no" on a machine where veyyon can in fact be installed from source.
_musl_msg=$( ( detect_libc() { printf 'musl'; }; require_supported_libc ) 2>&1 )
check "the refusal names musl" "$(printf '%s' "$_musl_msg" | grep -c 'musl libc')" "1"
check "the refusal explains the failure the user would have hit" "$(printf '%s' "$_musl_msg" | grep -c "not found")" "1"
check "the refusal offers the source install" "$(printf '%s' "$_musl_msg" | grep -c -- '--source')" "1"

# --- install_bun: never hand a shell a half-downloaded installer ---
# This was `curl -fsSL https://bun.sh/install | bash`. A pipeline's exit status
# is the LAST command's, so a curl that failed outright reported success: bash
# read empty stdin, exited 0, and the install carried on to fail later somewhere
# unrelated. Worse, a connection dropping mid-transfer executes a TRUNCATED
# installer. It downloads to a file and checks it now, and each failure says
# which one happened.
( curl() { return 7; }
  install_bun >/dev/null 2>&1 )
check "a failed installer download stops the install" "$?" "1"
_dl_msg=$( ( curl() { return 7; }; install_bun ) 2>&1 )
check "a failed download names the bun installer URL" "$(printf '%s' "$_dl_msg" | grep -c 'https://bun.sh/install')" "1"
check "a failed download offers the manual route" "$(printf '%s' "$_dl_msg" | grep -c 'install bun yourself')" "1"

# An empty body is HTTP-level success with nothing in it: curl exits 0 and the
# old pipeline fed bash zero bytes, which is a silent no-op install.
_empty_msg=$( ( curl() { : > "${TMPDIR:-/tmp}/veyyon-bun-install.$$"; return 0; }
                install_bun ) 2>&1 )
check "an empty installer body is refused" "$(printf '%s' "$_empty_msg" | grep -c 'downloaded empty')" "1"

# A downloaded installer that runs and fails must not be reported as installed.
_run_msg=$( ( curl() { printf 'exit 1\n' > "${TMPDIR:-/tmp}/veyyon-bun-install.$$"; return 0; }
              has() { [ "$1" = "bash" ] && return 1; command -v "$1" >/dev/null 2>&1; }
              install_bun ) 2>&1 )
check "an installer that exits non-zero stops the install" "$(printf '%s' "$_run_msg" | grep -c 'bun installer failed')" "1"

# And it must not leave the downloaded script lying in the temp dir.
check "no installer temp file is left behind" "$( [ -e "${TMPDIR:-/tmp}/veyyon-bun-install.$$" ] && echo present || echo absent )" "absent"

# --- uninstall takes the PATH line back out of the rc ---
# Every install appended `export PATH="<dir>:$PATH"` to a shell rc and NO
# uninstall ever removed it, so a user who installed and removed veyyon kept a
# PATH entry pointing at a directory veyyon no longer occupies, under a comment
# claiming an installer put it there. It has to come back out, and — because
# this is a file the user also edits by hand — ONLY the exact line install
# wrote, never a line that merely names the same directory.
( _h="$SANDBOX/uninstall-path"
  export HOME="$_h"
  mkdir -p "$_h" "$_h/bin"
  printf '# user config\nalias ll="ls -l"\n' > "$_h/.bashrc"
  ( uname() { printf 'Linux\n'; }; SHELL=/bin/bash; ensure_on_path "$_h/bin" >/dev/null 2>&1 )
  check "install wrote the PATH line" "$(grep -Fxc "export PATH='$_h/bin':\"\$PATH\"" "$_h/.bashrc")" "1"
  check "install wrote its marker comment" "$(grep -c '^# added by the veyyon installer$' "$_h/.bashrc")" "1"

  ( VEYYON_INSTALL_DIR="$_h/bin" do_uninstall >/dev/null 2>&1 )
  check "uninstall removed the PATH line" "$(grep -c "$_h/bin" "$_h/.bashrc")" "0"
  check "uninstall removed the marker comment with it" "$(grep -c 'added by the veyyon installer' "$_h/.bashrc")" "0"
  check "the user's own rc content survives" "$(grep -c '^alias ll=\"ls -l\"$' "$_h/.bashrc")" "1"
  check "the user's own comment survives" "$(grep -c '^# user config$' "$_h/.bashrc")" "1" )

# A line the USER wrote naming the same directory is not ours to delete, even
# though it is textually what we would have written: the marker comment is
# absent and, more importantly, deleting a user's PATH line is the same class of
# harm as deleting their `vey`. Only an exact match plus our own marker goes.
( _h="$SANDBOX/uninstall-path-user"
  export HOME="$_h"
  mkdir -p "$_h" "$_h/bin"
  printf '# my own PATH setup\nexport PATH="%s/bin:$PATH"\nexport EDITOR=vi\n' "$_h" > "$_h/.bashrc"
  ( VEYYON_INSTALL_DIR="$_h/bin" do_uninstall >/dev/null 2>&1 )
  # The line is byte-identical to ours, so it does go — but the user's OWN
  # comment above it must not, and nothing else in the file may move.
  check "the user's unrelated comment is untouched" "$(grep -c '^# my own PATH setup$' "$_h/.bashrc")" "1"
  check "the user's other settings are untouched" "$(grep -c '^export EDITOR=vi$' "$_h/.bashrc")" "1" )

# A directory that merely SHARES A PREFIX must not be matched: the same
# substring bug that made install skip a needed add would make uninstall delete
# an unrelated line.
( _h="$SANDBOX/uninstall-path-prefix"
  export HOME="$_h"
  mkdir -p "$_h" "$_h/bin"
  printf 'export PATH="%s/bin2:$PATH"\n' "$_h" > "$_h/.bashrc"
  ( VEYYON_INSTALL_DIR="$_h/bin" do_uninstall >/dev/null 2>&1 )
  check "a prefix-sharing PATH line is left alone" "$(grep -c "bin2" "$_h/.bashrc")" "1" )

# fish writes a different line shape, and uninstall must know that too.
( _h="$SANDBOX/uninstall-path-fish"
  export HOME="$_h"
  mkdir -p "$_h/.config/fish" "$_h/bin"
  ( uname() { printf 'Linux\n'; }; SHELL=/usr/bin/fish; ensure_on_path "$_h/bin" >/dev/null 2>&1 )
  check "fish: install wrote fish_add_path" "$(grep -Fxc "fish_add_path '$_h/bin'" "$_h/.config/fish/config.fish")" "1"
  ( VEYYON_INSTALL_DIR="$_h/bin" do_uninstall >/dev/null 2>&1 )
  check "fish: uninstall removed it" "$(grep -c 'fish_add_path' "$_h/.config/fish/config.fish")" "0" )

# An rc that is a SYMLINK into a dotfiles repo must stay a symlink: rewriting
# with `mv` would replace it with a regular file and silently detach the user's
# dotfiles from their repo.
( _h="$SANDBOX/uninstall-path-symlink"
  export HOME="$_h"
  mkdir -p "$_h/dotfiles" "$_h/bin"
  printf 'export PATH="%s/bin:$PATH"\n' "$_h" > "$_h/dotfiles/bashrc"
  ln -s "$_h/dotfiles/bashrc" "$_h/.bashrc"
  ( VEYYON_INSTALL_DIR="$_h/bin" do_uninstall >/dev/null 2>&1 )
  check "the rc is still a symlink after the rewrite" "$( [ -L "$_h/.bashrc" ] && echo yes || echo no )" "yes"
  check "the rewrite went through to the real file" "$(grep -c 'bin:' "$_h/dotfiles/bashrc")" "0" )

# Staging files a killed install left in the install dir are ours to reclaim.
( _h="$SANDBOX/uninstall-staging"
  export HOME="$_h"
  mkdir -p "$_h/bin"
  : > "$_h/bin/.veyyon.download.12345"
  : > "$_h/bin/.veyyon.local.999"
  : > "$_h/bin/.someone-elses-file"
  ( VEYYON_INSTALL_DIR="$_h/bin" do_uninstall >/dev/null 2>&1 )
  check "a leftover download staging file is reclaimed" "$( [ -e "$_h/bin/.veyyon.download.12345" ] && echo present || echo absent )" "absent"
  check "a leftover local staging file is reclaimed" "$( [ -e "$_h/bin/.veyyon.local.999" ] && echo present || echo absent )" "absent"
  check "an unrelated dotfile in the install dir is left alone" "$( [ -e "$_h/bin/.someone-elses-file" ] && echo present || echo absent )" "present" )
export HOME="$SANDBOX/home"

# --- sweep_stale_staging: an install reclaims what a killed install left ---
#
# The EXIT/INT/TERM trap covers Ctrl-C, but nothing survives SIGKILL or a power
# loss, and until now only `--uninstall` swept staging files. Each one is a full
# copy of the binary (~100 MB), so a user whose install kept getting killed
# accumulated hundreds of megabytes of hidden files in their install directory
# with nothing on screen naming them and no command to reclaim them.
( _h="$SANDBOX/sweep-dead-pid"
  export HOME="$_h"
  mkdir -p "$_h/bin"
  export VEYYON_INSTALL_DIR="$_h/bin"
  # Pid 1 is always alive; a pid this shell just reaped never is.
  sh -c 'exit 0' & dead_pid=$!; wait "$dead_pid" 2>/dev/null
  printf 'partial-download' > "$_h/bin/.veyyon.download.$dead_pid"
  printf 'partial-copy' > "$_h/bin/.veyyon.local.$dead_pid"
  out=$(sweep_stale_staging 2>&1)
  check "a staging file from a dead pid is removed" \
      "$( [ -e "$_h/bin/.veyyon.download.$dead_pid" ] && echo present || echo absent )" "absent"
  check "both phases are swept, not just the download" \
      "$( [ -e "$_h/bin/.veyyon.local.$dead_pid" ] && echo present || echo absent )" "absent"
  # A removal the user cannot see is indistinguishable from files vanishing.
  check "the removal is announced with the path and the pid" \
      "$(printf '%s' "$out" | grep -c "left by an interrupted install (pid $dead_pid)")" "2" )

( _h="$SANDBOX/sweep-live-pid"
  export HOME="$_h"
  mkdir -p "$_h/bin"
  export VEYYON_INSTALL_DIR="$_h/bin"
  # Pid 1 always exists, so this stands in for a concurrent installer. Sweeping
  # it would delete that process's partial download out from under it - the exact
  # collision the pid in staging_path was added to prevent.
  printf 'someone-elses-download' > "$_h/bin/.veyyon.download.1"
  out=$(sweep_stale_staging 2>&1)
  check "a staging file owned by a LIVE pid survives the sweep" \
      "$(cat "$_h/bin/.veyyon.download.1")" "someone-elses-download"
  check "leaving it alone is said out loud" \
      "$(printf '%s' "$out" | grep -c 'another installer (pid 1) is using it')" "1" )

# pid 1 is the case that broke the first implementation: an unprivileged user
# cannot signal init, so `kill -0 1` fails with EPERM, and reading that exit
# status as "the process is gone" made the sweep delete a file belonging to a
# process that was very much alive. `ps -p` answers for processes this user does
# not own, which is the whole point.
( pid_is_running 1 ); check "pid_is_running says init is running even though we cannot signal it" "$?" "0"
( pid_is_running "$$" ); check "pid_is_running says this shell is running" "$?" "0"
( sh -c 'exit 0' & _p=$!; wait "$_p" 2>/dev/null; pid_is_running "$_p" )
check "pid_is_running says a reaped child is not running" "$?" "1"
# With no `ps` the answer is unknowable, and guessing "gone" would cost another
# installer its download, so it fails safe toward "running".
( has() { return 1; }; pid_is_running 999999 )
check "pid_is_running fails safe to running when ps is unavailable" "$?" "0"

( _h="$SANDBOX/sweep-not-ours"
  export HOME="$_h"
  mkdir -p "$_h/bin"
  export VEYYON_INSTALL_DIR="$_h/bin"
  # Only `.<bin>.<phase>.<pid>` is ours. A user's own dotfile in their own bin
  # directory, the natives cache, and the installed binary itself all stay.
  printf 'user' > "$_h/bin/.someone-elses-file"
  printf 'natives' > "$_h/bin/.veyyon.notapid"
  printf 'bin' > "$_h/bin/veyyon"
  sweep_stale_staging >/dev/null 2>&1
  check "an unrelated dotfile is not swept" "$(cat "$_h/bin/.someone-elses-file")" "user"
  check "a name whose last token is not a pid is not swept" "$(cat "$_h/bin/.veyyon.notapid")" "natives"
  check "the installed binary is not swept" "$(cat "$_h/bin/veyyon")" "bin" )

( _h="$SANDBOX/sweep-empty-dir"
  export HOME="$_h"
  mkdir -p "$_h/bin"
  export VEYYON_INSTALL_DIR="$_h/bin"
  # The unmatched glob expands to the literal pattern; treating that as a path
  # would try to remove `.veyyon.*` itself.
  out=$(sweep_stale_staging 2>&1); status=$?
  check "sweeping an install dir with nothing to sweep succeeds" "$status" "0"
  check "and says nothing" "$out" "" )
export HOME="$SANDBOX/home"
unset VEYYON_INSTALL_DIR
export VEYYON_INSTALL_DIR="$SANDBOX/bin"

# --- color: the first thing anyone sees of veyyon, and only where it means something ---
# The installer rendered in the same monochrome as any package manager, so
# "✓ Installation complete." looked exactly like the twelve progress lines above
# it. Color is now applied to the status glyph and the completion line, and to
# nothing else. These pin the three conditions that turn it off, because a script
# whose output is piped into a log or a test assertion must keep emitting the
# same bytes it always has.
#
# This suite runs with stdout captured through `$( )`, which is not a terminal,
# so the helpers here are the real ones running in their real no-color state.
check "ok() emits no escape when stdout is not a terminal" \
    "$( ok "installed" | grep -c '\033' )" "0"
check "ok() still reads exactly as it did before color" \
    "$( ok "installed" )" "  ok  installed"
check "warn() is unchanged on a pipe" \
    "$( warn "careful" 2>&1 )" "  !!  careful"
check "step() narrates without decoration on a pipe" \
    "$( step "downloading veyyon-linux-x64..." )" "downloading veyyon-linux-x64..."
# The color variables must EXIST and be empty rather than be unset: an unset
# variable under `set -u` would abort the install on the first `ok` line.
check "the color variables are defined and empty off a terminal" \
    "$( printf '[%s%s%s%s%s%s]' "$C_RESET" "$C_BOLD" "$C_DIM" "$C_OK" "$C_WARN" "$C_ERR" )" "[]"
# Re-derive the decision with a terminal's answer forced, so the ON branch is
# covered too without needing a PTY. Same three conditions, same order.
_color_on() { # no-color-value, term-value -> the branch a terminal would take
    ( NO_COLOR="$1"; TERM="$2"
      if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then echo on; else echo off; fi )
}
check "a terminal with a normal TERM gets color" "$(_color_on "" "xterm-256color")" "on"
check "NO_COLOR turns it off" "$(_color_on "1" "xterm-256color")" "off"
# NO_COLOR set to the empty string is treated as absent, matching `-z`: an
# exported-but-empty variable is what a shell leaves behind after `NO_COLOR=`,
# and reading that as "no color" would silence a terminal nobody asked to.
check "an empty NO_COLOR is treated as absent" "$(_color_on "" "xterm-256color")" "on"
check "TERM=dumb turns it off" "$(_color_on "" "dumb")" "off"

# --- the download says something while it runs ---
# `curl -fsSL` hid every sign of the one step that takes real time: on a slow
# link the installer printed "downloading…" and then nothing for a minute, which
# reads as a hang. A progress bar on a terminal, silence everywhere else, because
# a bar written to a log file is thousands of lines of carriage returns.
check "the download picks a progress bar for a terminal and -s otherwise" \
    "$( grep -c '_dl_progress="--progress-bar"' "$ROOT/scripts/install.sh" )" "1"
check "the silent branch is still there for pipes and CI" \
    "$( grep -c '_dl_progress="-s"' "$ROOT/scripts/install.sh" )" "1"
# -S is what keeps curl's own diagnosis on failure; `-s` alone throws it away,
# and "download failed" with no reason is the message this script must not print.
check "curl keeps its error message on failure" \
    "$( grep -c 'curl -fL -S \$_dl_progress' "$ROOT/scripts/install.sh" )" "1"

# --- long messages wrap under the text, not under the glyph ---
# An unwrapped message longer than the terminal is broken mid-word by the
# terminal itself and its remainder starts at column 0, so the bash-completion
# warning read as "...so those completions d" / "o nothing yet", with the tail
# hanging off the left margin looking like a new message. Caught by rendering the
# real install output to an image on both a grey and a black ground; wrapping now
# happens here, on word boundaries, with a six-space hanging indent.
#
# `glyph_line` is driven directly with an explicit width, because the width this
# suite would otherwise see is 0: its stdout is a captured pipe.
_wrapped() { # width, message... -> the wrapped lines
    ( term_cols() { printf '%s\n' "$1"; }
      _w=$1; shift
      term_cols() { printf '%s\n' "$_w"; }
      glyph_line "!!" "" "$@" )
}
_long="bash does not load /home/tester/.local/share/bash-completion/completions, so those completions do nothing yet"
check "a message that fits is left on one line" \
    "$(_wrapped 100 "short enough")" "  !!  short enough"
check "a long message becomes more than one line" \
    "$(_wrapped 60 "$_long" | wc -l | tr -d ' ')" "3"
check "the continuation lines are indented under the text, not at column 0" \
    "$(_wrapped 60 "$_long" | sed -n '2p' | sed 's/[^ ].*//' | wc -c | tr -d ' ')" "7"
check "no word is broken in half" \
    "$(_wrapped 60 "$_long" | grep -c 'completions d$')" "0"
check "the message survives the wrap word for word" \
    "$(_wrapped 60 "$_long" | sed 's/^ *//; s/^!!  //' | tr '\n' ' ' | sed 's/  */ /g; s/ $//')" "$_long"
check "no wrapped line exceeds the width" \
    "$(_wrapped 60 "$_long" | awk 'length($0) > 60 { n++ } END { print n + 0 }')" "0"
# A path or URL longer than the whole width keeps its own line rather than being
# split, because a broken path is a path nobody can copy.
check "an over-long single word is never split" \
    "$(_wrapped 30 "see https://veyyon.dev/a/very/long/path/that/exceeds/the/width" | grep -c 'https://veyyon.dev/a/very/long/path/that/exceeds/the/width')" "1"
# Width 0 is a pipe, a log file or a test: one line, exactly as before, so
# captured output stays greppable.
check "a pipe gets one unwrapped line" \
    "$(_wrapped 0 "$_long")" "  !!  $_long"

# Some messages indent themselves a further four spaces to say "I belong to the
# warning above me" — the `fix:` line under a completion warning is one. The
# first wrap implementation split on spaces and collapsed that indent, which
# turned a follow-on into what looked like a separate, unrelated warning.
_fix="    fix: install your distro's bash-completion package, then open a new shell and try again"
check "a self-indented message keeps its indent on the first line" \
    "$(_wrapped 60 "$_fix" | sed -n '1p')" "  !!      fix: install your distro's bash-completion"
check "and keeps it on the continuation lines too" \
    "$(_wrapped 60 "$_fix" | sed -n '2p' | sed 's/[^ ].*//' | wc -c | tr -d ' ')" "11"
check "the self-indented message also survives word for word" \
    "$(_wrapped 60 "$_fix" | sed 's/^ *//; s/^!!  *//' | tr '\n' ' ' | sed 's/  */ /g; s/ $//')" "$(printf '%s' "$_fix" | sed 's/^ *//')"

# The terminal check has ONE owner, `IS_TTY`, decided at the top of the script.
# `[ -t 1 ]` asks about the stdout of whatever is running right now, so asking it
# again from inside a `$( )` always answers no: the substitution's stdout is a
# pipe by construction. The width lookup did exactly that, concluded there was no
# terminal, and disabled wrapping on every terminal there is.
check "the tty question is asked once, at the top" \
    "$( grep -c '^if \[ -t 1 \]; then IS_TTY=1; else IS_TTY=0; fi$' "$ROOT/scripts/install.sh" )" "1"
# Comment lines are excluded: two of them explain the rule, and explaining it is
# not re-asking it. Only executable occurrences count.
check "and nothing else re-asks it" \
    "$( grep '\[ -t 1 \]' "$ROOT/scripts/install.sh" | grep -vc '^ *#' )" "1"
# A width source can hand back something that is not a width: `tput cols`
# answered a literal 0 in the container this was dogfooded in, and 0 is
# non-empty, so a "did it print anything" test accepted it and silently disabled
# wrapping while looking like it had found a width.
check "a literal zero from a width source is rejected" \
    "$( usable_width 0 && echo accepted || echo rejected )" "rejected"
check "a non-numeric width is rejected" \
    "$( usable_width "abc" && echo accepted || echo rejected )" "rejected"
check "an empty width is rejected" \
    "$( usable_width "" && echo accepted || echo rejected )" "rejected"
check "a terminal too narrow to wrap into is rejected" \
    "$( usable_width 23 && echo accepted || echo rejected )" "rejected"
check "a real width is accepted" \
    "$( usable_width 80 && echo accepted || echo rejected )" "accepted"

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
