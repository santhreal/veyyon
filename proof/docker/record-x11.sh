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

# The look belongs to xsession.sh, which is the file that draws it, so the backdrop
# colours, opacity, radius, blur kernel and inset are forwarded only when a caller sets
# one. A default repeated here silently wins over the chrome's own, which is how a
# violet-and-cyan backdrop survived being rewritten as a neutral one: the launcher kept
# passing the old colours in, and every take came out in the scheme the file no longer
# contained.
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
	-e "VEYYON_DEMO_SECRET=${VEYYON_DEMO_SECRET:-veyyon-demo-value-not-a-real-credential}" \
	-e "SCENE_HIDE_THINKING=${SCENE_HIDE_THINKING:-}" \
	-e DISPLAY=:99 \
	-e "SCENE_COMMAND=${SCENE_COMMAND:-bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b}" \
	-e "SCENE_WIDTH=${SCENE_WIDTH:-1600}" \
	-e "SCENE_HEIGHT=${SCENE_HEIGHT:-1000}" \
	-e "SCENE_FONT_SIZE=${SCENE_FONT_SIZE:-15}" \
	-e "SCENE_FPS=${SCENE_FPS:-30}" \
	-e "SCENE_TERMINAL=${SCENE_TERMINAL:-kitty}" \
	-e "SCENE_THEME=${SCENE_THEME:-plain}" \
	-e "SCENE_MARGIN" \
	-e "SCENE_RADIUS" \
	-e "SCENE_OPACITY" \
	-e "SCENE_BLUR_KERN" \
	-e "SCENE_BACKDROP_BASE" \
	-e "SCENE_BACKDROP_WARM" \
	-e "SCENE_BACKDROP_COOL" \
	-e "SCENE_BG=${SCENE_BG:-#1e2127}" \
	-e "SCENE_FG=${SCENE_FG:-#d7dae0}" \
	-e "SCENE_CWD=${SCENE_CWD:-/sandbox/home/demo}" \
	-e "SCENE_SETTLE_SCALE=${SCENE_SETTLE_SCALE:-1}" \
	-e "SCENE_GIF=${SCENE_GIF:-1}" \
	-e "SCENE_SETTINGS=${SCENE_SETTINGS:-}" \
	-w /repo \
	"${RECORDER_IMAGE:-veyyon-proof-recorder:4}" \
	bash -lc '
		set -e
		mkdir -p /sandbox/home/.veyyon
		cp -r /seed/. /sandbox/home/.veyyon/
		# A recorder on another machine cannot resolve the llama.cpp container by the
		# name it has on this daemon, so the base URL is overridable at record time.
		if [ -n "${PROOF_LLM_BASE_URL}" ]; then
			sed -i "s|baseUrl: .*|baseUrl: ${PROOF_LLM_BASE_URL}|" /sandbox/home/.veyyon/profiles/default/agent/models.yml
		fi
		# A feature row is about the block, the card or the diff, and this model
		# reasons in pages: a clip of a plan scene with thinking shown is streamed
		# reasoning with the plan card in two frames of it. `Hide Thinking Blocks` is
		# a setting the product ships, so every scene records with it on, the hero
		# included -- the hero ran once with thinking shown and three quarters of the
		# clip was rumination.
		if [ -n "${SCENE_HIDE_THINKING}" ]; then
			printf "hideThinkingBlock: true\n" >> /sandbox/home/.veyyon/profiles/default/agent/config.yml
		fi
		# Settings one row needs and the others must not inherit, as the YAML lines the
		# recipe wants appended. Two rows need different ones -- the compaction row
		# needs a session that actually compacts, and the language-server row needs the
		# server enabled at all -- so this is a passthrough rather than a boolean per
		# setting. Every line here names a setting the product ships and an operator can
		# set; nothing about a row is faked by it.
		if [ -n "${SCENE_SETTINGS}" ]; then
			printf '"'"'%s\n'"'"' "${SCENE_SETTINGS}" \
				>> /sandbox/home/.veyyon/profiles/default/agent/config.yml
		fi
		bash /repo/proof/docker/seed-demo.sh /sandbox/home/demo
		exec /repo/proof/docker/xsession.sh "/repo/'"${SCENE}"'"
	'
