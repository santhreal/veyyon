#!/usr/bin/env bash
# Record one scene as video, in a real terminal, with a real pointer.
#
#   proof/docker/record-x11.sh proof/scenes/<name>.sh
#
# The container sees the repo at /repo and writes <name>.mp4 and <name>.gif to
# proof/captures/x11. HOME is a tmpfs seeded from proof/docker/home-seed, so the
# machine's own ~/.veyyon is never in the mount table.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCENE="${1:?usage: record-x11.sh <scene.sh>}"
OUT="${OUT_DIR:-${REPO_ROOT}/proof/captures/x11}"
mkdir -p "${OUT}"

docker run --rm \
	--network "${PROOF_NETWORK:-veyyon-proof}" \
	--mount "type=bind,src=${REPO_ROOT},dst=/repo" \
	--mount "type=bind,src=${REPO_ROOT}/proof/docker/home-seed,dst=/seed,readonly" \
	--mount "type=bind,src=${OUT},dst=/out" \
	--tmpfs /sandbox/home:exec,size=1g \
	--tmpfs /tmp:exec,size=2g \
	--shm-size=512m \
	-e HOME=/sandbox/home \
	-e TERM=xterm-kitty \
	-e COLORTERM=truecolor \
	-e LANG=C.UTF-8 \
	-e LC_ALL=C.UTF-8 \
	-e LOCAL_LLM_KEY=none \
	-e "PROOF_LLM_BASE_URL=${PROOF_LLM_BASE_URL:-}" \
	-e DISPLAY=:99 \
	-e "SCENE_COMMAND=${SCENE_COMMAND:-bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b}" \
	-e "SCENE_WIDTH=${SCENE_WIDTH:-1600}" \
	-e "SCENE_HEIGHT=${SCENE_HEIGHT:-1000}" \
	-e "SCENE_FONT_SIZE=${SCENE_FONT_SIZE:-15}" \
	-e "SCENE_FPS=${SCENE_FPS:-30}" \
	-e "SCENE_TERMINAL=${SCENE_TERMINAL:-kitty}" \
	-e "SCENE_CWD=${SCENE_CWD:-/sandbox/home/demo}" \
	-w /repo \
	"${RECORDER_IMAGE:-veyyon-proof-recorder:2}" \
	bash -lc '
		set -e
		mkdir -p /sandbox/home/.veyyon
		cp -r /seed/. /sandbox/home/.veyyon/
		# A recorder on another machine cannot resolve the llama.cpp container by the
		# name it has on this daemon, so the base URL is overridable at record time.
		if [ -n "${PROOF_LLM_BASE_URL}" ]; then
			sed -i "s|baseUrl: .*|baseUrl: ${PROOF_LLM_BASE_URL}|" /sandbox/home/.veyyon/profiles/default/agent/models.yml
		fi
		mkdir -p /sandbox/home/demo/src
		printf "export function parse(s) {\n\tif (!s) throw new Error(\"empty focus string\");\n\treturn s.trim();\n}\n" > /sandbox/home/demo/src/parser.ts
		printf "# demo\n\nA tiny project the recording drives.\n" > /sandbox/home/demo/README.md
		exec /repo/proof/docker/xsession.sh "/repo/'"${SCENE}"'"
	'
