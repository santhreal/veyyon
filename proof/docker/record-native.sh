#!/usr/bin/env bash
# Record one desktop scene: the GPUI window, not a terminal.
#
#   proof/docker/record-native.sh proof/scenes/desktop-tool-view.sh
#
# The desktop scenes drive an application window rather than a terminal grid, so
# the session needs SCENE_TERMINAL=native, the executable bind-mounted into the
# container, and a Vulkan ICD for it to open a device against. That is six
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
# THE GPU IS OPTIONAL. lavapipe renders in software, so a take needs no
# passthrough and every host draws the same frame. Pass PROOF_GPU_DEVICE and
# VK_ICD to use the host's device instead:
#
#   PROOF_GPU_DEVICE=nvidia.com/gpu=all VK_ICD=/etc/vulkan/icd.d/nvidia_icd.json \
#     proof/docker/record-native.sh proof/scenes/desktop-tool-view.sh
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && /bin/pwd -P)"
cd "${REPO_ROOT}"
SCENE="${1:?usage: record-native.sh <scene.sh> [<scene.sh>...]}"

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
	echo "  or name it: DESKTOP_BINARY=/path/to/veyyon-desktop $0 ${SCENE}" >&2
	exit 2
fi

# The token and theme directories are read from the checkout rather than an
# installed share tree, so a scene photographs the tokens in this working copy.
export PROOF_HOST_REPO_SOURCE="${BINARY}"
export PROOF_HOST_REPO_TARGET=/desktop-bin/veyyon-desktop
export SCENE_TERMINAL=native
# Inside /out, so the runtime state a scene writes (the session baseline, the
# created session id) lands in the capture directory the caller can read after
# the container is gone, rather than in the container's own tmpfs.
export SCENE_RUNTIME_DIR=/out/runtime
export SCENE_COMMAND="env VK_DRIVER_FILES=${VK_ICD:-/usr/share/vulkan/icd.d/lvp_icd.json} \
VEYYON_BIN=/repo/packages/coding-agent/src/cli.ts \
VEYYON_DESKTOP_TOKENS_DIR=/repo/crates/veyyon-desktop-tokens/tokens \
VEYYON_DESKTOP_THEMES_DIR=/repo/crates/veyyon-desktop-tokens/themes \
/desktop-bin/veyyon-desktop"
: "${SCENE_WIDTH:=1180}"
: "${SCENE_HEIGHT:=800}"
export SCENE_WIDTH SCENE_HEIGHT

if [ "${SCENE_ARM:-after}" = "before" ]; then
	exec "${REPO_ROOT}/proof/docker/record-x11-before.sh" "$@"
fi
exec "${REPO_ROOT}/proof/docker/record-x11.sh" "$@"
