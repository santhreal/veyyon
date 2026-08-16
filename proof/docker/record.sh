#!/usr/bin/env bash
# Record one tape inside the recording container.
#
#   proof/docker/record.sh proof/tapes/real/<name>.tape
#
# The container sees the repo at /repo, writes captures to /out
# (proof/captures/real on this machine), and runs against the local llama.cpp
# server on the proof network. HOME is a tmpfs seeded from proof/docker/home-seed,
# so the operator's ~/.veyyon is never read and never written.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TAPE="${1:?usage: record.sh <tape>}"
OUT="${REPO_ROOT}/proof/captures/real"
mkdir -p "${OUT}"

docker run --rm \
	--network "${PROOF_NETWORK:-veyyon-proof}" \
	--mount "type=bind,src=${REPO_ROOT},dst=/repo" \
	--mount "type=bind,src=${REPO_ROOT}/proof/docker/home-seed,dst=/seed,readonly" \
	--mount "type=bind,src=${OUT},dst=/out" \
	--tmpfs /sandbox/home:exec,size=1g \
	--tmpfs /tmp:exec,size=1g \
	-e HOME=/sandbox/home \
	-e TERM=xterm-256color \
	-e COLORTERM=truecolor \
	-e LOCAL_LLM_KEY=none \
	-w /repo \
	"${RECORDER_IMAGE:-veyyon-proof-recorder:1}" \
	bash -lc '
		set -e
		mkdir -p /sandbox/home/.veyyon
		cp -r /seed/. /sandbox/home/.veyyon/
		mkdir -p /sandbox/home/demo/src
		printf "export function parse(s) {\n\tif (!s) throw new Error(\"empty focus string\");\n\treturn s.trim();\n}\n" > /sandbox/home/demo/src/parser.ts
		printf "# demo\n\nA tiny project the recording drives.\n" > /sandbox/home/demo/README.md
		exec vhs "/repo/'"${TAPE}"'"
	'
