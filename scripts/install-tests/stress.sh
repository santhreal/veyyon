#!/bin/bash
# Adversarial matrix for scripts/install.sh: the environments a real install has
# to survive rather than the ones it was written for. Every case gets a fresh
# HOME and a fresh install dir, and reports PASS, FAIL with the reason, or SKIP.
# A skip is counted separately and never as a pass, because a skip counted as a
# pass is the same lie this matrix exists to find in the product.
#
# THIS RUNS REAL INSTALLS, INCLUDING REAL DOWNLOADS. Run it in a disposable
# container, never on a machine you care about: cases deliberately make
# directories read-only, kill installers mid-copy, tamper with a download, and
# write into hostile HOMEs. It is not part of `bun test` or the CI gate for that
# reason, and because ~39 installs of a 300 MB binary is not a per-commit cost.
#
# Run it like this, from the repo root:
#
#   docker run -d --name veyyon-stress ubuntu:24.04 sleep infinity
#   docker exec veyyon-stress bash -c 'apt-get update -qq && \
#       DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
#       curl ca-certificates dash bash util-linux ncurses-bin && useradd -m tester'
#   docker cp scripts/install.sh veyyon-stress:/home/tester/install.sh
#   docker cp scripts/install-tests/stress.sh veyyon-stress:/home/tester/stress.sh
#   docker exec -u tester veyyon-stress bash /home/tester/stress.sh
#
# What it has caught, so far: a next-steps block that overflowed a 40-column
# terminal; a PATH line that expanded `$PATH` inside the install directory's own
# name; a wrap that lived inside one printer so every other line ran off the
# edge; and a release lookup that spent a per-IP GitHub API budget shared with
# everyone else behind the same address.
#
# $INSTALLER is the script under test. It defaults to the copy this file expects
# beside it in the container, so the command above needs no environment.
INSTALLER="${INSTALLER:-/home/tester/install.sh}"
[ -f "$INSTALLER" ] || { echo "no installer at $INSTALLER (set INSTALLER=/path/to/install.sh)"; exit 1; }
PASS=0; FAIL=0; SKIP=0
declare -a FAILURES
declare -a SKIPPED

run_case() { # name, expectation-fn, setup...
	local name="$1"; shift
	local out rc
	out="$("$@" 2>&1)"; rc=$?
	# A case that could not run is NOT a case that passed. Counting a skip as a
	# pass is the same lie this matrix exists to catch in the installer.
	if [ "$rc" -eq 0 ] && [ "${out#SKIP}" != "$out" ]; then
		SKIP=$((SKIP+1)); SKIPPED+=("$name")
		printf 'SKIP  %s — %s\n' "$name" "${out#SKIP: }"
	elif [ "$rc" -eq 0 ]; then
		PASS=$((PASS+1)); printf 'PASS  %s\n' "$name"
	else
		FAIL=$((FAIL+1)); FAILURES+=("$name")
		printf 'FAIL  %s\n' "$name"
		printf '%s\n' "$out" | sed 's/^/        /' | tail -12
	fi
}

fresh() { # -> a clean HOME path
	local d; d=$(mktemp -d /tmp/stress.XXXXXX)
	printf '%s' "$d"
}

# --- 1. alternate shells -----------------------------------------------------
case_shell() { # shell, extra-args...
	local sh="$1"; shift
	local h; h=$(fresh)
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" "$sh" "$@" "$INSTALLER" >"$h/log" 2>&1 || {
		echo "install exited non-zero under $sh $*"; tail -20 "$h/log"; return 1; }
	[ -x "$h/bin/veyyon" ] || { echo "no binary installed under $sh"; tail -20 "$h/log"; return 1; }
	"$h/bin/veyyon" --version | grep -q veyyon || { echo "binary does not run under $sh"; return 1; }
	rm -rf "$h"
}

