#!/usr/bin/env bash
# Record every commit on this branch, both arms, in a real terminal in docker.
#
#   proof/docker/record-all-commits.sh [hash ...]
#
# Reads proof/commit-videos.tsv and records what each row asks for. With no
# arguments it records every row; with hashes it records only those, which is
# how a single failed recording is redone without re-recording seventy-six good
# ones.
#
# PARALLEL (default 6) containers run at once. Each one is its own Xvfb, its own
# kitty and its own extracted source tree, so they cannot see each other; the
# only shared thing is the read-only node_modules mount.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="${REPO_ROOT}/proof/commit-videos.tsv"
COMMITS="${REPO_ROOT}/proof/captures/x11/commits"
PARALLEL="${PARALLEL:-6}"
mkdir -p "${COMMITS}"

# One row: hash, kind, hold ceiling, payload, subject. Called by xargs, so it
# has to be a standalone command and not a function in this shell.
if [[ "${1:-}" == "--one" ]]; then
	shift
	HASH="$1" KIND="$2" HOLD="$3" PAYLOAD="$4"
	case "${KIND}" in
	test)
		# `| tail -32` alone prints NOTHING until the pipeline closes, so a suite
		# that outlives the hold ceiling records a bare cursor for the whole clip
		# -- three arms shipped exactly that (131s, 131s, 171s of an empty
		# terminal). Stream to the screen through `tee` so a long run is visibly
		# working, then clear and leave the last 32 lines standing as the result.
		CMD="{ bun test ${PAYLOAD} 2>&1 | tee /tmp/arm.log; clear; tail -32 /tmp/arm.log; }"
		ARMS="before after"
		;;
	driver)
		# A renderer writes a surface and exits. `head` keeps a tall surface
		# inside the window, and 2>&1 keeps a stack trace on screen instead of
		# in a log nobody opens.
		CMD="bun ${PAYLOAD} 2>&1 | head -44"
		ARMS="before after"
		;;
	diff)
		# The change itself, paged by the command rather than by keys: the diff
		# is written next to the video by this script, in colour, already
		# truncated, so the terminal only has to walk it.
		CMD="bash /rig/docker/page-file.sh /out/${HASH}.diff"
		ARMS="after"
		;;
	*)
		echo "unknown kind ${KIND}" >&2
		exit 2
		;;
	esac

	for arm in ${ARMS}; do
		out="${COMMITS}/${HASH}-${arm}"
		mkdir -p "${out}"
		if [[ "${KIND}" == "diff" ]]; then
			# --stat first so a commit that moved ninety files reads as ninety
			# files, then the text hunks. Binary captures have no hunks and say
			# so, which is the honest thing for a commit that is 92MB of video.
			{
				# awk, never `head`: `head` closes the pipe on line sixty and git dies
				# of SIGPIPE, which under `set -o pipefail` takes this script with it.
				# Four of the five rows that failed the first campaign failed here,
				# and every one of them was a commit whose diff was long enough to
				# reach the limit.
				git -C "${REPO_ROOT}" show --color=always --stat --format='%C(yellow)%h%C(reset) %s%n%n' "${HASH}" | awk 'NR<=60'
				echo
				git -C "${REPO_ROOT}" show --color=always --format='' --unified=3 "${HASH}" | awk 'NR<=400'
			} >"${out}/${HASH}.diff"
		fi
		"${REPO_ROOT}/proof/docker/record-commit-arm.sh" "${HASH}" "${arm}" "${HOLD}" "${CMD}"
	done
	exit 0
fi

WANT=("$@")
grep -v '^#' "${MANIFEST}" |
	awk -F'\t' 'NF>=4 {print $1"\t"$2"\t"$3"\t"$4}' |
	{
		if ((${#WANT[@]})); then
			pattern="$(
				IFS='|'
				echo "^(${WANT[*]})	"
			)"
			grep -E "${pattern}"
		else
			cat
		fi
	} |
	while IFS=$'\t' read -r h k hold payload; do
		printf '%s\t%s\t%s\t%s\n' "${h}" "${k}" "${hold}" "${payload}"
	done |
	xargs -P "${PARALLEL}" -d '\n' -I{} bash -c 'IFS="	" read -r h k hold p <<<"{}"; "$0" --one "$h" "$k" "$hold" "$p" || echo "FAILED $h" >&2' "$0"

echo "done; videos in ${COMMITS}"
