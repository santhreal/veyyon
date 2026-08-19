#!/usr/bin/env bash
# WHY THIS EXISTS. The idle wait decides a turn is over when two readings of the terminal
# text match. That is only a signal if an idle veyyon screen actually reads the same twice,
# and there are several reasons it might not: a spinner frame, a caret, a gauge, a clock.
# The first take driven by that wait spent every turn's full ceiling and settled nothing,
# which is exactly what a screen that never repeats would produce -- and it costs twenty
# minutes to find that out from a take.
#
# So this measures it directly on an idle app: ten readings three seconds apart, how many
# matched the one before, and the first difference printed as unified diff context. It runs
# against a real veyyon session with no turn in flight, which is the state every shot in a
# scene is taken in.
set -uo pipefail

: >"${SCENE_OUT}/idle-stability.txt"
out() { printf '%s\n' "$*" >>"${SCENE_OUT}/idle-stability.txt"; }

settle 12

prev=""
matches=0
compares=0
for i in $(seq 1 10); do
	now="$(kitty @ --to "${KITTY_SOCKET}" get-text 2>/dev/null | tr -d '0-9' || true)"
	if [ -n "${prev}" ]; then
		compares=$((compares + 1))
		if [ "${now}" = "${prev}" ]; then
			matches=$((matches + 1))
		elif [ ! -f "${SCENE_OUT}/idle-first-diff.txt" ]; then
			printf '%s' "${prev}" >"${SCENE_OUT}/idle-prev.txt"
			printf '%s' "${now}" >"${SCENE_OUT}/idle-now.txt"
			diff -u "${SCENE_OUT}/idle-prev.txt" "${SCENE_OUT}/idle-now.txt" \
				>"${SCENE_OUT}/idle-first-diff.txt" 2>&1 || true
			out "reading ${i} differed from the one before; diff in idle-first-diff.txt"
		fi
	fi
	prev="${now}"
	sleep 3
done

out "idle readings that matched the previous one: ${matches} of ${compares}"
if [ "${matches}" -eq "${compares}" ]; then
	out "idle stability: ok, an idle screen reads the same every time"
else
	out "idle stability: FAIL, an idle screen keeps changing"
fi
cat "${SCENE_OUT}/idle-stability.txt"
[ -f "${SCENE_OUT}/idle-first-diff.txt" ] && head -40 "${SCENE_OUT}/idle-first-diff.txt"
shot idle-stability
