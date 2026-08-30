#!/usr/bin/env bash
# Record a landing-page demo: a real 1920x1080 session in a composited terminal,
# driving a real model that calls real tools.
#
#   PROOF_LLM_BASE_URL=http://<host>:11434/v1 bash scripts/demos/record-hd-demo.sh
#   PROOF_LLM_BASE_URL=http://<host>:11434/v1 bash scripts/demos/record-hd-demo.sh settings-pointer
#
# The argument is a scene under proof/scenes/ and it selects the whole recipe for
# that row, because two kinds of scene need two different cuts. A session scene is
# cut by change magnitude: it runs for minutes and its interesting moments are
# blocks landing. A gesture scene is cut as one span, because a pointer crossing a
# sidebar is too small a change for any threshold to separate from noise.
#
# Requires docker, the recorder image (proof/docker/Dockerfile.recorder), and an
# OpenAI-compatible server that honours the model name in a request. Ollama does;
# the small llama.cpp proof server does not, which is why the base URL is an
# argument rather than a default.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

# Local takes need an OpenAI-compatible loopback. A cloud model (Gemini, …) talks
# to its own endpoint and does not.
DEMO_MODEL="${DEMO_MODEL:-local/demo-qwen38-27b-96k}"
SCENE="${1:-demo-hd}"
CLOUD_MODEL=0
case "${DEMO_MODEL}" in
local/*) CLOUD_MODEL=0 ;;
*) CLOUD_MODEL=1 ;;
esac
if [[ ${CLOUD_MODEL} -eq 0 ]]; then
	: "${PROOF_LLM_BASE_URL:?set PROOF_LLM_BASE_URL to an OpenAI-compatible endpoint}"
else
	PROOF_LLM_BASE_URL="${PROOF_LLM_BASE_URL:-}"
fi

# WHICH DISPLAY SERVER RECORDS THE TAKE. `x11` is picom's frosted backdrop behind an
# opaque window, which is every frame published so far; `wayland` is swayfx, where the
# corner radius, the shadow and the blur are on the terminal's own buffer. The scene is
# the same file either way -- the difference lives entirely in the six primitives
# proof/scenes/backend-${SCENE_SERVER}.sh provides -- so this picks a recorder and a
# capture directory and changes nothing else.
#
# It defaults to x11 on purpose. Every published still and the hero video were recorded
# through that path, and a default that silently moved them to a different compositor
# would make the next re-record of one frame inconsistent with the eleven beside it.
DEMO_SERVER="${DEMO_SERVER:-x11}"
case "${DEMO_SERVER}" in
x11) RECORDER="proof/docker/record-x11.sh" ;;
wayland) RECORDER="proof/docker/record-wl.sh" ;;
*)
	echo "record-hd-demo.sh: DEMO_SERVER must be x11 or wayland, not '${DEMO_SERVER}'" >&2
	exit 2
	;;
esac
CAPTURES="proof/captures/${DEMO_SERVER}"

# The terminal runs the app unless a scene needs a shell, which one of them does.
SCENE_WORKDIR="${SCENE_CWD:-/sandbox/home/demo}"
SCENE_CMD="bun /repo/packages/coding-agent/src/cli.ts --model ${DEMO_MODEL}"
# Cloud rows can drop thinking effort so the take is a session, not a thinking
# stream. Gemini 3.7 Flash honours `low`.
if [[ -n "${DEMO_THINKING:-}" ]]; then
	SCENE_CMD="${SCENE_CMD} --thinking ${DEMO_THINKING}"
fi
# A row shows the block, the card or the diff, and this model reasons in pages, so
# every scene records with `Hide Thinking Blocks` on -- the hero included, which is
# a reversal. The hero ran once with thinking shown, on the theory that a session
# showcase should show the model working: three quarters of the resulting clip was
# italic rumination ("Wait, no. Wait, the current code has...") and the product read
# as though it could not make up its mind. Thinking is worth watching live; it is
# not worth 22 seconds of a landing page.
HIDE_THINKING=1
# Settings a single row needs. They are per recipe because a row's tuning is bad for
# the others: the compaction row wants a session that compacts, and every other row
# recorded with that tuning compacted on turn one, freed nothing, and said so.
SETTINGS=
# A row publishes a clip only when there is motion worth watching. A surface that just
# sits there -- the settings card, the prompt inspector -- publishes one frame instead,
# named here. A clip of a static pane is a still with a file size, and the seconds it
# spends arriving are seconds of a recorder typing.
STILL=
# A row about a detail on a 2560-wide screen names the mark to zoom into. The take is
# captured wider than it publishes, so a 1920-wide crop is a 1.33x zoom with no upscale;
# empty means the take publishes at full width. `proof/zoom.py --self-check` proves the
# stage on the host before a take depends on it.
ZOOM_ARGS=()
case "${SCENE}" in
demo-hd)
	ASSET=assets/demo-hd.webp
	ZOOM_ARGS=()
	# 30, because 30 is what the pipeline delivers whole and 60 is not. Measured in
	# the recorder image at 2560x1440 with the hero's own chrome, a payload
	# repainting every cell of the 134x31 grid as fast as the terminal accepts it,
	# unique frames counted with mpdecimate:
	#
	#   capture 30, themed, idle          240 unique / 240 grabbed   30 fps
	#   capture 30, themed, 12 cores busy 223 unique / 240 grabbed   27 fps
	#   capture 30, no compositor, idle   240 unique / 240 grabbed   30 fps
	#
	# Every frame distinct at 30. Capturing at 60 does not add motion the session
	# never had: it doubles the encoder's core count and the file, and it writes a
	# 60 fps header over content that changes far slower, which is what made an
	# earlier take read as "60 fps but stuttering" when ffprobe was believed over
	# the pixels. Judge a take with proof/motion-gate.sh, never with the header.
	SCENE_FPS=30
	CADENCE_MS=33
	# The hero also ships whole. The task runs for many minutes and the landing
	# page gets a dense cut, so both are published and the cut can be checked
	# against the complete autonomous goal session.
	PUBLISH_TAKE=1
	SCENE_WORKDIR=/sandbox/home/demo/ship-sim
	# Goal continuation owns the long run. Todo reminders would add a second
	# continuation mechanism and can race the goal timer, so the demo uses one
	# explicit owner for autonomous progress.
	SETTINGS="todo.reminders: false"
	#
	# SETUP AND RELEASE STAY AT REAL SPEED. The goal, secret, todo board, and
	# parallel worker launch establish what the operator asked for; the compiled
	# simulator, permission boundary, signature, completed plan, and final flight
	# display prove what finished. The implementation between those edges is
	# accelerated only 1.25x. Untouched stretches are still trimmed, so the speed
	# change applies to visible work rather than hiding time behind a jump cut.
	#
	# The two named marks are source-derived boundaries. hero-cut splits a span at
	# them if necessary, which keeps pointer and permission motion at 1.0x even
	# when one measured lead overlaps the accelerated middle.
	CUT_WIDTH=1920
	WEBP_WIDTH=1920
	CUT_ARGS=(
		--speed 6
		--edge-speed 1.0
		--real-through-mark agent-lanes
		--real-from-mark build-verified
		--mark-lead-max 90
		--hold 4
		--crf 26
		--still-keep 4
		--still-min 4
		--speed-badge
		--fps "${SCENE_FPS}"
		--webp-fps "${SCENE_FPS}"
	)
	;;
todo-marathon)
	ASSET=assets/demo-todo-hd.webp
	# The take ships whole as well as cut. A row whose subject is a list being
	# worked through is a claim about duration, and the cut is the only thing
	# standing between a reader and that claim -- so the uncut take is published
	# beside it and the two can be checked against each other.
	PUBLISH_TAKE=1
	# Automatic maintenance is off. Fourteen tasks over about a dozen turns is a
	# session that grows steadily, and a compaction pass landing mid-walk repaints
	# the transcript and takes the board's own history with it -- which reads, on
	# screen, exactly like the board losing its rows.
	SETTINGS=$'compaction.enabled: false'
	# The hero's recipe, for the hero's reason: real speed, leads taken from the
	# recording rather than a constant, and dead air trimmed to a readable pause.
	# A row about a list being closed out one task at a time cannot be sped up
	# without destroying the thing it is showing -- at 1.4x the pointer walk is a
	# flicker -- and cannot be played out untrimmed either, because a local 27B
	# spends most of each turn with nothing on screen moving.
	CUT_WIDTH=1920
	WEBP_WIDTH=1280
	CUT_ARGS=(--speed 1.0 --mark-lead-max 24 --hold 4 --crf 26 --still-keep 4 --still-min 4)
	;;
settings-pointer)
	ASSET=assets/demo-settings-hd.png
	PUBLISH_TAKE=0
	STILL=sidebar-click
	CUT_ARGS=()
	;;
popup-grow)
	ASSET=assets/demo-commands-hd.webp
	PUBLISH_TAKE=0
	CUT_ARGS=(--single --scene-score 0.004 --speed 1.2)
	;;
project-answer)
	ASSET=assets/demo-answer-hd.webp
	PUBLISH_TAKE=0
	CUT_ARGS=()
	;;
write-and-test)
	ASSET=assets/demo-edit-hd.webp
	PUBLISH_TAKE=0
	CUT_ARGS=()
	;;
plan-mode)
	ASSET=assets/demo-plan-hd.webp
	PUBLISH_TAKE=0
	CUT_ARGS=()
	;;
context-compaction)
	ASSET=assets/demo-compaction-hd.webp
	PUBLISH_TAKE=0
	# One window for every row now, and it is the window the server serves. The small
	# recent budget crosses the cut point inside it, and 95% lets the fill reach a
	# gauge worth photographing before automatic maintenance takes it.
	SETTINGS=$'compaction.keepRecentTokens: 1200\ncompaction.threshold: "95%"'
	CUT_ARGS=()
	;;
agent-lanes)
	ASSET=assets/demo-agents-hd.webp
	PUBLISH_TAKE=0
	CUT_ARGS=()
	;;
secret-boundary)
	ASSET=assets/demo-secret-hd.webp
	PUBLISH_TAKE=0
	CUT_ARGS=()
	;;
lsp-refactor)
	ASSET=assets/demo-lsp-hd.webp
	PUBLISH_TAKE=0
	# `lsp.enabled` ships OFF -- a language server per project, plus two policy
	# statements and a tool description in every prompt -- so a row about the server
	# turns the shipped setting on. Without it the model correctly reports that the lsp
	# tool is not in its toolset, which is what the third take recorded.
	#
	# Automatic maintenance is off for this row. Two short turns need no maintenance, and
	# the row that is about maintenance is not this one; with the server's two policy
	# statements in the prompt an automatic pass has nothing useful to free and says so.
	SETTINGS=$'lsp.enabled: true\ncompaction.enabled: false'
	# Real speed, like the hero: a row that fast-forwards the thing it is
	# illustrating is the defect the hero was republished to fix, at a smaller
	# scale. The lead stays flat because this row's subject is a refactor
	# ARRIVING rather than the minutes of turn behind it, and the trim keeps the
	# settle between its two short turns from becoming most of the clip.
	CUT_ARGS=(--speed 1.0 --still-keep 4 --still-min 4)
	;;
stills-extra)
	# Two surfaces the long take does not reach: the worker roster, and the prompt
	# inspector, which is a subcommand rather than a session surface. Every frame it
	# takes is published; there is no clip, because neither surface moves.
	ASSET=assets/stills-extra-agents.png
	PUBLISH_TAKE=0
	STILL=all
	CUT_ARGS=()
	;;
prompt-architecture)
	ASSET=assets/demo-prompt-hd.png
	PUBLISH_TAKE=0
	# Two subcommands printing tables, so the terminal runs a shell, and what they
	# print does not move: the row is the assembled section table, published as the
	# frame the scene took of it.
	SCENE_CMD="bash -l"
	STILL=all
	CUT_ARGS=()
	;;
install-binary)
	ASSET=assets/demo-install-hd.webp
	PUBLISH_TAKE=0
	# A shell, and a network install: the download and the checksum are the row, so
	# the scene needs the internet the recorder network already has.
	SCENE_CMD="bash -l"
	# A download and a checksum are the row, and both are things whose real duration
	# is the point: a progress bar at 1.4x is a claim about how fast an install is.
	# The trim covers the shell sitting idle either side of it.
	CUT_ARGS=(--speed 1.0 --still-keep 4 --still-min 4)
	;;
*)
	echo "record-hd-demo.sh: no recipe for scene '${SCENE}'" >&2
	exit 2
	;;
esac

# A REHEARSAL RECORDS AND PUBLISHES NOTHING. `PUBLISH=0` runs the take exactly as a real
# one -- same scene, same chrome, same settings, same signing number -- and then leaves
# every frame in the work directory instead of copying it into assets/ and
# proof/captures/. That is what a chrome change needs: the published gallery is eleven
# frames and a hero video that all claim to come from ONE session, so a take recorded to
# look at is not allowed to replace three of them and leave the other eight recorded
# under the compositor it replaced.
if [[ "${PUBLISH:-1}" != "1" ]]; then
	PUBLISH_TAKE=0
	STILL=
	REHEARSAL=1
else
	REHEARSAL=0
fi

# WHERE THE TAKE IS WRITTEN. The recorder writes the video, every frame and the marks
# file into this directory through a bind mount, as root inside the container. On an NFS
# export with root_squash -- which is how this repo is mounted on the host that serves the
# weights -- root maps to an anonymous uid and every one of those writes is denied. The
# first symptom is `rm: cannot remove .../<scene>-marks.tsv: Permission denied` for a file
# that did not exist, because unlink in an unwritable directory reports EACCES rather than
# ENOENT, and by then the display server, the compositor and the model are all up.
# WORK_DIR names a directory on local disk instead.
WORK_BASE="${WORK_DIR:-.captures}"
mkdir -p "${WORK_BASE}"
WORK="$(mktemp -d "${WORK_BASE}/veyyon-hd-demo.XXXXXX")"
# Kept on failure, deleted on success. A twenty-five minute take died here on `magick:
# command not found` and the unconditional cleanup then removed the fifteen frames it had
# already taken, so a missing publishing tool cost the whole recording rather than the last
# step of it. On success there is nothing left worth keeping: every frame has been copied
# into proof/captures and resampled into assets.
cleanup() {
	local code=$?
	trap - EXIT
	type magick_tmpdir_release >/dev/null 2>&1 && magick_tmpdir_release 2>/dev/null || true
	if [ "${code}" -eq 0 ] && [ "${REHEARSAL:-0}" -eq 0 ]; then
		rm -rf "${WORK}"
	else
		echo "record-hd-demo.sh: kept ${WORK}" >&2
	fi
}
trap cleanup EXIT

# The same question the take asks, asked in one second: can the container write here?
# shellcheck source=proof/docker/recorder-image.sh
source proof/docker/recorder-image.sh
if ! docker run --rm --mount "type=bind,src=$(cd "${WORK}" && pwd),dst=/out" "${RECORDER_IMAGE}" \
	bash -lc 'touch /out/.write-probe && rm /out/.write-probe' >/dev/null 2>&1; then
	echo "record-hd-demo.sh: the recorder cannot write into ${WORK}. A network mount that squashes root denies every frame the take produces. Set WORK_DIR to a directory on local disk." >&2
	exit 2
fi

# EVERY EXTERNAL BINARY THIS RUN WILL NEED, RESOLVED BEFORE ANY WEIGHTS ARE TOUCHED.
# ImageMagick 7 ships `magick` and 6 ships `convert`, this fleet has 6, and the resampling
# step assumed 7 -- which is how a take reached its publish step and lost its stills to a
# PATH difference. The same argument covers the rest of the publish chain: ffmpeg and
# python3 are first called after the recording is over, so a host without them loses the
# take rather than the last step of it.
if command -v magick >/dev/null 2>&1; then
	IM=(magick)
elif command -v convert >/dev/null 2>&1; then
	IM=(convert)
else
	echo "record-hd-demo.sh: no ImageMagick (magick or convert) on PATH" >&2
	exit 2
fi
# ImageMagick 6 writes magick-* pixel-cache files under MAGICK_TMPDIR and leaves
# them on SIGKILL. Scope them under WORK so they never land in /tmp; the EXIT
# trap already deletes WORK on success, and a kept failure directory is bounded.
# shellcheck source=proof/docker/magick-tmpdir.sh
source "${REPO_ROOT}/proof/docker/magick-tmpdir.sh"
magick_tmpdir_scope "${WORK}"

REQUIRED_TOOLS=(docker)
if [[ "${REHEARSAL}" -eq 0 ]]; then
	REQUIRED_TOOLS+=(ffmpeg python3)
fi
for tool in "${REQUIRED_TOOLS[@]}"; do
	if ! command -v "${tool}" >/dev/null 2>&1; then
		echo "record-hd-demo.sh: ${tool} is not on PATH. The take needs it, so it is resolved now rather than after the recording." >&2
		exit 2
	fi
done

# The zoom stage measures its region with ffprobe and Pillow, both first called after the
# recording is over. A row that asks for a zoom resolves them here for the same reason the
# publish tools are resolved here.
if [[ ${#ZOOM_ARGS[@]} -gt 0 && "${REHEARSAL}" -eq 0 ]]; then
	if ! command -v ffprobe >/dev/null 2>&1; then
		echo "record-hd-demo.sh: the zoom stage needs ffprobe, which is not on PATH." >&2
		exit 2
	fi
	if ! python3 -c "import PIL" >/dev/null 2>&1; then
		echo "record-hd-demo.sh: the zoom stage needs Pillow (python3 -m pip install pillow)." >&2
		exit 2
	fi
fi

# The scene checker below runs under bun. A recording is driven on the machine serving the
# weights, which means over ssh, and a non-login shell there does not carry the installer's
# PATH entry -- so the default install location is tried before giving up.
if command -v bun >/dev/null 2>&1; then
	BUN=bun
elif [[ -x "${HOME}/.bun/bin/bun" ]]; then
	BUN="${HOME}/.bun/bin/bun"
else
	echo "record-hd-demo.sh: no bun on PATH or at ~/.bun/bin/bun. The scene checker needs it." >&2
	exit 2
fi

# The coding agent imports a gitignored html bundle at parse time. A worktree
# without it opens the terminal, then the CLI dies, and the recorder reports
# that no window ever appeared.
if [[ ! -f packages/coding-agent/src/export/html/tool-views.generated.js ]]; then
	"${BUN}" --cwd=packages/collab-web run gen:tool-views
fi
if [[ ! -f natives/bridge/bindings/native/veyyon_natives.linux-x64-modern.node && ! -f natives/bridge/bindings/native/veyyon_natives.linux-x64-baseline.node ]]; then
	"${BUN}" --cwd=natives/bridge/bindings run ensure
fi

# WHAT A MARKS FILE IS FOR HERE. The scene appends one row per frame that landed, so it is an
# independent record of what the take captured. Both publish paths below copy the PNGs that
# exist and nothing else, which means a shot that never landed does not fail a run: it leaves
# the PREVIOUS take's frame under that name in assets/ and proof/captures, freshly timestamped
# by the copy and indistinguishable from a new one. A gallery whose captions say every frame
# came from one session cannot be assembled by a step that silently keeps frames from another.
#
# A scene with no SCENE_T0 writes no marks at all, and that is legitimate: there is simply no
# independent record to check it against, so the run says which check it is falling back to
# rather than reporting a verification it did not perform.
#
# WHAT THIS DOES NOT CATCH: a capture that succeeded on the wrong screen. The inspector scene
# once typed a command the window could not run and published its backdrop twice under two
# names, and both files were real PNGs of the right size taken at the right instant. Nothing
# structural sees that. It is caught by looking at the frame against the caption that claims it,
# which is a review step and not a gate.
require_every_mark_has_a_frame() {
	local marks="${WORK}/${SCENE}-marks.tsv"
	if [[ ! -f ${marks} ]]; then
		echo "record-hd-demo.sh: scene '${SCENE}' kept no marks; publishing on frame count alone" >&2
		return 0
	fi
	local missing=() mark
	while IFS=$'\t' read -r mark _; do
		[[ -n ${mark} ]] || continue
		[[ -s "${WORK}/${SCENE}-${mark}.png" ]] || missing+=("${mark}")
	done <"${marks}"
	if [[ ${#missing[@]} -gt 0 ]]; then
		echo "record-hd-demo.sh: the scene marked ${#missing[@]} shot(s) it never wrote: ${missing[*]}" >&2
		echo "record-hd-demo.sh: refusing to publish a set that would keep an older take's frames" >&2
		exit 1
	fi
}

# GUARDS BEFORE WEIGHTS. Every string the scene waits for has to be produced by something --
# the prompt, the product's own source, or the sandbox seed -- and a needle nothing produces
# does not fail fast: it waits out its whole timeout, marks the shot missed, and the publish
# step then leaves the PREVIOUS take's frame under that name. Two guards in this scene were in
# that state (a board header that dropped its count, a status line that lives in a details
# panel), which is minutes of a take spent proving nothing.
"${BUN}" scripts/verify-scene.ts "${SCENE}" >&2

if [[ ${CLOUD_MODEL} -eq 0 ]]; then
# WHICH MODEL, AND WHERE IT IS. The take is recorded on the host serving the weights, so the
# endpoint is a loopback address; a base URL pointing at another machine means the session's
# every token crosses a network the recording then blames for its pauses. Naming it here is
# cheap and refusing it is the point -- `ALLOW_REMOTE_MODEL=1` records anyway, and says so.
MODEL_HOST="$(printf '%s' "${PROOF_LLM_BASE_URL}" | sed -E 's#^[a-z]+://([^:/]+).*#\1#')"
case "${MODEL_HOST}" in
	localhost | 127.0.0.1 | ::1 | 0.0.0.0) MODEL_IS_LOCAL=1 ;;
	*) MODEL_IS_LOCAL=0 ;;
esac
if [[ ${MODEL_IS_LOCAL} -eq 0 && "${ALLOW_REMOTE_MODEL:-0}" != "1" ]]; then
	echo "record-hd-demo.sh: ${PROOF_LLM_BASE_URL} is not on this host. Record on the machine serving ${DEMO_MODEL}, or set ALLOW_REMOTE_MODEL=1." >&2
	exit 1
fi

# The row has to exist on that server before a take starts. A model name the server does not
# hold answers every request with an error the session renders as a red block, and the first
# time anyone sees that is on the recording.
SERVED_MODELS="$(curl -s --max-time 30 "${PROOF_LLM_BASE_URL%/}/models" || true)"
if [[ -n "${SERVED_MODELS}" ]] && ! printf '%s' "${SERVED_MODELS}" | grep -qF "${DEMO_MODEL#local/}"; then
	echo "record-hd-demo.sh: ${PROOF_LLM_BASE_URL} does not serve ${DEMO_MODEL#local/}. Load it, or set DEMO_MODEL to a row it has." >&2
	exit 1
fi

# Warm the server before anything is recorded. The first request against a freshly
# loaded model pays for prompt evaluation, and a scene that pays for it on screen opens
# on a spinner -- which every row used to do, by spending its first turn asking the model
# to reply with the word "ready". That turn was published. This one is not on screen at
# all: same weights, same window, one throwaway request from the host.
curl -s --max-time 180 "${PROOF_LLM_BASE_URL%/}/chat/completions" \
	-H 'content-type: application/json' \
	-d "{\"model\":\"${DEMO_MODEL#local/}\",\"messages\":[{\"role\":\"user\",\"content\":\"warm\"}],\"max_tokens\":4}" \
	>/dev/null || echo "record-hd-demo.sh: warm-up request failed; the row may open on a spinner" >&2

else
	echo "record-hd-demo.sh: cloud model ${DEMO_MODEL}${DEMO_THINKING:+ thinking ${DEMO_THINKING}}" >&2
	MODEL_IS_LOCAL=0
	if [[ -d "${HOME}/.veyyon/shared-auth" ]]; then
		export PROOF_AUTH_DIR="${PROOF_AUTH_DIR:-${HOME}/.veyyon/shared-auth}"
	fi
fi

# The number the session signs with, generated per run so a published frame pins one
# specific digest and the check is reproducible rather than decorative. It is passed into
# the container as an environment variable and stored there with `/secret from-env`, so it
# is typed nowhere and reaches the transcript never.
SIGNING_NUMBER="${SIGNING_NUMBER:-$(printf '%04d-%04d-%04d' $((RANDOM % 10000)) $((RANDOM % 10000)) $((RANDOM % 10000)))}"

# WHAT DROVE THE TAKE, written beside it. A published frame is a claim about a model, and the
# only record of which row and which endpoint produced it used to be whatever the operator
# remembered. This file is copied out with the frames, so a take can be traced to its weights.
{
	echo "scene: ${SCENE}"
	echo "model: ${DEMO_MODEL}"
	echo "endpoint: ${PROOF_LLM_BASE_URL}"
	echo "endpoint-is-local: ${MODEL_IS_LOCAL}"
	echo "recorded-on: $(uname -sr) $(hostname)"
	echo "display-server: ${DEMO_SERVER}"
	echo "recorded-at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"${WORK}/${SCENE}-model.txt"

PROOF_LLM_BASE_URL="${PROOF_LLM_BASE_URL}" \
	SCENE_HIDE_THINKING="${HIDE_THINKING}" \
	SCENE_COMMAND="${SCENE_CMD}" \
	SCENE_THEME=night \
	SCENE_WIDTH=2560 \
	SCENE_FPS="${SCENE_FPS:-30}" \
	SCENE_HEIGHT=1440 \
	SCENE_MARGIN="${SCENE_MARGIN:-128}" \
	SCENE_FONT_SIZE="${SCENE_FONT_SIZE:-15}" \
	SCENE_BG="#171b22" \
	SCENE_FG="#d3dae6" \
	SCENE_CWD="${SCENE_WORKDIR}" \
	SCENE_SETTLE_SCALE="${SETTLE_SCALE:-2}" \
	SCENE_GIF=0 \
	SCENE_SETTINGS="${SETTINGS}" \
	SCENE_SIGNING_NUMBER="${SIGNING_NUMBER}" \
	OUT_DIR="${WORK}" \
	bash "${RECORDER}" "proof/scenes/${SCENE}.sh"

mkdir -p assets "${CAPTURES}"

if [[ ${PUBLISH_TAKE} -eq 1 ]]; then
	# The take is captured at 2560x1440 so the published 1920-wide frame is a
	# downscale rather than an upscale, and text stays sharp after the resample.
	# The full-resolution take itself is not a file to put in a git history: 1440p at
	# crf 20 is hundreds of megabytes for twenty minutes, so the archived copy is
	# 1920 at crf 30.
	ffmpeg -loglevel error -y -i "${WORK}/${SCENE}.mp4" \
		-vf "scale=1920:-2:flags=lanczos" \
		-c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -an \
		"${CAPTURES}/${SCENE}.mp4"
	# Every frame the scene took, published twice: archived at full capture size under
	# proof/captures for the proof page, and resampled to 1920 as the screenshot the
	# landing page carries. This is what makes one take enough. A surface that does not
	# move needs a frame, not a clip, and the frames come free from the session that was
	# already running -- so the gallery costs one recording instead of one per feature.
	require_every_mark_has_a_frame
	for still in "${WORK}/${SCENE}"-*.png; do
		base="$(basename "${still}" .png)"
		cp "${still}" "${CAPTURES}/${base}.png"
		"${IM[@]}" "${still}" -resize 1920x -strip "assets/${base}.png"
	done
	cp "${WORK}/${SCENE}-model.txt" "${CAPTURES}/${SCENE}-model.txt"
	if [[ -f "${WORK}/signature-crosscheck.txt" ]]; then
		cp "${WORK}/signature-crosscheck.txt" "${CAPTURES}/${SCENE}-signature-crosscheck.txt"
		echo "--- the signature anyone can check ---"
		cat "${WORK}/signature-crosscheck.txt"
	fi
fi

if [[ "${STILL}" == "all" ]]; then
	# Every frame, for a scene that exists to take frames. Named after the scene and the
	# shot, so a surface added to the scene arrives as an asset without a recipe change.
	shopt -s nullglob
	published=0
	require_every_mark_has_a_frame
	for still in "${WORK}/${SCENE}"-*.png; do
		base="$(basename "${still}" .png)"
		cp "${still}" "${CAPTURES}/${base}.png"
		"${IM[@]}" "${still}" -resize 1920x -strip "assets/${base}.png"
		published=$((published + 1))
	done
	[[ ${published} -gt 0 ]] || {
		echo "record-hd-demo.sh: scene '${SCENE}' took no stills" >&2
		exit 1
	}
	python3 proof/tighten.py audit --base proof/captures
	ls -la assets/"${SCENE}"-*.png
	exit 0
fi

if [[ -n "${STILL}" ]]; then
	# The frame the scene took of the surface, resampled from the 2560-wide capture to
	# the published 1920. No cut, no WebP: there is nothing moving to cut.
	SRC="${WORK}/${SCENE}-${STILL}.png"
	[[ -f "${SRC}" ]] || {
		echo "record-hd-demo.sh: scene '${SCENE}' took no still named '${STILL}'" >&2
		exit 1
	}
	"${IM[@]}" "${SRC}" -resize 1920x -strip "${ASSET}"
	python3 proof/tighten.py audit --base proof/captures
	ls -la "${ASSET}"
	exit 0
fi

# A rehearsal cuts THE SAME WAY and lands the result in the work directory instead of
# over the published asset, so what gets judged is the clip the real run would have
# published rather than an approximation of it.

# The published clip carries the moments the scene exists to show. A scene that
# takes stills writes down the second of each one, and those marks are the cut: in a
# session against a reasoning model the largest changes on screen are pages of
# thinking, so a magnitude cut buries the feature in streamed text. A gesture scene
# sets its own arguments above and keeps them. `tighten.py` is the wrong instrument
# for either: the spinner and the elapsed clock make almost every frame "distinct".
MARKS="${WORK}/${SCENE}-marks.tsv"
if [[ -f "${MARKS}" && ! " ${CUT_ARGS[*]} " =~ " --single " ]]; then
	CUT_ARGS+=(--marks "${MARKS}")
fi
# THE ZOOM RUNS ON THE TAKE, BEFORE THE CUT, and only when a row asked for one. A row whose
# subject is a block of text on a 2560-wide screen loses it to the downsample, and cropping
# after the cut would resample a clip that already passed the cadence gate. The stage keeps
# every frame and the recorded rate, so the gate below still reads the capture's own cadence,
# and the archived whole take stays as it was recorded.
CUT_SOURCE="${WORK}/${SCENE}.mp4"
CUES="${WORK}/${SCENE}-cues.txt"
if [[ -f "${CUES}" ]]; then
	ZOOM_ARGS+=(--cues "${CUES}")
fi
if [[ ${#ZOOM_ARGS[@]} -gt 0 ]]; then
	ZOOM_SOURCE="${WORK}/${SCENE}-zoomed.mp4"
	if [[ -f "${MARKS}" && ! " ${ZOOM_ARGS[*]} " =~ " --marks " ]]; then
		ZOOM_ARGS+=(--marks "${MARKS}")
	fi
	if [[ ! " ${ZOOM_ARGS[*]} " =~ " --fps " ]]; then
		ZOOM_ARGS+=(--fps "${SCENE_FPS:-30}")
	fi
	python3 proof/zoom.py "${CUT_SOURCE}" "${ZOOM_SOURCE}" "${ZOOM_ARGS[@]}" || {
		echo "record-hd-demo.sh: the zoom stage found no region to hold; publishing nothing" >&2
		exit 1
	}
	if [[ -f "${CUES}" ]]; then
		python3 proof/glyph-height.py "${CUT_SOURCE}" --cues "${CUES}" --fps "${SCENE_FPS:-30}" || {
			echo "record-hd-demo.sh: the secret hold is not 2x the wide shot; publishing nothing" >&2
			exit 1
		}
	fi
	CUT_SOURCE="${ZOOM_SOURCE}"
fi
# EVERY run cuts into the work directory, and a real one copies out of it afterwards. The
# cut used to write straight over the published asset, so a clip that had been resampled
# on the way through replaced a good one and was only discovered later, by reading the
# file's own frame durations. What is published now is a file that passed the gate below.
CUT_WEBP="${WORK}/$(basename "${ASSET}")"
python3 proof/hero-cut.py "${CUT_SOURCE}" \
	--mp4 "${WORK}/${SCENE}-cut.mp4" --webp "${CUT_WEBP}" \
	--width "${CUT_WIDTH:-2560}" --webp-width "${WEBP_WIDTH:-1920}" "${CUT_ARGS[@]}"

# THE CADENCE IS PART OF THE PUBLISH CONTRACT, not a thing to notice afterwards. Both
# display servers record at SCENE_FPS, which proof/docker/scene-config.sh defines once
# as 30, so the typical frame of anything published from a take holds 33ms. The hero
# shipped at a 7.7 fps average because the path resampled it twice and nothing here was
# looking: it read as a laggy product rather than as a resampled file.
#
# The gate then passed a take that averaged 14.2 fps, because it read only the most
# common frame: 44% held 33ms while the rest held for two or more intervals. The gate
# now requires both an average within 20% of capture and 85% of moving frames at the
# capture interval. Normal keyboard, spinner and token pauses fit both; a clip whose
# fast mode hides frequent short holds does not. `--expect-ms` supplies all criteria.
python3 proof/webp-cadence.py "${CUT_WEBP}" --expect-ms "${CADENCE_MS:-33}" || {
	echo "record-hd-demo.sh: refusing to publish a clip that is not the cadence the recorder captured" >&2
	exit 1
}

if [[ ${REHEARSAL} -eq 1 ]]; then
	echo "record-hd-demo.sh: rehearsal on ${DEMO_SERVER}, published nothing"
	ls -la "${WORK}"
	exit 0
fi
cp "${CUT_WEBP}" "${ASSET}"
ls -la "${ASSET}"
# THE CUT MP4 IS THE DEMO, and it used to be deleted with the work directory. What
# survived a run was an animated WebP small enough for a README to inline, plus the
# whole twenty-minute take, and neither is the thing to hand somebody who asks to see
# the product work: the WebP is short because a landing page cannot carry minutes of
# 1280-wide animation, and the take is mostly a screen waiting on a model. The clip
# between them -- every stretch where something happened, at the speed it happened --
# had no published form at all. It has one now.
if [[ ${PUBLISH_TAKE} -eq 1 && -s "${WORK}/${SCENE}-cut.mp4" ]]; then
	cp "${WORK}/${SCENE}-cut.mp4" "${CAPTURES}/${SCENE}-cut.mp4"
	ls -la "${CAPTURES}/${SCENE}-cut.mp4"
fi
