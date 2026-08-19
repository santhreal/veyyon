#!/usr/bin/env bash
# Record the landing-page demo: a real 1920x1080 session in a composited
# terminal, driving a real model that calls real tools.
#
#   PROOF_LLM_BASE_URL=http://<host>:11434/v1 bash scripts/demos/record-hd-demo.sh
#
# Requires docker, the recorder image (proof/docker/Dockerfile.recorder), and an
# OpenAI-compatible server that honours the model name in a request. Ollama does;
# the small llama.cpp proof server does not, which is why the base URL is an
# argument rather than a default.
#
# The take runs about seven minutes and the landing page gets a 24-second clip cut
# out of it: a demo whose majority is a screen waiting on a model reads as a
# broken product. Both are published, so the short one can be checked against the
# long one.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

: "${PROOF_LLM_BASE_URL:?set PROOF_LLM_BASE_URL to an OpenAI-compatible endpoint}"
DEMO_MODEL="${DEMO_MODEL:-local/demo-qwen3-30b}"
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
	bash proof/docker/record-x11.sh proof/scenes/demo-hd.sh

mkdir -p assets proof/captures/x11

# The page carries the whole take, so a reader can watch the session that the
# landing-page clip was cut out of. 1920x1080 at crf 20 is 71 MB for seven
# minutes, which is not a file to put in a git history; 1280 at crf 30 is the
# same seven minutes at a size the page can serve.
ffmpeg -loglevel error -y -i "${WORK}/demo-hd.mp4" \
	-vf "scale=1280:-2:flags=lanczos" \
	-c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -an \
	proof/captures/x11/demo-hd.mp4
for still in "${WORK}"/demo-hd-*.png; do
	cp "${still}" "proof/captures/x11/$(basename "${still}")"
done

# The landing page shows the moments the screen actually changed, derived from the
# take rather than typed in. `tighten.py` is the wrong instrument for this one:
# the spinner and the elapsed clock make almost every frame "distinct", so the
# windows come from scene magnitude instead.
python3 proof/hero-cut.py "${WORK}/demo-hd.mp4" \
	--mp4 "${WORK}/demo-hd-hero.mp4" --webp assets/demo-hd.webp
cp assets/demo-hd.webp website/demo-hd.webp

python3 proof/tighten.py audit --base proof/captures
ls -la assets/demo-hd.webp proof/captures/x11/demo-hd.mp4
