#!/usr/bin/env bash
# Run a command inside the recording container.
#
#   proof/docker/run-recorder.sh <command...>
#
# The container carries the repo at /repo and NOTHING else from this machine:
# HOME is a tmpfs at /sandbox/home, seeded with a models.yml that points at the
# local llama.cpp server on the proof network. The operator's ~/.veyyon is not in
# the container's mount table at any path.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${RECORDER_IMAGE:-veyyon-proof-recorder:1}"
NETWORK="${PROOF_NETWORK:-veyyon-proof}"
SEED="${REPO_ROOT}/proof/docker/home-seed"

docker run --rm -i \
	--network "${NETWORK}" \
	--mount "type=bind,src=${REPO_ROOT},dst=/repo" \
	--mount "type=bind,src=${SEED},dst=/seed,readonly" \
	--tmpfs /sandbox/home:exec,size=512m \
	--tmpfs /tmp:exec,size=512m \
	-e HOME=/sandbox/home \
	-e TERM=xterm-256color \
	-e COLORTERM=truecolor \
	-e VEYYON_PROOF=1 \
	-w /repo \
	"${IMAGE}" \
	bash -lc 'mkdir -p /sandbox/home/.veyyon/profiles/default/agent && cp -r /seed/. /sandbox/home/.veyyon/ && exec "$@"' _ "$@"
