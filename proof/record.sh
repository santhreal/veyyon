#!/usr/bin/env bash
# Unified PR Visual Evidence Recorder
# Captures Before/After stills and video clips for pull requests.
#
# Usage:
#   proof/record.sh <scene>                  # Record After arm (proof/captures/x11/)
#   proof/record.sh --before <scene>         # Record Before arm (proof/captures/x11/before/)
#   proof/record.sh --still <name> <scene>   # Take a single still frame
#   proof/record.sh --pair <scene>           # Record both Before & After pair
#   proof/record.sh --settings 'k: v' <scene># Record with non-default setting (Off vs On)
#   proof/record.sh --width 960 <scene>      # Record at specific terminal width
#
# Artifact rules:
#   - Static UI change:   two PNG frames, before and after (--still or static scene)
#   - Animation / timing: two animated clips (WebP/MP4), before and after
#   - Settings change:    two PNG frames, off and on (--settings)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

MODE="after"
BEFORE_ARM=0
STILL_NAME=""
PAIR_MODE=0
SETTINGS=""
WIDTH=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		--before)
			BEFORE_ARM=1
			shift
			;;
		--still)
			STILL_NAME="${2:?missing still name}"
			shift 2
			;;
		--pair)
			PAIR_MODE=1
			shift
			;;
		--settings)
			SETTINGS="${2:?missing settings value}"
			shift 2
			;;
		--width)
			WIDTH="${2:?missing width}"
			shift 2
			;;
		-h|--help)
			echo "Usage: proof/record.sh [--before|--pair] [--still <name>] [--settings '<k>: <v>'] [--width <px>] <scene.sh>"
			exit 0
			;;
		*)
			SCENE_ARG="$1"
			shift
			;;
	esac
done

if [[ -z "${SCENE_ARG:-}" ]]; then
	echo "proof/record.sh: missing scene argument (e.g. proof/scenes/agents-cockpit.sh)" >&2
	exit 1
fi

# Resolve scene path
if [[ -f "${SCENE_ARG}" ]]; then
	SCENE_PATH="${SCENE_ARG}"
elif [[ -f "proof/scenes/${SCENE_ARG}" ]]; then
	SCENE_PATH="proof/scenes/${SCENE_ARG}"
elif [[ -f "proof/scenes/${SCENE_ARG}.sh" ]]; then
	SCENE_PATH="proof/scenes/${SCENE_ARG}.sh"
else
	echo "proof/record.sh: scene '${SCENE_ARG}' not found in proof/scenes/" >&2
	exit 1
fi

run_arm() {
	local arm="$1"
	local out_dir="$2"
	mkdir -p "${out_dir}"

	local env_args=()
	if [[ -n "${SETTINGS}" ]]; then
		env_args+=(SCENE_SETTINGS="${SETTINGS}")
	fi
	if [[ -n "${WIDTH}" ]]; then
		env_args+=(SCENE_WIDTH="${WIDTH}")
	fi
	if [[ -n "${STILL_NAME}" ]]; then
		env_args+=(SCENE_STILL="${STILL_NAME}")
	fi

	echo "=== Recording ${arm} arm -> ${out_dir} ==="
	if [[ "${arm}" == "before" ]]; then
		OUT_DIR="${out_dir}" "${env_args[@]}" bash proof/docker/record-x11-before.sh "${SCENE_PATH}"
	else
		OUT_DIR="${out_dir}" "${env_args[@]}" bash proof/docker/record-x11.sh "${SCENE_PATH}"
	fi
}

if [[ ${PAIR_MODE} -eq 1 ]]; then
	run_arm "before" "${REPO_ROOT}/proof/captures/x11/before"
	run_arm "after" "${REPO_ROOT}/proof/captures/x11"
	echo "=== Labeled Before/After Pair Generated ==="
	echo "Before: proof/captures/x11/before/"
	echo "After:  proof/captures/x11/"
elif [[ ${BEFORE_ARM} -eq 1 ]]; then
	run_arm "before" "${REPO_ROOT}/proof/captures/x11/before"
else
	OUT="${OUT_DIR:-${REPO_ROOT}/proof/captures/x11}"
	run_arm "after" "${OUT}"
fi
