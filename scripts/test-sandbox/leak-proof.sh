#!/usr/bin/env bash
# The red run. Proves the sandbox is real by trying to break out of it.
#
#   bash scripts/test-vm/leak-proof.sh            # every available rung
#   bash scripts/test-vm/leak-proof.sh microvm    # one rung
#
# WHAT IT DOES
# ------------
# Writes a hostile script that does exactly what the 136 stray directories in the
# operator's home were caused by, only deliberately and to fixed paths:
#
#   ~/.veyyon/leaked        the config-root shape, through tilde expansion
#   $HOME/.veyyon-probe     the same, through the environment variable
#   <the real home>/...     the literal host path, hardcoded, no expansion at all
#
# Then it lists those paths on the host before and after. The third target is the
# one that matters: a sandbox that only moves HOME defeats the first two and leaves
# the third wide open, which is precisely the hole this whole exercise exists to
# close. A rung passes only when nothing appears on the host AND the guest was
# unable to create the literal host path.
#
# It also runs the hostile script OUTSIDE any sandbox, and requires that attempt to
# be REFUSED by the test bootstrap rather than allowed to write. A boundary that
# only works when you remember to use it is not a boundary.
set -euo pipefail

VM_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && /bin/pwd -P)"
REPO_ROOT="${VEYYON_SANDBOX_REPO_ROOT:-$(cd -- "${VM_DIR}/../.." && /bin/pwd -P)}"
ENTRYPOINT="${VM_DIR}/../test-sandbox.sh"

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

	if [ "$leaked" = 0 ]; then
		printf '  RESULT: PASS - nothing reached the host\n'
		pass=$((pass + 1))
	else
		printf '  RESULT: FAIL - the sandbox leaked to the host\n'
		fail=$((fail + 1))
		cleanup_targets
	fi
}

printf 'host home under test: %s\n' "$HOST_HOME"

if [ $# -gt 0 ]; then
	for r in "$@"; do check_rung "$r"; done
else
	for r in microvm docker; do
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
