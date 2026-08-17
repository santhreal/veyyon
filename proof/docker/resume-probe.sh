#!/usr/bin/env bash
# What does resuming a real, huge session actually cost?
#
#   resume-probe.sh <session.jsonl> [seconds]
#
# Runs the CLI on a copy of the session inside a container, under a pty, and
# reports three numbers a video cannot: how long the first paint took, how many
# bytes the app wrote, and how many times it erased native scrollback (ED3).
# Nothing is typed and no model is called -- this measures the LOAD, which is
# the part a long session is supposed to make expensive.
#
# The session file is bind-mounted read-only and copied into the container's own
# tmpfs home. The operator's ~/.veyyon is never mounted and never written.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SESSION="${1:?usage: resume-probe.sh <session.jsonl> [seconds]}"
SECS="${2:-120}"
SIZE="$(stat -c %s "${SESSION}")"

docker run --rm -i -t \
	--network "${PROOF_NETWORK:-veyyon-proof}" \
	--mount "type=bind,src=${REPO_ROOT},dst=/repo,readonly" \
	--mount "type=bind,src=${SESSION},dst=/session.jsonl,readonly" \
	--tmpfs /sandbox/home:exec,size=4g \
	--tmpfs /tmp:exec,size=6g \
	-e HOME=/sandbox/home \
	-e TERM=xterm-256color \
	-e COLORTERM=truecolor \
	-e LOCAL_LLM_KEY=none \
	-e "PROBE_SECS=${SECS}" \
	-e "PROBE_SIZE=${SIZE}" \
	-w /repo \
	"${RECORDER_IMAGE:-veyyon-proof-recorder:2}" \
	bash -lc '
		set -e
		mkdir -p /sandbox/home/.veyyon
		cp -r /repo/proof/docker/home-seed/. /sandbox/home/.veyyon/
		D=/sandbox/home/.veyyon/profiles/default/agent/sessions/-sandbox-home-demo
		mkdir -p "${D}" /sandbox/home/demo
		cp /session.jsonl "${D}/resumed.jsonl"
		cd /sandbox/home/demo
		start=$(date +%s.%N)
		script -qc "stty rows 40 cols 120; timeout -k 5 ${PROBE_SECS} bun /repo/packages/coding-agent/src/cli.ts --resume ${D}/resumed.jsonl" /tmp/pty.raw >/dev/null 2>&1 || true
		end=$(date +%s.%N)
		export SESSION_BYTES="${PROBE_SIZE}"
		export SESSION_MESSAGES="$(wc -l <"${D}/resumed.jsonl")"
		export WALL_SECONDS="$(python3 -c "print(round(${end} - ${start}, 1))")"
		python3 /repo/proof/docker/pty-stats.py /tmp/pty.raw resume
	'
