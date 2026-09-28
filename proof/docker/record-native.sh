#!/usr/bin/env bash
# Record one desktop scene: the GPUI window, not a terminal.
#
#   proof/docker/record-native.sh proof/scenes/<name>.sh [<scene.sh>...]
#   proof/record.sh --pair proof/scenes/<name>.sh     # a scene headed `# scene-terminal: native`
#
# The desktop scenes drive an application window rather than a terminal grid, so
# the session needs SCENE_TERMINAL=native, the executable bind-mounted into the
# container, and a Vulkan ICD for it to open a device against. Those are
# environment variables whose values are not a caller's choice, and each of the
# three private drivers that carried them named a different absolute path on a
# different machine, so a capture worked for whoever wrote the driver and for
# nobody else. They live here, once, beside the recorder they configure.
#
# The executable comes from DESKTOP_BINARY, or from this workspace's own cargo
# target directory, and a missing one fails closed with the command that builds
# it: a recorder that starts without it maps no window and records an empty
# screen with the binary named nowhere in the capture.
#
# THE SESSION COMMAND. The window starts through proof/scenes/desktop-lib.sh, which
# seeds the desktop bench corpus into the take's home, serves the bench's scripted
# model on loopback inside the container, and opens the driver socket path the
# scene then talks to. The scene's own header lines select the model's pacing and
# any profile setting it needs, so both arms of a pair start from one state.
#
# WHICH ARM. SCENE_ARM=before delegates to record-x11-before.sh, which needs the
# before-state executable in PROOF_NATIVE_BEFORE_BINARY (a build of the base ref;
# holding source files back cannot rebuild a compiled binary) and refuses when it
# is byte-identical to the after one.
#
# WHAT THE BEFORE ARM HOLDS. The source hold also holds the TypeScript back,
# which is right for a change the host takes part in and wrong for one that is
# entirely inside the executable: a branch that brings its own GUI host has no
# host in the base tree, so the held arm records a window that attached to
# nothing. PROOF_BASE_REF=HEAD holds every source file at this tree and leaves
# the executable as the whole differential:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=<base-build> \
#     proof/docker/record-native.sh proof/scenes/<name>.sh
#
# A change the window takes no part in inverts that: the differential is in the
# host the window talks to, there is no second build, and the arm names the
# commit before the host changed. The executable is then shared and
# PROOF_NATIVE_BEFORE_BINARY is left unset:
#
#   SCENE_ARM=before PROOF_BASE_REF=<fix>^ \
#     proof/docker/record-native.sh proof/scenes/<name>.sh
#
# A BASE BUILD FROM ANOTHER DAY. A base build speaks the host protocol of the
# revision it was built from, and the host this checkout ships closes the socket on
# it: the window then records a reconnect banner over an empty queue. A window
# built while the token crate still existed also loads its design tokens and
# themes from VEYYON_DESKTOP_TOKENS_DIR and VEYYON_DESKTOP_THEMES_DIR at start.
# Name the revision the before build came from in PROOF_NATIVE_BEFORE_REF and the
# before arm runs that revision's GUI host (packages/coding-agent, extracted beside
# the captures; every other workspace member resolves from this checkout's
# node_modules) and reads that revision's token and theme directories, extracted
# the way the desktop bench extracts them (scripts/desktop-bench/apps.py). The
# working tree is not touched, so PROOF_BASE_REF=HEAD still holds nothing:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD PROOF_NATIVE_BEFORE_REF=<rev> \
#     PROOF_NATIVE_BEFORE_BINARY=<build-of-rev> \
#     proof/docker/record-native.sh proof/scenes/<name>.sh
#
# CLIPS. A span the scene marks with desk_clip_begin/desk_clip_end is published
# beside the take as <name>-<clip>.webp at the capture rate and gated with
# proof/webp-cadence.py --expect-ms 33; a clip that fails the gate fails the take.
# The whole-take motion gate is off here: a desktop take waits on idle windows by
# design, and its average rate of change says nothing about a clip inside it.
#
# THE GPU IS OPTIONAL. lavapipe renders in software, so a take needs no
# passthrough and every host draws the same frame. Pass PROOF_GPU_DEVICE and
# VK_ICD to use the host's device instead:
#
#   PROOF_GPU_DEVICE=nvidia.com/gpu=all VK_ICD=/etc/vulkan/icd.d/nvidia_icd.json \
#     proof/docker/record-native.sh proof/scenes/<name>.sh
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && /bin/pwd -P)"
cd "${REPO_ROOT}"
[ "$#" -gt 0 ] || {
	echo "usage: record-native.sh <scene.sh> [<scene.sh>...]" >&2
	exit 2
}

# `cargo metadata` states the target directory this workspace actually builds
# into, which a host config may point anywhere; guessing `target/` recorded a
# stale binary on every machine whose config moves it off the source disk.
resolve_binary() {
	if [ -n "${DESKTOP_BINARY:-}" ]; then
		printf '%s' "${DESKTOP_BINARY}"
		return
	fi
	local target_dir
	target_dir="$(cargo metadata --no-deps --format-version 1 2>/dev/null |
		python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])' 2>/dev/null || true)"
	printf '%s' "${target_dir:-${REPO_ROOT}/target}/${DESKTOP_PROFILE:-debug}/veyyon-desktop"
}

BINARY="$(resolve_binary)"
if [ ! -x "${BINARY}" ]; then
	echo "record-native: no desktop executable at ${BINARY}" >&2
	echo "  build it:  cargo build -p veyyon-desktop" >&2
	echo "  or name it: DESKTOP_BINARY=/path/to/veyyon-desktop $0 $*" >&2
	exit 2
