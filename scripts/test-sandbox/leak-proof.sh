#!/usr/bin/env bash
# The red run. Proves the sandbox is real by trying to break out of it.
#
#   bash scripts/test-sandbox/leak-proof.sh            # every available rung
#   bash scripts/test-sandbox/leak-proof.sh remote     # one rung
#
# WHAT IT DOES
# ------------
# Writes a hostile script that does exactly what the 136 stray directories in the
# operator's home were caused by, only deliberately and to fixed paths:
#   ~/.veyyon/leaked        the config-root shape, through tilde expansion
#   $HOME/.veyyon-probe     the same, through the environment variable
#   <the real home>/...     the literal host path, hardcoded, no expansion at all
#   <the remote's home>/... the same again for the machine the container is on,
#                           which only the remote rung sets and only that rung has
#
# Then it lists those paths on the host before and after, and for the remote rung it
# lists them on the remote too. The third target is the one that matters: a sandbox
# that only moves HOME defeats the first two and leaves the third wide open, which
# is precisely the hole this whole exercise exists to close. The fourth is the same
# hole one machine over: keeping the operator's home clean by dirtying somebody
# else's is not a pass. A rung passes only when nothing appears on either host AND
# the guest was unable to create the literal host path.
#
# It also runs the hostile script OUTSIDE any sandbox, and requires that attempt to
# be REFUSED by the test bootstrap rather than allowed to write. A boundary that
# only works when you remember to use it is not a boundary.
set -euo pipefail

SANDBOX_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
REPO_ROOT="${VEYYON_SANDBOX_REPO_ROOT:-$(cd -- "${SANDBOX_DIR}/../.." && /bin/pwd -P)}"
ENTRYPOINT="${SANDBOX_DIR}/run.sh"

HOST_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
: "${HOST_HOME:=${HOME}}"

TARGETS=(
	"${HOST_HOME}/.veyyon/leaked"
	"${HOST_HOME}/.veyyon-probe"
	"${HOST_HOME}/.veyyon-literal-path-probe"
)

pass=0
fail=0

show_host_state() {
	local label="$1" t
	printf '  --- host state %s ---\n' "$label"
	for t in "${TARGETS[@]}"; do
		if [ -e "$t" ]; then
			printf '    PRESENT  %s\n' "$t"
		else
			printf '    absent   %s\n' "$t"
		fi
	done
}

# The remote rung runs the container on ANOTHER machine, so the local before/after
# listing above cannot see the one home the container is physically next to. This
# checks it, over the rung's own ssh settings, and it is a hard failure rather than
# a note: a rung that keeps the operator's home clean by dirtying somebody else's
# has not passed anything.
check_remote_home() {
	local out
	if ! out="$(bash "$ENTRYPOINT" --remote-shell 'for t in "$HOME/.veyyon/leaked" "$HOME/.veyyon-probe" "$HOME/.veyyon-literal-path-probe"; do if [ -e "$t" ]; then echo "PRESENT  $t"; else echo "absent   $t"; fi; done' 2>&1)"; then
		printf '  --- remote host state: could not inspect it ---\n'
		printf '%s\n' "$out" | sed 's/^/    /'
		return 1
	fi
	printf '  --- remote host state AFTER (on the machine the container ran on) ---\n'
	printf '%s\n' "$out" | sed 's/^/    /'
	! printf '%s' "$out" | grep -q PRESENT
}