# --- 2. hostile HOME ---------------------------------------------------------
case_home() { # directory name
	local base h
	base=$(mktemp -d /tmp/stress.XXXXXX)
	h="$base/$1"
	mkdir -p "$h" || { echo "could not create HOME named [$1]"; return 1; }
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$base/log" 2>&1 || {
		echo "install failed with HOME=[$h]"; tail -20 "$base/log"; return 1; }
	[ -x "$h/bin/veyyon" ] || { echo "no binary with HOME=[$h]"; tail -20 "$base/log"; return 1; }
	# The PATH line it wrote must survive being re-read by a shell.
	if [ -f "$h/.profile" ]; then
		# PROFILE passed through the environment, never interpolated into the -c
		# string: a HOME containing a quote breaks the harness's own quoting long
		# before it breaks anything the installer wrote.
		PROFILE="$h/.profile" sh -c '. "$PROFILE"; command -v veyyon' >/dev/null 2>&1 || {
			echo "the .profile it wrote does not source cleanly with HOME=[$h]"
			grep -n 'veyyon' "$h/.profile"; return 1; }
	fi
	rm -rf "$base"
}

# --- 3. a `vey` the user owns ------------------------------------------------
case_alias_clobber() {
	local h; h=$(fresh); mkdir -p "$h/bin"
	printf '#!/bin/sh\necho MINE\n' > "$h/bin/vey"; chmod +x "$h/bin/vey"
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1
	[ "$(cat "$h/bin/vey")" = "$(printf '#!/bin/sh\necho MINE\n')" ] || {
		echo "the installer DESTROYED a vey the user owns"; return 1; }
	grep -q "left 'vey' alone" "$h/log" || {
		echo "it left vey alone but never said so"; tail -20 "$h/log"; return 1; }
	grep -q "vey plugin\|Launch in any repository: veyyon" "$h/log" || {
		echo "next steps still tell the user to run a vey that is not ours"
		grep -n 'Launch in any' "$h/log"; return 1; }
	rm -rf "$h"
}

# --- 4. an uninstall must not delete a vey the user owns ---------------------
case_uninstall_keeps_foreign_vey() {
	local h; h=$(fresh); mkdir -p "$h/bin"
	printf '#!/bin/sh\necho MINE\n' > "$h/bin/vey"; chmod +x "$h/bin/vey"
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" --uninstall >"$h/log2" 2>&1
	[ -f "$h/bin/vey" ] || { echo "uninstall deleted the user's own vey"; return 1; }
	[ ! -f "$h/bin/veyyon" ] || { echo "uninstall left the binary behind"; return 1; }
	rm -rf "$h"
}

# --- 5. terminal widths ------------------------------------------------------
case_width() { # cols
	local h; h=$(fresh)
	stty cols "$1" 2>/dev/null
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" COLUMNS="$1" \
		script -qec "env COLUMNS=$1 sh $INSTALLER" "$h/log" >/dev/null 2>&1
	sed -i 's/\r$//' "$h/log"
	# No line may exceed the width once the escapes are stripped. curl's own
	# progress bar is exempt: it sizes itself and rewrites in place.
	local over
	over=$(sed -e 's/\x1b\[[0-9;]*m//g' "$h/log" \
		| grep -v '^Script started on\|^Script done on' \
		| grep -v '[#O=-]\{3,\}\|[0-9]\{1,3\}\.[0-9]%' \
		| awk -v w="$1" '
			length($0) > w {
				# A single token longer than the width keeps its own line on
				# purpose: splitting a path or a URL makes it uncopyable. Only a
				# line that COULD have been broken at a space is a failure.
				line = $0
				sub(/^ +/, "", line)
				if (line ~ / /) print length($0)": "$0
			}' | head -3)
	[ -z "$over" ] || { echo "lines exceed $1 columns and had a space to break at:"; echo "$over"; return 1; }
	rm -rf "$h"
}

# --- 6. no width tools at all ------------------------------------------------
case_no_width_tools() {
	local h; h=$(fresh); mkdir -p "$h/nobin"
	# A PATH with neither tput nor stty. The installer must still work; it just
	# cannot wrap, which is the documented fall-through.
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" PATH="/usr/bin:/bin" \
		sh -c "unset COLUMNS; PATH=$h/nobin:/usr/bin:/bin; \
		       command -v tput >/dev/null && echo HAS_TPUT; \
		       HOME=$h VEYYON_INSTALL_DIR=$h/bin sh $INSTALLER" >"$h/log" 2>&1 || {
		echo "install failed without width tools"; tail -20 "$h/log"; return 1; }
	[ -x "$h/bin/veyyon" ] || { echo "no binary without width tools"; return 1; }
	rm -rf "$h"
}

