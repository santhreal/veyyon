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
# The tag carries the bun the image was built with; proof/docker/recorder-image.sh
# owns it, and a bump makes a stale image a missing one.
# shellcheck source=proof/docker/recorder-image.sh
source "${REPO_ROOT}/proof/docker/recorder-image.sh"
SCENE="${1:?usage: record-x11.sh <scene.sh>}"
OUT="${OUT_DIR:-${REPO_ROOT}/proof/captures/x11}"
mkdir -p "${OUT}"
OUT="$(cd "${OUT}" && pwd)"

# A model served by this host answers on loopback here and on the gateway alias in
# there. proof/docker/host-endpoint.sh owns the substitution.
# shellcheck source=proof/docker/host-endpoint.sh
source "${REPO_ROOT}/proof/docker/host-endpoint.sh"
CONTAINER_LLM_BASE_URL="$(container_endpoint "${PROOF_LLM_BASE_URL:-}")"

# Every SCENE_* knob has one definition, in scene-config.sh, and this forwards the
# set rather than a hand-maintained copy of it. The copy is what went wrong before:
# a default repeated here silently won over the chrome's own, which is how a
# violet-and-cyan backdrop survived being rewritten as a neutral one -- the launcher
# kept passing the old colours in, and every take came out in the scheme the file no
# longer contained. A knob added to the session and forgotten here was the same
# defect from the other side: the value existed and the container never saw it.
# shellcheck source=proof/docker/scene-config.sh
source "${REPO_ROOT}/proof/docker/scene-config.sh"
scene_docker_env_args
AUTH_MOUNTS=()
if [[ -n "${PROOF_AUTH_DIR:-}" ]]; then
	AUTH_MOUNTS+=(--mount "type=bind,src=${PROOF_AUTH_DIR},dst=/host-auth,readonly")
fi

# Mandate GPU acceleration passthrough so the terminal and compositor run at full
# hardware refresh rate with zero CPU-compositor frame jitter.
GPU_ARGS=()
if [ -d /dev/dri ]; then
	GPU_ARGS+=(--device /dev/dri)
	if [ -e /dev/dri/renderD128 ]; then
		RENDER_GID="$(stat -c %g /dev/dri/renderD128 2>/dev/null || echo 992)"
		GPU_ARGS+=(--group-add "${RENDER_GID}")
	fi
fi

# A checkout made on Windows carries workspace links under node_modules that
# point at the Docker Desktop utility VM's own bind path (/mnt/host/c/...),
# which no container resolves on its own. Setting PROOF_HOST_REPO_TARGET binds
# the checkout there too, read-only, so those links resolve; Linux checkouts
# leave it unset and run exactly as before. PROOF_HOST_REPO_SOURCE names the
# checkout when REPO_ROOT itself is one of those per-container WSL paths, which
# no sibling container can mount.
HOST_WORKSPACE_MOUNT=()
if [ -n "${PROOF_HOST_REPO_TARGET:-}" ]; then
	HOST_WORKSPACE_MOUNT+=(--mount "type=bind,src=${PROOF_HOST_REPO_SOURCE:-${REPO_ROOT}},dst=${PROOF_HOST_REPO_TARGET},readonly")
fi

docker run --rm \
	"${AUTH_MOUNTS[@]}" \
	"${GPU_ARGS[@]}" \
	"${HOST_WORKSPACE_MOUNT[@]}" \
	--network "${PROOF_NETWORK:-veyyon-proof}" \
	--add-host "${CONTAINER_HOST_ALIAS}:host-gateway" \
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
	-e DISPLAY=:99 \
	"${SCENE_DOCKER_ENV[@]}" \
	-e "TYPE_DELAY" \
	-w /repo \
	"${RECORDER_IMAGE}" \
	bash -lc '
		set -e
		mkdir -p /sandbox/home/.veyyon
		cp -r /seed/. /sandbox/home/.veyyon/
		if [ -d /host-auth ]; then
			mkdir -p /sandbox/home/.veyyon/shared-auth /sandbox/home/.veyyon/profiles/default/agent
			cp -a /host-auth/. /sandbox/home/.veyyon/shared-auth/
			cp -a /host-auth/. /sandbox/home/.veyyon/profiles/default/agent/
		fi
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
		# An autoresearch scene photographs a dashboard, which is empty until a
		# session has runs in it. The seeder writes them through the storage API
		# veyyon itself writes with, so the surface under capture reads real rows.
		# NO APOSTROPHES ANYWHERE IN THIS BOOTSTRAP, comments included: the whole
		# block is one single-quoted argument, so one apostrophe ends it and every
		# line after it runs on the host instead of in the container.
		#
		# A 0/1 knob is compared to 0, never tested with -n: every knob now carries a
		# default, so -n was true for the string 0 and seeded every scene in the repo.
		if [ "${SCENE_SEED_AUTORESEARCH}" != 0 ]; then
			git -C /sandbox/home/demo checkout -q -b autoresearch/tokenizer
			bun /repo/proof/docker/seed-autoresearch.ts /sandbox/home/demo autoresearch/tokenizer
		fi
		# An advisor scene photographs a roster editor, which opens on the project
		# WATCHDOG.yml. With no file the overlay lists nothing, so the frame shows an
		# empty pane instead of the surface.
		if [ "${SCENE_SEED_ADVISORS}" != 0 ]; then
			cp /repo/proof/docker/seed-watchdog.yml /sandbox/home/demo/WATCHDOG.yml
		fi
		# A fold scene photographs the anchored board holding stages back, which needs a
		# plan taller than the region and no model to write one. The seeder writes a
		# resumable session through the product own writer; the scene resumes it with
		# --continue.
		if [ "${SCENE_SEED_TODO_BOARD}" != 0 ]; then
			bun /repo/proof/docker/seed-todo-board.ts /sandbox/home/demo
		fi
		# A scene photographing a recovered turn needs a provider that fails on cue,
		# which no weights can be asked to do. The stub runs in this container and
		# every model row points at it, so the turn under capture is the product own
		# request, backoff and recovery against a 503 that is really answered.
		if [ "${SCENE_FLAKY_LLM}" != 0 ]; then
			sed -i "s|baseUrl: .*|baseUrl: http://127.0.0.1:9101/v1|" /sandbox/home/.veyyon/profiles/default/agent/models.yml
			FLAKY_FAILURES="${SCENE_FLAKY_LLM}" bun /repo/proof/docker/stub-flaky-llm.ts 9101 &
			sleep 1
		fi
		# A scene photographing the row that stands in for a picture needs a turn in
		# which a tool returned one, and a 1.5B model asked for that will call
		# something else. The stub calls read once on a real file in the demo
		# project; the product decides the call, runs the tool and draws the result.
		if [ "${SCENE_IMAGE_TURN}" != 0 ]; then
			mkdir -p /sandbox/home/demo/shots
			cp /repo/assets/todo-marathon-idle.png /sandbox/home/demo/shots/board.png
			sed -i "s|baseUrl: .*|baseUrl: http://127.0.0.1:9102/v1|" /sandbox/home/.veyyon/profiles/default/agent/models.yml
			bun /repo/proof/docker/stub-tool-llm.ts 9102 &
			sleep 1
		fi
		exec /repo/proof/docker/xsession.sh "/repo/'"${SCENE}"'"
	'
