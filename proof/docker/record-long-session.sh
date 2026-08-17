#!/usr/bin/env bash
# Resume one of the operator's own sessions in the container, on camera.
#
#   proof/docker/record-long-session.sh <session.jsonl> [name]
#
# The session file is bind-mounted READ-ONLY and copied into the container's
# tmpfs home before the app sees it, so the app writes to the copy and the
# original cannot be touched. The operator's ~/.veyyon is not in the mount
# table: HOME is a tmpfs seeded from proof/docker/home-seed, which is where the
# `local` provider pointing at the 1.5B on the container network comes from. No
# setting of the operator's is read and none is written.
#
# The app runs under `script`, inside kitty, so the same run produces both the
# video and the byte capture: the video shows what a person would see, and
# pty-stats.py counts what the app actually wrote -- ED3 erases, frames, bytes
# per frame. A claim about friction needs the second one; a claim about what it
# looks like needs the first.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# `--fresh` is the control arm: same scene, same model, same terminal, an empty
# session. Without it there is no baseline to compare the resumed arm's cost to.
SESSION="${1:?usage: record-long-session.sh <session.jsonl|--fresh> [name]}"
NAME="${2:-long-session}"
OUT="${REPO_ROOT}/proof/captures/x11/${NAME}"
if [[ "${SESSION}" == "--fresh" ]]; then
	SESSION=/dev/null
	SIZE=0
	LINES=0
	RESUME_ARG=""
else
	SIZE="$(stat -c %s "${SESSION}")"
	LINES="$(wc -l <"${SESSION}")"
	RESUME_ARG='--resume ${RESUMED}'
fi
mkdir -p "${OUT}"

cat >"${OUT}/cmd.sh" <<EOF
cd /sandbox/home/demo
export SESSION_BYTES=${SIZE}
export SESSION_MESSAGES=${LINES}
start=\$(date +%s.%N)
script -qc "bun /repo/packages/coding-agent/src/cli.ts ${RESUME_ARG}" /tmp/pty.raw
export WALL_SECONDS=\$(python3 -c "print(round(\$(date +%s.%N) - \${start}, 1))")
python3 /repo/proof/docker/pty-stats.py /tmp/pty.raw "${NAME}" | tee /out/pty-stats.txt
cp /tmp/pty.raw /out/pty.raw
touch /tmp/scene-done
sleep 99999
EOF

docker run --rm \
	--network "${PROOF_NETWORK:-veyyon-proof}" \
	--mount "type=bind,src=${REPO_ROOT},dst=/repo,readonly" \
	--mount "type=bind,src=${SESSION},dst=/session.jsonl,readonly" \
	--mount "type=bind,src=${OUT},dst=/out" \
	--tmpfs /sandbox/home:exec,size=6g \
	--tmpfs /tmp:exec,size=8g \
	--shm-size=512m \
	-e HOME=/sandbox/home \
	-e TERM=xterm-kitty \
	-e COLORTERM=truecolor \
	-e LANG=C.UTF-8 \
	-e LC_ALL=C.UTF-8 \
	-e LOCAL_LLM_KEY=none \
	-e DISPLAY=:99 \
	-e SCENE_LIB=/repo/proof/scenes/lib.sh \
	-e "SCENE_COMMAND=bash /sandbox/home/cmd.sh" \
	-e "SCENE_WIDTH=${SCENE_WIDTH:-1400}" \
	-e "SCENE_HEIGHT=${SCENE_HEIGHT:-860}" \
	-e "SCENE_FONT_SIZE=${SCENE_FONT_SIZE:-14}" \
	-e "SCENE_FPS=${SCENE_FPS:-20}" \
	-e "SCENE_GIF_FPS=${SCENE_GIF_FPS:-8}" \
	-e "SCENE_HOLD=${SCENE_HOLD:-600}" \
	-e "LOAD_SETTLE=${LOAD_SETTLE:-30}" \
	-e "STREAM_SETTLE=${STREAM_SETTLE:-300}" \
	-e SCENE_TERMINAL=kitty \
	-e SCENE_CWD=/sandbox/home/demo \
	-w /repo \
	"${RECORDER_IMAGE:-veyyon-proof-recorder:2}" \
	bash -lc '
		set -e
		mkdir -p /sandbox/home/.veyyon /sandbox/home/demo/src
		cp -r /repo/proof/docker/home-seed/. /sandbox/home/.veyyon/
		D=/sandbox/home/.veyyon/profiles/default/agent/sessions/-sandbox-home-demo
		mkdir -p "${D}"
		cp /session.jsonl "${D}/resumed.jsonl"
		printf "# demo\n\nThe directory the resumed session is continued in.\n" > /sandbox/home/demo/README.md
		sed "s|\${RESUMED}|${D}/resumed.jsonl|" /out/cmd.sh > /sandbox/home/cmd.sh
		exec /repo/proof/docker/xsession.sh /repo/proof/scenes/'"${SCENE:-long-session}"'.sh
	' >"${OUT}/record.log" 2>&1

mv -f "${OUT}/${SCENE:-long-session}.mp4" "${OUT}/../${NAME}.mp4"
mv -f "${OUT}/${SCENE:-long-session}.gif" "${OUT}/../${NAME}.gif"
echo "--- ${NAME}"
cat "${OUT}/pty-stats.txt" 2>/dev/null || tail -20 "${OUT}/record.log"