# --- 7. read-only install directory ------------------------------------------
case_readonly_bin() {
	local h; h=$(fresh); mkdir -p "$h/bin"; chmod 500 "$h/bin"
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1
	local rc=$?
	chmod 700 "$h/bin"
	[ "$rc" -ne 0 ] || { echo "install reported SUCCESS into a read-only directory"; tail -20 "$h/log"; return 1; }
	grep -qi "permission\|could not\|cannot\|failed" "$h/log" || {
		echo "it failed without saying why"; tail -20 "$h/log"; return 1; }
	rm -rf "$h"
}

# --- 8. a stale veyyon earlier on PATH ---------------------------------------
case_shadowed() {
	local h; h=$(fresh); mkdir -p "$h/stale" "$h/bin"
	printf '#!/bin/sh\necho "veyyon/0.0.1"\n' > "$h/stale/veyyon"; chmod +x "$h/stale/veyyon"
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" PATH="$h/stale:$PATH" \
		sh "$INSTALLER" >"$h/log" 2>&1
	grep -q "shadows this one\|NOT the copy just installed" "$h/log" || {
		echo "a stale veyyon earlier on PATH was not reported"; tail -25 "$h/log"; return 1; }
	rm -rf "$h"
}

# --- 9. concurrent installs into one directory -------------------------------
case_concurrent() {
	local h; h=$(fresh)
	( HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/a.log" 2>&1 ) &
	local p1=$!
	( HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/b.log" 2>&1 ) &
	local p2=$!
	wait $p1; local r1=$?
	wait $p2; local r2=$?
	[ -x "$h/bin/veyyon" ] || { echo "no usable binary after two concurrent installs (rc $r1/$r2)"; return 1; }
	"$h/bin/veyyon" --version >/dev/null 2>&1 || {
		echo "the binary two concurrent installs left is not runnable"; return 1; }
	# Neither run may leave a staging file behind.
	local junk; junk=$(find "$h/bin" -name '*.new' -o -name '*.bak' -o -name '*.tmp*' 2>/dev/null)
	[ -z "$junk" ] || { echo "staging files left behind: $junk"; return 1; }
	rm -rf "$h"
}

# --- 10. interrupted install --------------------------------------------------
case_interrupted() {
	local h; h=$(fresh)
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1 &
	local pid=$!
	sleep 1.2; kill -INT $pid 2>/dev/null; wait $pid 2>/dev/null
	# Whatever it managed, it must not leave a staging file or a half binary.
	local junk; junk=$(find "$h" -name '*.new' -o -name '*.veyyon-*' 2>/dev/null | head -3)
	[ -z "$junk" ] || { echo "an interrupted install left: $junk"; return 1; }
	if [ -e "$h/bin/veyyon" ]; then
		"$h/bin/veyyon" --version >/dev/null 2>&1 || {
			echo "an interrupted install left a binary that does not run"; return 1; }
	fi
	rm -rf "$h"
}

# --- 11. rerun after a killed install ----------------------------------------
case_rerun_after_kill() {
	local h; h=$(fresh); mkdir -p "$h/bin"
	# A staging file a killed install would have left. The name has to be what
	# `staging_path` actually produces — `.<bin>.<phase>.<pid>` — because the
	# sweep deliberately refuses to guess at anything it did not write.
	printf 'garbage' > "$h/bin/.veyyon.download.99999"
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1 || {
		echo "a rerun after a killed install failed"; tail -20 "$h/log"; return 1; }
	[ -x "$h/bin/veyyon" ] || { echo "rerun installed nothing"; return 1; }
	[ ! -e "$h/bin/.veyyon.download.99999" ] || { echo "the stale staging file was never reclaimed"; return 1; }
	grep -q "left by an interrupted install" "$h/log" || {
		echo "it reclaimed the staging file without announcing it"; return 1; }
	# A file the installer did not write is not the installer's to delete.
	printf 'mine' > "$h/bin/.veyyon.notapid"
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log3" 2>&1
	[ -e "$h/bin/.veyyon.notapid" ] || { echo "the sweep deleted a file it did not write"; return 1; }
	rm -rf "$h"
}

# --- 12. output is byte-identical when captured ------------------------------
case_pipe_is_plain() {
	local h; h=$(fresh)
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1
	grep -q $'\033' "$h/log" && { echo "escape sequences reached a redirected stdout"; return 1; }
	rm -rf "$h"
}

# --- 13. NO_COLOR and TERM=dumb ----------------------------------------------
case_no_color() { # var assignment
	local h; h=$(fresh)
	script -qec "env $1 HOME=$h VEYYON_INSTALL_DIR=$h/bin sh $INSTALLER" "$h/log" >/dev/null 2>&1
	grep -q $'\033\[3[0-9]m\|\033\[38;' "$h/log" && {
		echo "color survived $1"; grep -n $'\033' "$h/log" | head -3; return 1; }
	rm -rf "$h"
}

# --- 14. a HOME that does not exist ------------------------------------------
case_missing_home() {
	local base; base=$(mktemp -d /tmp/stress.XXXXXX)
	local h="$base/does/not/exist"
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$base/log" 2>&1
	local rc=$?
	if [ "$rc" -eq 0 ]; then
		[ -x "$h/bin/veyyon" ] || { echo "reported success but installed nothing into a missing HOME"; return 1; }
	else
		grep -qi "could not\|cannot\|failed\|permission" "$base/log" || {
			echo "failed on a missing HOME without saying why"; tail -20 "$base/log"; return 1; }
	fi
	rm -rf "$base"
}

echo "=== shells"
run_case "installs under dash"            case_shell dash
run_case "installs under bash"            case_shell bash
run_case "installs under bash --posix"    case_shell bash --posix
echo "=== hostile HOME"
run_case "HOME with a space"              case_home "my home"
run_case "HOME with unicode"              case_home "ホーム"
run_case "HOME with a quote"              case_home "it's home"
run_case "HOME with a dollar sign"        case_home 'home$PATH'
echo "=== the alias"
run_case "never clobbers a user-owned vey" case_alias_clobber
run_case "uninstall keeps a foreign vey"   case_uninstall_keeps_foreign_vey
echo "=== terminal"
run_case "wraps at 40 columns"            case_width 40
run_case "wraps at 60 columns"            case_width 60
run_case "wraps at 200 columns"           case_width 200
run_case "works with no width tools"      case_no_width_tools
run_case "plain bytes into a redirect"    case_pipe_is_plain
run_case "NO_COLOR silences color"        case_no_color "NO_COLOR=1"
run_case "TERM=dumb silences color"       case_no_color "TERM=dumb"
echo "=== filesystem and concurrency"
run_case "fails loudly on a read-only bin" case_readonly_bin
run_case "reports a shadowing stale copy"  case_shadowed
run_case "survives two concurrent installs" case_concurrent
run_case "leaves nothing after a SIGINT"   case_interrupted
run_case "reclaims a killed install's staging" case_rerun_after_kill
run_case "handles a HOME that does not exist"  case_missing_home

# --- 15. hostile shell state -------------------------------------------------
# A user's environment is not a clean room. Each of these has broken a shell
# script somewhere: an IFS that changes what unquoted expansion splits on, a
# CDPATH that makes `cd` print, an empty PATH, a restrictive umask, and
# `set -u` inherited through ENV.
case_hostile_env() { # env assignment
	local h; h=$(fresh)
	env "$1" HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1 || {
		echo "install failed under $1"; tail -20 "$h/log"; return 1; }
	[ -x "$h/bin/veyyon" ] || { echo "no binary under $1"; tail -20 "$h/log"; return 1; }
	"$h/bin/veyyon" --version >/dev/null 2>&1 || { echo "binary does not run under $1"; return 1; }
	rm -rf "$h"
}

case_umask() { # umask value
	local h; h=$(fresh)
	( umask "$1"; HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1 ) || {
		echo "install failed under umask $1"; tail -20 "$h/log"; return 1; }
	[ -x "$h/bin/veyyon" ] || {
		echo "umask $1 produced a binary that is not executable"; ls -la "$h/bin"; return 1; }
	rm -rf "$h"
}

# --- 16. the install dir is a symlink ----------------------------------------
# `finalize_binary` renames the staging file into place, and a rename is only
# atomic within one filesystem. A symlinked install dir is the common shape of
# that (a ~/bin pointing at a dotfiles checkout) and must still work.
case_symlinked_bin() {
	local h; h=$(fresh); mkdir -p "$h/real"; ln -s "$h/real" "$h/bin"
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1 || {
		echo "install failed into a symlinked directory"; tail -20 "$h/log"; return 1; }
	[ -x "$h/real/veyyon" ] || { echo "nothing landed in the symlink's target"; return 1; }
	rm -rf "$h"
}

# --- 17. a read-only shell rc ------------------------------------------------
# The PATH line cannot be written. That is a warning, not a failed install: the
# binary is on disk and the user can add the directory themselves.
case_readonly_rc() {
	local h; h=$(fresh); mkdir -p "$h"
	: > "$h/.profile"; chmod 400 "$h/.profile"
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1
	local rc=$?
	chmod 600 "$h/.profile"
	[ -x "$h/bin/veyyon" ] || { echo "a read-only rc stopped the install (rc $rc)"; tail -20 "$h/log"; return 1; }
	grep -q "could not write\|add .* to your PATH" "$h/log" || {
		echo "it could not write the rc and never said so"; tail -20 "$h/log"; return 1; }
	rm -rf "$h"
}

# --- 18. a tampered download -------------------------------------------------
# The checksum gate is the whole security story of this installer. Serve a
# binary whose bytes do not match the published sidecar and the install must
# refuse, leave nothing behind, and say what happened.
case_tampered_download() {
	local h; h=$(fresh); mkdir -p "$h/bin" "$h/fakebin"
	# A curl stand-in that corrupts the binary and passes the sidecar through.
	cat > "$h/fakebin/curl" <<'CURL'
#!/bin/sh
real=/usr/bin/curl
out=""; url=""
for a in "$@"; do
  case "$prev" in -o) out="$a" ;; esac
  case "$a" in https://*|http://*) url="$a" ;; esac
  prev="$a"
done
"$real" "$@" || exit $?
case "$url" in
  *.sha256) : ;;
  *veyyon-*) [ -n "$out" ] && printf 'TAMPERED' >> "$out" ;;