fi

ARM="${SCENE_ARM:-after}"
HOST_CLI=/repo/packages/coding-agent/src/cli.ts
ASSET_ENV=""
if [ "${ARM}" = "before" ] && [ -n "${PROOF_NATIVE_BEFORE_REF:-}" ]; then
	base_rev="$(git rev-parse --short=10 "${PROOF_NATIVE_BEFORE_REF}^{commit}")"
	base_dir="proof/captures/.native-before/${base_rev}"
	tool_views=packages/coding-agent/src/export/html/tool-views.generated.js
	# The extracted host imports this gitignored bundle at parse time, so git
	# archive leaves it out. The rest of the workspace resolves at HEAD, and so
	# does the bundle built from it.
	if [ ! -f "${tool_views}" ]; then
		echo "record-native: ${tool_views} is missing" >&2
		echo "  build it:  bun --cwd=clients/web run gen:tool-views" >&2
		exit 2
	fi
	# Parallel takes share one extracted tree: the first builds it under the lock,
	# the rest wait and reuse it once .complete marks it whole.
	mkdir -p proof/captures/.native-before
	exec 9>proof/captures/.native-before/.lock
	flock 9
	if [ ! -f "${base_dir}/.complete" ]; then
		rm -rf "${base_dir}"
		mkdir -p "${base_dir}"
		git archive --format=tar "${base_rev}" -- packages/coding-agent \
			':(exclude)packages/coding-agent/test' | tar -x -C "${base_dir}"
		cp "${tool_views}" "${base_dir}/${tool_views}"
		python3 - "${REPO_ROOT}/scripts/desktop-bench" "${base_dir}" "${base_rev}" <<'PY'
import sys
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import apps

apps._extract_assets(Path(sys.argv[2]), sys.argv[3])
PY
		touch "${base_dir}/.complete"
	fi
	flock -u 9
	exec 9>&-
	HOST_CLI="/repo/${base_dir}/packages/coding-agent/src/cli.ts"
	assets="${base_dir}/veyyon/assets"
	if [ -d "${assets}/crates/veyyon-desktop-tokens/tokens" ]; then
		ASSET_ENV="VEYYON_DESKTOP_TOKENS_DIR=/repo/${assets}/crates/veyyon-desktop-tokens/tokens \
VEYYON_DESKTOP_THEMES_DIR=/repo/${assets}/crates/veyyon-desktop-tokens/themes"
	fi
	echo "record-native: the before arm runs the GUI host of ${base_rev}${ASSET_ENV:+ and its token directories}"
fi

export PROOF_HOST_REPO_SOURCE="${BINARY}"
export PROOF_HOST_REPO_TARGET=/desktop-bin/veyyon-desktop
export SCENE_TERMINAL=native
: "${SCENE_WIDTH:=1180}"
: "${SCENE_HEIGHT:=800}"
: "${SCENE_MOTION_GATE:=0}"
: "${SCENE_GIF:=0}"
export SCENE_WIDTH SCENE_HEIGHT SCENE_MOTION_GATE SCENE_GIF

# shellcheck source=proof/docker/recorder-image.sh
source "${REPO_ROOT}/proof/docker/recorder-image.sh"
if [ "${ARM}" = "before" ]; then
	OUT="${OUT_DIR:-${REPO_ROOT}/proof/captures/x11/before}"
else
	OUT="${OUT_DIR:-${REPO_ROOT}/proof/captures/x11}"
fi

# Each clip the take marked, cut from the take at the capture rate and gated.
publish_clips() { # <scene.sh>
	local name clips
	name="$(basename "$1" .sh)"
	clips="${OUT}/${name}-clips.tsv"
	[ -s "${clips}" ] || return 0
	docker run --rm \
		--mount "type=bind,src=${REPO_ROOT}/proof,dst=/proof,readonly" \
		--mount "type=bind,src=${OUT},dst=/out" \
		--entrypoint bash "${RECORDER_IMAGE}" -c '
			set -euo pipefail
			status=0
			while IFS=$'"'"'\t'"'"' read -r clip start end; do
				webp="/out/'"${name}"'-${clip}.webp"
				ffmpeg -loglevel error -y -ss "${start}" -to "${end}" -i "/out/'"${name}"'.mp4" \
					-vf "fps='"${SCENE_FPS:-30}"',scale=iw:-2:flags=lanczos" -c:v libwebp_anim \
					-lossless 0 -q:v 70 -preset text -loop 0 -an "${webp}"
				python3 /proof/webp-cadence.py "${webp}" --expect-ms 33 || status=1
			done <"/out/'"${name}"'-clips.tsv"
			exit "${status}"
		'
}

for scene in "$@"; do
	[ -f "${scene}" ] || {
		echo "record-native: no scene at ${scene}" >&2
		exit 2
	}
	SCENE_COMMAND="env VK_DRIVER_FILES=${VK_ICD:-/usr/share/vulkan/icd.d/lvp_icd.json} \
VEYYON_BIN=${HOST_CLI} ${ASSET_ENV} \
bash /repo/proof/scenes/desktop-lib.sh launch /repo/${scene} /desktop-bin/veyyon-desktop"
	export SCENE_COMMAND
	if [ "${ARM}" = "before" ]; then
		"${REPO_ROOT}/proof/docker/record-x11-before.sh" "${scene}"
	else
		"${REPO_ROOT}/proof/docker/record-x11.sh" "${scene}"
	fi
	publish_clips "${scene}"
done
