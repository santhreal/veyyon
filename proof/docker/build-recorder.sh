#!/usr/bin/env bash
# Build the recording guest.
#
#   bash proof/docker/build-recorder.sh
#
# The image is the sandbox userland plus a real terminal, a real X display, a
# compositor with blur, and ffmpeg. It is built on the same guest the test rungs
# use, so the bun inside a recording is the bun the tests ran on, and the tag says
# which one that was.
#
# The guest image is built first when it is missing, by the script that owns it.
# Before this existed the recorder was built by hand and tagged by hand, which is
# how five generations of image accumulated and how the whole capture path ended up
# pinned to a bun the product no longer starts on.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && /bin/pwd -P)"
# shellcheck source=proof/docker/recorder-image.sh
source "${REPO_ROOT}/proof/docker/recorder-image.sh"

GUEST_IMAGE="veyyon-test-guest:${BUN_VERSION}"

log() { printf '[build-recorder] %s\n' "$*" >&2; }

command -v docker >/dev/null 2>&1 || {
	log "docker is required"
	exit 2
}

if ! docker image inspect "${GUEST_IMAGE}" >/dev/null 2>&1; then
	log "guest image ${GUEST_IMAGE} is missing; building it"
	VEYYON_SANDBOX_USERLAND_ONLY=1 bash "${REPO_ROOT}/scripts/test-sandbox/guest/build-guest.sh"
fi

log "building ${RECORDER_IMAGE} on ${GUEST_IMAGE}"
docker build \
	--build-arg "BASE=${GUEST_IMAGE}" \
	-t "${RECORDER_IMAGE}" \
	-f "${REPO_ROOT}/proof/docker/Dockerfile.recorder" \
	"${REPO_ROOT}/proof/docker" >&2

# The version the product checks at startup, checked here instead: a take that
# fails on it has already spent a display server, a compositor and a terminal.
IN_IMAGE="$(docker run --rm --entrypoint bun "${RECORDER_IMAGE}" --version)"
if [ "${IN_IMAGE}" != "${BUN_VERSION}" ]; then
	log "error: ${RECORDER_IMAGE} carries bun ${IN_IMAGE}, but this repo declares ${BUN_VERSION}"
	exit 1
fi

PROOF_NETWORK="${PROOF_NETWORK:-veyyon-proof}"
if ! docker network inspect "${PROOF_NETWORK}" >/dev/null 2>&1; then
	docker network create "${PROOF_NETWORK}" >/dev/null
	log "created recorder network ${PROOF_NETWORK}"
fi
log "${RECORDER_IMAGE} ready: bun ${IN_IMAGE}"