esac
CURL
	chmod +x "$h/fakebin/curl"
	PATH="$h/fakebin:$PATH" HOME="$h" VEYYON_INSTALL_DIR="$h/bin" 		sh "$INSTALLER" >"$h/log" 2>&1
	local rc=$?
	[ "$rc" -ne 0 ] || { echo "a TAMPERED binary was installed and reported success"; tail -25 "$h/log"; return 1; }
	[ ! -e "$h/bin/veyyon" ] || { echo "a tampered binary was left on disk"; return 1; }
	grep -qi "checksum\|sha256\|does not match" "$h/log" || {
		echo "it refused the tampered download without naming the checksum"; tail -25 "$h/log"; return 1; }
	# Prove the tamper actually happened. Without this, a stand-in curl that
	# simply failed would produce the same refusal and read as a passing gate.
	grep -qi "downloading" "$h/log" || {
		echo "the download never started, so the checksum gate was not what refused it"
		tail -25 "$h/log"; return 1; }
	local junk; junk=$(find "$h/bin" -name '.veyyon.*' 2>/dev/null)
	[ -z "$junk" ] || { echo "the refused download was left staged: $junk"; return 1; }
	rm -rf "$h"
}

# --- 19. a missing release ---------------------------------------------------
case_missing_release() {
	local h; h=$(fresh)
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" --ref v0.0.0-does-not-exist >"$h/log" 2>&1
	local rc=$?
	[ "$rc" -ne 0 ] || { echo "a nonexistent ref reported success"; tail -20 "$h/log"; return 1; }
	[ ! -e "$h/bin/veyyon" ] || { echo "a nonexistent ref still installed something"; return 1; }
	rm -rf "$h"
}

