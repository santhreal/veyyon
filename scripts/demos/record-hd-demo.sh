#!/usr/bin/env bash
# Record a landing-page demo: a real 1920x1080 session in a composited terminal,
# driving a real model that calls real tools.
#
#   PROOF_LLM_BASE_URL=http://<host>:11434/v1 bash scripts/demos/record-hd-demo.sh
#   PROOF_LLM_BASE_URL=http://<host>:11434/v1 bash scripts/demos/record-hd-demo.sh settings-pointer
#
# The argument is a scene under proof/scenes/ and it selects the whole recipe for
# that row, because two kinds of scene need two different cuts. A session scene is
# cut by change magnitude: it runs for minutes and its interesting moments are
# blocks landing. A gesture scene is cut as one span, because a pointer crossing a
# sidebar is too small a change for any threshold to separate from noise.
#
# Requires docker, the recorder image (proof/docker/Dockerfile.recorder), and an
# OpenAI-compatible server that honours the model name in a request. Ollama does;
# the small llama.cpp proof server does not, which is why the base URL is an
# argument rather than a default.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

: "${PROOF_LLM_BASE_URL:?set PROOF_LLM_BASE_URL to an OpenAI-compatible endpoint}"
DEMO_MODEL="${DEMO_MODEL:-local/demo-qwen3-30b}"
SCENE="${1:-demo-hd}"

case "${SCENE}" in
demo-hd)
	ASSET=assets/demo-hd.webp
	# The hero also ships whole. The take runs about seven minutes and the page
	# gets a 24-second clip out of it -- a demo whose majority is a screen waiting
	# on a model reads as a broken product -- so both are published and the short
	# one can be checked against the long one.
	PUBLISH_TAKE=1
	CUT_ARGS=()
	;;
settings-pointer)
	ASSET=assets/demo-settings-hd.webp
	PUBLISH_TAKE=0
	CUT_ARGS=(--single --scene-score 0.004 --speed 1.4)
	;;
*)
	echo "record-hd-demo.sh: no recipe for scene '${SCENE}'" >&2
	exit 2
	;;
esac

WORK="$(mktemp -d /tmp/veyyon-hd-demo.XXXXXX)"
trap 'rm -rf "${WORK}"' EXIT

PROOF_LLM_BASE_URL="${PROOF_LLM_BASE_URL}" \
	SCENE_COMMAND="bun /repo/packages/coding-agent/src/cli.ts --model ${DEMO_MODEL}" \
	SCENE_THEME=night \
	SCENE_WIDTH=1920 \
	SCENE_HEIGHT=1080 \
	SCENE_FONT_SIZE=16 \
	SCENE_BG="#1a1b26" \
	SCENE_FG="#c0caf5" \
	OUT_DIR="${WORK}" \
	bash "proof/docker/record-x11.sh" "proof/scenes/${SCENE}.sh"

mkdir -p assets proof/captures/x11

if [[ ${PUBLISH_TAKE} -eq 1 ]]; then
	# 1920x1080 at crf 20 is 71 MB for seven minutes, which is not a file to put in
	# a git history; 1280 at crf 30 is the same seven minutes at a size the page
	# can serve.
	ffmpeg -loglevel error -y -i "${WORK}/${SCENE}.mp4" \
		-vf "scale=1280:-2:flags=lanczos" \
		-c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -an \
		"proof/captures/x11/${SCENE}.mp4"
	for still in "${WORK}/${SCENE}"-*.png; do
		cp "${still}" "proof/captures/x11/$(basename "${still}")"
	done
fi

# The published clip shows the moments the screen actually changed, derived from
# the take rather than typed in. `tighten.py` is the wrong instrument for this one:
# the spinner and the elapsed clock make almost every frame "distinct", so the
# windows come from scene magnitude instead.
python3 proof/hero-cut.py "${WORK}/${SCENE}.mp4" \
	--mp4 "${WORK}/${SCENE}-cut.mp4" --webp "${ASSET}" "${CUT_ARGS[@]}"

if [[ "${SCENE}" == "demo-hd" ]]; then
	# The website band carries the hero and nothing else.
	cp assets/demo-hd.webp website/demo-hd.webp
fi

python3 proof/tighten.py audit --base proof/captures
ls -la "${ASSET}"
