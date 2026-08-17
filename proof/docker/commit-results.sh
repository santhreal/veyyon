#!/usr/bin/env bash
# The numbers behind the videos, in text, headless.
#
#   proof/docker/commit-results.sh [hash ...]
#
# Runs each manifest row's command against both trees with no X display and no
# camera, and writes the command's own output to
# proof/captures/x11/commits/<hash>-<arm>.txt. The page quotes these files, so a
# caption can say "18 pass, 12 fail on the parent" without anyone reading it off
# a video frame.
#
# It is also an independent check on the recordings: same trees, same commands,
# no recorder in the path. A disagreement between a video and its .txt means one
# of the two lied, which is worth knowing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST="${REPO_ROOT}/proof/commit-videos.tsv"
OUT="${REPO_ROOT}/proof/captures/x11/commits"
TREES="${COMMIT_PROOF_TREES:-/media/mukund-thiru/SanthData/Santh/worktrees/.commit-proof}"
PARALLEL="${PARALLEL:-10}"
mkdir -p "${OUT}" "${TREES}"

if [[ "${1:-}" == "--one" ]]; then
	shift
	HASH="$1" KIND="$2" PAYLOAD="$3" ARM="$4"
	[[ "${KIND}" == "diff" ]] && exit 0
	case "${ARM}" in
	before) REF="${HASH}^" ;;
	after) REF="${HASH}" ;;
	esac
	TREE="${TREES}/${HASH}-${ARM}-txt"
	rm -rf "${TREE}"
	mkdir -p "${TREE}"
	git -C "${REPO_ROOT}" archive "${REF}" | tar -x -C "${TREE}" --exclude='proof/captures/*' -f -
	# The before arm points the commit's OWN tests at the parent's shipped source,
	# so every non-shipped file it touched comes from the commit itself. Keep this
	# list identical to record-commit-arm.sh: a video and its tally that overlay
	# different files are measuring different trees.
	if [[ "${ARM}" == "before" ]]; then
		while IFS= read -r f; do
			[[ -z "${f}" ]] && continue
			case "${f}" in
			*.test.ts | packages/simulations/src/*.ts | packages/simulations/src/*/*.ts | scripts/demos/*.ts | proof/scenes/*.sh) ;;
			*) continue ;;
			esac
			mkdir -p "${TREE}/$(dirname "${f}")"
			git -C "${REPO_ROOT}" show "${HASH}:${f}" >"${TREE}/${f}" 2>/dev/null || true
		done < <(git -C "${REPO_ROOT}" show --pretty= --name-only "${HASH}")
	fi
	case "${KIND}" in
	test) CMD="timeout 300 bun test ${PAYLOAD}" ;;
	driver) CMD="timeout 120 bun ${PAYLOAD} | head -50" ;;
	esac
	docker run --rm \
		--mount "type=bind,src=${TREE},dst=/repo" \
		--mount "type=bind,src=${REPO_ROOT}/node_modules,dst=/repo/node_modules,readonly" \
		--mount "type=bind,src=${REPO_ROOT}/packages/natives/native/veyyon_natives.linux-x64-modern.node,dst=/repo/packages/natives/native/veyyon_natives.linux-x64-modern.node,readonly" \
		--mount "type=bind,src=${REPO_ROOT}/packages/natives/native/veyyon_natives.linux-x64-baseline.node,dst=/repo/packages/natives/native/veyyon_natives.linux-x64-baseline.node,readonly" \
		--mount "type=bind,src=${REPO_ROOT}/packages/coding-agent/src/export/html/tool-views.generated.js,dst=/repo/packages/coding-agent/src/export/html/tool-views.generated.js,readonly" \
		--tmpfs /sandbox/home:exec,size=512m \
		--tmpfs /tmp:exec,size=1g \
		-e HOME=/sandbox/home \
		-e TERM=dumb \
		-e VEYYON_TEST_SANDBOX=docker-recorder \
		-e VEYYON_TEST_HOST_HOME=/home/mukund-thiru \
		-w /repo \
		"${RECORDER_IMAGE:-veyyon-proof-recorder:2}" \
		bash -lc "cd /repo && ${CMD} 2>&1 | tail -40" >"${OUT}/${HASH}-${ARM}.txt" 2>&1 || true
	rm -rf "${TREE}"
	echo "measured ${HASH}-${ARM}"
	exit 0
fi

WANT=("$@")
grep -v '^#' "${MANIFEST}" |
	awk -F'\t' 'NF>=4 && $2!="diff" {print $1"\t"$2"\t"$4}' |
	{
		if ((${#WANT[@]})); then
			pattern="$(
				IFS='|'
				echo "^(${WANT[*]})	"
			)"
			grep -E "${pattern}"
		else cat; fi
	} |
	while IFS=$'\t' read -r h k p; do
		printf '%s\t%s\t%s\tbefore\n%s\t%s\t%s\tafter\n' "${h}" "${k}" "${p}" "${h}" "${k}" "${p}"
	done |
	xargs -P "${PARALLEL}" -d '\n' -I{} bash -c 'IFS="	" read -r h k p a <<<"{}"; "$0" --one "$h" "$k" "$p" "$a" || echo "FAILED $h-$a" >&2' "$0"

echo "results in ${OUT}"