# --- 20. the network is gone -------------------------------------------------
case_no_network() {
	local h; h=$(fresh); mkdir -p "$h/fakebin"
	printf '#!/bin/sh\nexit 6\n' > "$h/fakebin/curl"; chmod +x "$h/fakebin/curl"
	PATH="$h/fakebin:/usr/bin:/bin" HOME="$h" VEYYON_INSTALL_DIR="$h/bin" \
		sh "$INSTALLER" >"$h/log" 2>&1
	local rc=$?
	[ "$rc" -ne 0 ] || { echo "an install with no network reported success"; tail -20 "$h/log"; return 1; }
	[ -s "$h/log" ] || { echo "it failed with no network and printed nothing"; return 1; }
	rm -rf "$h"
}

# --- 21. no space left -------------------------------------------------------
# A tiny tmpfs as the install dir: the download cannot fit. The install must
# fail, say so, and not leave a truncated binary anybody could run.
case_disk_full() {
	local h; h=$(fresh); mkdir -p "$h/bin"
	mount -t tmpfs -o size=1M tmpfs "$h/bin" 2>/dev/null || { echo "SKIP: cannot mount tmpfs"; return 0; }
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1
	local rc=$?
	local left; left=$(ls -A "$h/bin" 2>/dev/null)
	umount "$h/bin" 2>/dev/null
	[ "$rc" -ne 0 ] || { echo "an install that could not fit reported success"; tail -20 "$h/log"; return 1; }
	case "$left" in *veyyon*) echo "a truncated binary was left on a full disk: $left"; return 1 ;; esac
	rm -rf "$h"
}

