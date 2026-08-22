#!/usr/bin/env bash
# Record one scene under swayfx, in a real terminal, with a real pointer.
#
#   proof/docker/record-wl.sh proof/scenes/<name>.sh
#
# record-x11.sh's twin. Same repo mount, same tmpfs HOME seeded from
# proof/docker/home-seed, same out directory; the differences are the image (the
# glass stack lives in :5), the render node, and that the session runs
# unprivileged inside the container.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The tag carries the bun the image was built with; proof/docker/recorder-image.sh
# owns it, and a bump makes a stale image a missing one.
# shellcheck source=proof/docker/recorder-image.sh
source "${REPO_ROOT}/proof/docker/recorder-image.sh"
SCENE="${1:?usage: record-wl.sh <scene.sh>}"
OUT="${OUT_DIR:-${REPO_ROOT}/proof/captures/wl}"
mkdir -p "${OUT}"

# A model served by this host answers on loopback here and on the gateway alias in
# there. proof/docker/host-endpoint.sh owns the substitution.
# shellcheck source=proof/docker/host-endpoint.sh
source "${REPO_ROOT}/proof/docker/host-endpoint.sh"
CONTAINER_LLM_BASE_URL="$(container_endpoint "${PROOF_LLM_BASE_URL:-}")"

# wlroots will not start its gles2 renderer without a DRM render node, and the
# blur shader is the whole reason this path exists, so a missing node is a hard
# stop rather than a silent fall back to a software renderer that cannot blur.
RENDER_NODE="${RENDER_NODE:-/dev/dri/renderD128}"
[ -e "${RENDER_NODE}" ] || {
	echo "no DRM render node at ${RENDER_NODE}: swayfx cannot start a gles2 renderer, and the software renderer cannot blur" >&2
	exit 1
}
RENDER_GID="$(stat -c %g "${RENDER_NODE}")"

docker run --rm \
	--network "${PROOF_NETWORK:-veyyon-proof}" \
	--add-host "${CONTAINER_HOST_ALIAS}:host-gateway" \
	--device "${RENDER_NODE}" \
	--group-add "${RENDER_GID}" \
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
	-e "PROOF_LLM_BASE_URL=${CONTAINER_LLM_BASE_URL}" \
	-e "VEYYON_DEMO_SECRET=${VEYYON_DEMO_SECRET:-veyyon-demo-value-not-a-real-credential}" \
	-e "SCENE_HIDE_THINKING=${SCENE_HIDE_THINKING:-}" \
	-e "SCENE_RENDER_NODE=${RENDER_NODE}" \
	-e "SCENE_RENDER_GID=${RENDER_GID}" \
	-e "SCENE_COMMAND=${SCENE_COMMAND:-bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b}" \
	-e "SCENE_WIDTH=${SCENE_WIDTH:-2560}" \
	-e "SCENE_HEIGHT=${SCENE_HEIGHT:-1440}" \
	-e "SCENE_FONT_SIZE=${SCENE_FONT_SIZE:-21}" \
	-e "SCENE_FPS=${SCENE_FPS:-30}" \
	-e "SCENE_THEME=${SCENE_THEME:-plain}" \
	-e "SCENE_MARGIN" \
	-e "SCENE_RADIUS" \
	-e "SCENE_OPACITY" \
	-e "SCENE_PADDING" \
	-e "SCENE_BLUR_PASSES" \
	-e "SCENE_BLUR_RADIUS" \
	-e "SCENE_BLUR_NOISE" \
	-e "SCENE_BLUR_BRIGHTNESS" \
	-e "SCENE_SHADOW_BLUR" \
	-e "SCENE_SHADOW_COLOR" \
	-e "SCENE_BACKDROP_BLUR" \
	-e "SCENE_BACKDROP_BASE" \
	-e "SCENE_BACKDROP_WARM" \
	-e "SCENE_BACKDROP_COOL" \
	-e "SCENE_BG=${SCENE_BG:-#1e2127}" \
	-e "SCENE_FG=${SCENE_FG:-#d7dae0}" \
	-e "SCENE_CWD=${SCENE_CWD:-/sandbox/home/demo}" \
	-e "SCENE_SETTLE_SCALE=${SCENE_SETTLE_SCALE:-1}" \
	-e "SCENE_SETTINGS=${SCENE_SETTINGS:-}" \
	-e "SCENE_SIGNING_NUMBER=${SCENE_SIGNING_NUMBER:-}" \
	-w /repo \
	"${RECORDER_IMAGE}" \
	bash -lc '
		set -e
		mkdir -p /sandbox/home/.veyyon
		cp -r /seed/. /sandbox/home/.veyyon/
		if [ -n "${PROOF_LLM_BASE_URL}" ]; then
			sed -i "s|baseUrl: .*|baseUrl: ${PROOF_LLM_BASE_URL}|" /sandbox/home/.veyyon/profiles/default/agent/models.yml
		fi
		if [ -n "${SCENE_HIDE_THINKING}" ]; then
			printf "hideThinkingBlock: true\n" >> /sandbox/home/.veyyon/profiles/default/agent/config.yml
		fi
		if [ -n "${SCENE_SETTINGS}" ]; then
			printf '"'"'%s\n'"'"' "${SCENE_SETTINGS}" \
				>> /sandbox/home/.veyyon/profiles/default/agent/config.yml
		fi
		bash /repo/proof/docker/seed-demo.sh /sandbox/home/demo
		exec /repo/proof/docker/wlsession.sh "/repo/'"${SCENE}"'"
	'