# A leak that is reported and then left in place turns the next run's BEFORE state
# into somebody else's litter, and this one is on a machine the operator does not
# look at. Runs after the verdict, never before it.
cleanup_remote_targets() {
	bash "$ENTRYPOINT" --remote-shell 'rm -rf "$HOME/.veyyon/leaked" "$HOME/.veyyon-probe" "$HOME/.veyyon-literal-path-probe"; rmdir "$HOME/.veyyon" 2>/dev/null; exit 0' >/dev/null 2>&1 || :
	return 0
}
# The hostile payload. Deliberately not a bun test: the point is that a plain
# script with no bunfig, no preload and no cooperation whatsoever still cannot
# reach the host. That standalone-script case is exactly what the old preload
# defence could not cover.
HOSTILE=$(cat <<HOSTILE_EOF
set +e
echo "  guest: HOME=\$HOME"
echo "  guest: attempting ~/.veyyon/leaked"
mkdir -p ~/.veyyon && echo leaked > ~/.veyyon/leaked && echo "  guest: WROTE ~/.veyyon/leaked" || echo "  guest: could not write ~/.veyyon/leaked"
echo "  guest: attempting \\\$HOME/.veyyon-probe"
echo probe > "\$HOME/.veyyon-probe" && echo "  guest: WROTE \\\$HOME/.veyyon-probe" || echo "  guest: could not write \\\$HOME/.veyyon-probe"
echo "  guest: attempting the literal host path ${HOST_HOME}/.veyyon-literal-path-probe"
mkdir -p "${HOST_HOME}" 2>/dev/null
echo literal > "${HOST_HOME}/.veyyon-literal-path-probe" && echo "  guest: WROTE the literal host path" || echo "  guest: could not write the literal host path"
if [ -n "\${VEYYON_SANDBOX_REMOTE_HOME:-}" ]; then
echo "  guest: attempting the home of the machine the container runs on, \$VEYYON_SANDBOX_REMOTE_HOME"
mkdir -p "\$VEYYON_SANDBOX_REMOTE_HOME" 2>/dev/null
echo neighbour > "\$VEYYON_SANDBOX_REMOTE_HOME/.veyyon-literal-path-probe" && echo "  guest: WROTE the container host's home" || echo "  guest: could not write the container host's home"
fi
echo "  guest: can it even see the host home?"
ls -d "${HOST_HOME}" 2>&1 | sed 's/^/    /'
exit 0
HOSTILE_EOF
)

cleanup_targets() {
	local t
	for t in "${TARGETS[@]}"; do
		[ -e "$t" ] && rm -rf "$t"
	done
	rmdir "${HOST_HOME}/.veyyon" 2>/dev/null || :
	return 0
}

# The marker each rung's guest is required to export. Spelled out here rather than
# read from the rung files, so a rename in a rung shows up as a failure instead of
# being followed silently.
marker_for() {
	case "$1" in
		remote)  printf 'remote-docker' ;;
		docker)  printf 'container-docker' ;;
		microvm) printf 'qemu-microvm' ;;
		bwrap)   printf 'bwrap-userns' ;;
	esac
}

# Two properties that need a WORKING rung, which is why they live here and not in
# a bun suite: a test process is always already inside a guest, and a guest has no
# docker socket, no qemu and no ssh key to start another one with.
#
#   the exit status is the command's own, verbatim. 37 is arbitrary; only a
#   pass-through produces it. A rung that rewrote it would turn a red suite green,
#   or turn a green one into the 126 the driver reads as "the sandbox broke" and
#   retry it on a weaker boundary.
#
#   the marker names the rung that actually ran. The bootstrap gate reads it, so a
#   rung exporting somebody else's id means a suite believing it is somewhere it
#   is not.
check_rung_contract() {
	local rung="$1" status=0 out expected
	printf '  --- exit status pass-through ---\n'
	VEYYON_SANDBOX_REPO_ROOT="${REPO_ROOT}" bash "$ENTRYPOINT" --rung="$rung" sh -c 'exit 37' >/dev/null 2>&1 || status=$?
	if [ "$status" = 37 ]; then
		printf '    ok       `exit 37` in the guest arrived as 37 on the host\n'
	else
		printf '    FAIL     `exit 37` in the guest arrived as %s on the host\n' "$status"
		return 1
	fi

	printf '  --- rung marker ---\n'
	expected="$(marker_for "$rung")"
	out="$(VEYYON_SANDBOX_REPO_ROOT="${REPO_ROOT}" bash "$ENTRYPOINT" --rung="$rung" sh -c 'printf %s "$VEYYON_TEST_SANDBOX"' 2>/dev/null | tail -n1)"
	if [ "$out" = "$expected" ]; then
		printf '    ok       the guest exported VEYYON_TEST_SANDBOX=%s\n' "$out"
	else
		printf '    FAIL     the guest exported VEYYON_TEST_SANDBOX=%s, expected %s\n' "${out:-(unset)}" "$expected"
		return 1
	fi
	return 0
}