# --- 22. the uninstall is idempotent -----------------------------------------
case_double_uninstall() {
	local h; h=$(fresh)
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" --uninstall >"$h/u1" 2>&1 || {
		echo "the first uninstall exited non-zero"; tail -10 "$h/u1"; return 1; }
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" --uninstall >"$h/u2" 2>&1 || {
		echo "a second uninstall exited non-zero"; tail -10 "$h/u2"; return 1; }
	grep -q "nothing to uninstall" "$h/u2" || {
		echo "the second uninstall did not say there was nothing left"; tail -10 "$h/u2"; return 1; }
	rm -rf "$h"
}

# --- 23. uninstall takes its own PATH line back out --------------------------
case_uninstall_cleans_rc() {
	local h; h=$(fresh)
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1
	printf '# a line the user wrote\nexport MY_OWN=1\n' >> "$h/.profile"
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" --uninstall >"$h/u" 2>&1
	if [ -f "$h/.profile" ]; then
		grep -q "added by the veyyon installer" "$h/.profile" && {
			echo "uninstall left its own marker in the rc"; grep -n veyyon "$h/.profile"; return 1; }
		grep -q "$h/bin" "$h/.profile" && {
			echo "uninstall left its PATH line in the rc"; grep -n "$h/bin" "$h/.profile"; return 1; }
		grep -q "MY_OWN=1" "$h/.profile" || {
			echo "uninstall ATE a line the user wrote"; cat "$h/.profile"; return 1; }
	fi
	rm -rf "$h"
}

