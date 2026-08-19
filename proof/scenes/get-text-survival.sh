#!/usr/bin/env bash
# WHY THIS EXISTS. The idle wait polls the terminal's text through kitty's control socket,
# and a gate run died in the middle of that polling: the window vanished, the socket file
# with it, and every later wait in the scene degraded to a blind sleep. Nothing else was
# happening at the time -- the probe that was running only read text.
#
# Two questions, in order, because the first answer changes what the second one means:
#
#   1. Does `get-text` return the screen at all, and under which flags? A full-screen TUI
#      draws on the alternate screen, and a reader that asks for the wrong extent gets an
#      empty string back with no error -- which a wait cannot tell apart from a screen that
#      has not changed. The first version of this probe read an empty shell and concluded
#      the instrument was broken, which is the same mistake.
#   2. Does repeated reading end the process being read? It reads once a second for a
#      minute and reports the first read that answered nothing, whether kitty is still
#      running, and whether the socket is still there.
set -uo pipefail

: >"${SCENE_OUT}/get-text-survival.txt"
out() { printf '%s\n' "$*" >>"${SCENE_OUT}/get-text-survival.txt"; }

# Something on screen to read. Typed, not submitted: no command runs, so nothing here
# depends on what the scene's shell would print.
t "MARKER-ALPHA-ON-SCREEN"
sleep 2

for flags in "" "--extent screen" "--extent all" "--extent last_cmd_output"; do
	# shellcheck disable=SC2086
	text="$(kitty @ --to "${KITTY_SOCKET}" get-text ${flags} 2>>"${SCENE_OUT}/get-text-survival.err" || true)"
	case "${text}" in
	*MARKER-ALPHA-ON-SCREEN*) verdict="carries the marker" ;;
	"") verdict="EMPTY" ;;
	*) verdict="text without the marker" ;;
	esac
	out "flags '${flags}': $(printf '%s' "${text}" | wc -c) bytes, ${verdict}"
done

READS=60
ok=0
first_fail=0
for i in $(seq 1 "${READS}"); do
	text="$(kitty @ --to "${KITTY_SOCKET}" get-text 2>>"${SCENE_OUT}/get-text-survival.err" || true)"
	if [ -n "${text}" ]; then
		ok=$((ok + 1))
	elif [ "${first_fail}" -eq 0 ]; then
		first_fail="${i}"
		out "first read that answered nothing: ${i}"
		out "kitty processes at that moment: $(pgrep -c kitty || echo 0)"
		out "socket present: $([ -S /tmp/kitty.sock ] && echo yes || echo no)"
	fi
	sleep 1
done

out "reads that answered: ${ok} of ${READS}"
out "kitty processes now: $(pgrep -c kitty || echo 0)"
out "socket present now: $([ -S /tmp/kitty.sock ] && echo yes || echo no)"
if [ "${ok}" -eq "${READS}" ]; then
	out "get-text survival: ok"
else
	out "get-text survival: FAIL after ${first_fail} reads"
fi
cat "${SCENE_OUT}/get-text-survival.txt"