check_rung() {
	local rung="$1"
	printf '\n=== rung: %s ===\n' "$rung"

	cleanup_targets
	show_host_state "BEFORE"

	printf '  --- running the hostile script inside the sandbox ---\n'
	if ! VEYYON_SANDBOX_REPO_ROOT="${REPO_ROOT}" bash "$ENTRYPOINT" --rung="$rung" sh -c "$HOSTILE" 2>&1 | sed 's/^/  /'; then
		printf '  rung %s could not run; skipping\n' "$rung"
		return 0
	fi

	show_host_state "AFTER"

	local leaked=0 t
	for t in "${TARGETS[@]}"; do
		[ -e "$t" ] && leaked=1
	done
	if [ "$rung" = remote ]; then
		check_remote_home || leaked=1
	fi

	local broken=0
	check_rung_contract "$rung" || broken=1

	if [ "$leaked" = 0 ] && [ "$broken" = 0 ]; then
		printf '  RESULT: PASS - nothing reached the host and the rung honours its contract\n'
		pass=$((pass + 1))
	else
		[ "$leaked" = 1 ] && printf '  RESULT: FAIL - the sandbox leaked to the host\n'
		[ "$broken" = 1 ] && printf '  RESULT: FAIL - the rung broke its exit-status or marker contract\n'
		fail=$((fail + 1))
		cleanup_targets
		if [ "$rung" = remote ]; then cleanup_remote_targets; fi
	fi
}

printf 'host home under test: %s\n' "$HOST_HOME"

if [ $# -gt 0 ]; then
	for r in "$@"; do check_rung "$r"; done
else
	for r in remote microvm docker; do
		VEYYON_SANDBOX_REPO_ROOT="${REPO_ROOT}" bash "$ENTRYPOINT" --rung="$r" true >/dev/null 2>&1 || {
			printf '\n=== rung: %s ===\n  not available on this host; skipped\n' "$r"
			continue
		}
		check_rung "$r"
	done
fi

# --- the other half of the proof -------------------------------------------
# The same hostile intent, run OUTSIDE the sandbox, must be refused rather than
# allowed to write. This exercises the test bootstrap's gate, which is what stops
# somebody typing `bun test` out of habit.
printf '\n=== outside the sandbox: the run must be REFUSED ===\n'
cleanup_targets
outside_status=0
outside_out="$(cd "${REPO_ROOT}" && bun test packages/utils/test/abortable.test.ts 2>&1)" || outside_status=$?
if [ "$outside_status" = 0 ]; then
	printf '  RESULT: FAIL - a bare `bun test` on the host was ALLOWED to run\n'
	fail=$((fail + 1))
elif printf '%s' "$outside_out" | grep -qi 'REFUSED'; then
	printf '  RESULT: PASS - refused, exit %s\n' "$outside_status"
	printf '%s\n' "$outside_out" | grep -i -m3 -A2 'REFUSED' | sed 's/^/    /'
	pass=$((pass + 1))
else
	printf '  RESULT: FAIL - exited %s but not with a refusal:\n' "$outside_status"
	printf '%s\n' "$outside_out" | tail -n 5 | sed 's/^/    /'
	fail=$((fail + 1))
fi

printf '\n=== summary: %s passed, %s failed ===\n' "$pass" "$fail"
[ "$fail" = 0 ]