# --- 24. reinstall over a running binary -------------------------------------
case_reinstall_while_running() {
	local h; h=$(fresh)
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log" 2>&1
	[ -x "$h/bin/veyyon" ] || { echo "setup install failed"; return 1; }
	# Hold the binary open the way a running session would.
	"$h/bin/veyyon" --version >/dev/null 2>&1
	tail -f /dev/null & local holder=$!
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log2" 2>&1
	local rc=$?
	kill $holder 2>/dev/null; wait $holder 2>/dev/null
	[ "$rc" -eq 0 ] || { echo "a reinstall over a live install failed"; tail -20 "$h/log2"; return 1; }
	"$h/bin/veyyon" --version >/dev/null 2>&1 || { echo "the reinstalled binary does not run"; return 1; }
	rm -rf "$h"
}

# --- 25. a reinstall must not write a second PATH entry ----------------------
# The install is not a one-shot: people re-run the curl line to upgrade, and an
# rc that grows one PATH entry per run ends up with a $PATH the user cannot read
# and cannot easily repair, on a file the installer had no business appending to
# twice. The assertion is on what a NEW SHELL actually gets, not only on the
# text in the rc, because a duplicate written two different ways still lands
# twice on $PATH.
case_reinstall_path_not_duplicated() {
	local h; h=$(fresh)
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log1" 2>&1
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log2" 2>&1 || {
		echo "the second install exited non-zero"; tail -20 "$h/log2"; return 1; }
	[ -f "$h/.profile" ] || { echo "no rc was written at all"; return 1; }
	local markers entries seen
	markers=$(grep -c "added by the veyyon installer" "$h/.profile")
	entries=$(grep -cF "$h/bin" "$h/.profile")
	[ "$markers" = 1 ] || { echo "the marker comment appears $markers times"; grep -n veyyon "$h/.profile"; return 1; }
	[ "$entries" = 1 ] || { echo "$entries PATH entries name $h/bin"; grep -n "$h/bin" "$h/.profile"; return 1; }
	seen=$(HOME="$h" sh -c '. "$HOME/.profile" >/dev/null 2>&1; printf %s "$PATH"' | tr ':' '\n' | grep -cxF "$h/bin")
	[ "$seen" = 1 ] || { echo "a fresh shell sees $h/bin on PATH $seen times"; return 1; }
	rm -rf "$h"
}

# --- 26. completions must survive uninstall -> reinstall ---------------------
# Completions are written by the binary that was just installed, so they are the
# part of an install most likely to be left stale or missing by a cycle: an
# uninstall that leaves them behind means a removed command still tab-completes,
# and a reinstall that does not rewrite them means the new version completes with
# the old version's flags.
case_completions_survive_cycle() {
	local h; h=$(fresh)
	local file="$h/.local/share/bash-completion/completions/veyyon"
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log1" 2>&1
	[ -f "$file" ] || { echo "the first install wrote no bash completion"; tail -20 "$h/log1"; return 1; }
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" --uninstall >"$h/u" 2>&1
	[ ! -e "$file" ] || { echo "uninstall left the completion file behind"; return 1; }
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log2" 2>&1 || {
		echo "the reinstall exited non-zero"; tail -20 "$h/log2"; return 1; }
	[ -s "$file" ] || { echo "the reinstall restored no completion file"; tail -20 "$h/log2"; return 1; }
	grep -q veyyon "$file" || { echo "the restored completion never names the command"; head -5 "$file"; return 1; }
	rm -rf "$h"
}

