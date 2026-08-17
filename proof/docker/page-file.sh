#!/usr/bin/env bash
# Walk a file past the camera, a screenful at a time.
#
#   page-file.sh <file> [rows] [seconds-per-page]
#
# `less` would need keystrokes and a scene to send them; this needs neither, so
# the same hold scene that records a test run records a diff. ANSI colour in the
# file is passed through untouched, which is why the caller writes the diff with
# --color=always.
set -uo pipefail

FILE="${1:?usage: page-file.sh <file> [rows] [secs]}"
ROWS="${2:-$(($(tput lines 2>/dev/null || echo 30) - 2))}"
SECS="${3:-2.5}"

n=0
while IFS= read -r line; do
	printf '%s\n' "${line}"
	n=$((n + 1))
	if ((n % ROWS == 0)); then
		sleep "${SECS}"
		printf '\033[2J\033[H'
	fi
done <"${FILE}"
sleep "${SECS}"
