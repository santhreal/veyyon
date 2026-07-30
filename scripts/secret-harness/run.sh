#!/usr/bin/env bash
# Host-side driver: build the two images, run the harness, print the report.
#
#     scripts/secret-harness/run.sh
#
# Runs from anywhere; resolves the repo root itself. Exit code is the harness
# exit code, so this is usable as a gate.
#
# `--network none` is not decoration. The harness talks to a mock provider on
# loopback, which still exists inside an empty network namespace, so a run that
# passes has proven the whole `/secret` flow without the container being able to
# reach anything at all — including whatever real endpoint a stray credential
# might otherwise have been sent to.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_IMAGE="${VEYYON_BASE:-veyyon:dev}"
HARNESS_IMAGE="${HARNESS_IMAGE:-veyyon-secret-harness:dev}"
NETWORK="${HARNESS_NETWORK:-none}"

cd "$REPO_ROOT"

if [ "${1:-}" = "--rebuild-base" ] || ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
	printf '==> building base image %s (runtime target of ./Dockerfile)\n' "$BASE_IMAGE"
	docker build --target runtime -t "$BASE_IMAGE" -f Dockerfile .
fi

printf '==> building harness image %s\n' "$HARNESS_IMAGE"
docker build --build-arg "VEYYON_BASE=${BASE_IMAGE}" -t "$HARNESS_IMAGE" -f scripts/secret-harness/Dockerfile .

printf '==> running harness (network=%s)\n' "$NETWORK"
exec docker run --rm --network "$NETWORK" "$HARNESS_IMAGE"