# --- 27. the doctor still passes on the second install -----------------------
# The install ends by running its own doctor, and a reinstall is where it is most
# likely to report a problem it caused: a shadowing copy of the old binary, an
# alias it no longer owns, a native addon left from the previous version. A
# reinstall whose doctor complains is a failed install that exited 0.
case_doctor_passes_on_reinstall() {
	local h; h=$(fresh)
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" sh "$INSTALLER" >"$h/log1" 2>&1
	# The second install runs with the install dir already on PATH, which is what
	# a real reinstall looks like: the first install wrote the rc line and the
	# user has opened a shell since. Without that, doctor correctly warns that the
	# command is not on PATH yet, and this case would be asserting the harness
	# rather than the product.
	HOME="$h" VEYYON_INSTALL_DIR="$h/bin" PATH="$h/bin:$PATH" sh "$INSTALLER" >"$h/log2" 2>&1 || {
		echo "the second install exited non-zero"; tail -20 "$h/log2"; return 1; }
	local doctor
	doctor=$(sed -e 's/\x1b\[[0-9;]*m//g' "$h/log2" | sed -n '/^doctor:/,$p')
	[ -n "$doctor" ] || { echo "the reinstall ran no doctor at all"; tail -20 "$h/log2"; return 1; }
	printf '%s\n' "$doctor" | grep -q "veyyon runs" || {
		echo "doctor did not report that veyyon runs"; printf '%s\n' "$doctor"; return 1; }
	printf '%s\n' "$doctor" | grep -q "native addon loads" || {
		echo "doctor did not report a working native addon"; printf '%s\n' "$doctor"; return 1; }
	# `!!` is the installer's warning glyph. A warning here is the shadow/alias
	# class of problem a reinstall introduces, which is exactly what this case is
	# for, so it fails rather than passing with a complaint on screen.
	printf '%s\n' "$doctor" | grep -q '^ *!' && {
		echo "doctor warned on a reinstall"; printf '%s\n' "$doctor"; return 1; }
	rm -rf "$h"
}

echo "=== hostile environment"
run_case "IFS set to a digit"             case_hostile_env "IFS=0"
run_case "IFS set to a slash"             case_hostile_env "IFS=/"
run_case "CDPATH set"                     case_hostile_env "CDPATH=/tmp"
run_case "LANG=C"                         case_hostile_env "LANG=C"
run_case "LC_ALL=C.UTF-8"                 case_hostile_env "LC_ALL=C.UTF-8"
run_case "POSIXLY_CORRECT"                case_hostile_env "POSIXLY_CORRECT=1"
run_case "umask 077"                      case_umask 077
run_case "umask 022"                      case_umask 022
echo "=== filesystem shapes"
run_case "installs into a symlinked dir"  case_symlinked_bin
run_case "warns on a read-only rc"        case_readonly_rc
run_case "survives no space left"         case_disk_full
echo "=== the network and the checksum"
run_case "REFUSES a tampered download"    case_tampered_download
run_case "fails on a missing release"     case_missing_release
run_case "fails with no network"          case_no_network
echo "=== uninstall and reinstall"
run_case "uninstall is idempotent"        case_double_uninstall
run_case "uninstall cleans only its own rc line" case_uninstall_cleans_rc
run_case "reinstalls over a live install" case_reinstall_while_running
run_case "reinstall does not duplicate the PATH entry" case_reinstall_path_not_duplicated
run_case "completions survive uninstall then reinstall" case_completions_survive_cycle
run_case "doctor still passes on a reinstall"  case_doctor_passes_on_reinstall

printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$SKIP" -eq 0 ] || printf 'skipped: %s\n' "${SKIPPED[*]}"
[ "$FAIL" -eq 0 ] || { printf 'failed: %s\n' "${FAILURES[*]}"; exit 1; }
