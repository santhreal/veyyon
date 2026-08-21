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

: "${PROOF_LLM_BASE_URL:?set PROOF_LLM_BASE_URL to an OpenAI-compatible endpoint}"
# Qwen3.8 27B, served locally through the distinct 96k model row. The window is
# part of the proof: this session carries a plan, three subagent results, edits,
# verification, and the summary that closes each phase in one transcript. At 64k
# it reached the final turns with too little context to keep the task coherent.
DEMO_MODEL="${DEMO_MODEL:-local/demo-qwen38-27b-96k}"
SCENE="${1:-demo-hd}"

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
SCENE_CMD="bun /repo/packages/coding-agent/src/cli.ts --model ${DEMO_MODEL}"
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
case "${SCENE}" in
demo-hd)
	ASSET=assets/demo-hd.webp
	# The hero also ships whole. The take runs about twenty minutes and the page
	# gets a few of them, so both are published and the short one can be checked
	# against the long one.
	PUBLISH_TAKE=1
	# The scene owns each continuation explicitly so its named frames land before
	# the next phase begins. The default todo reminder fires as the turn settles,
	# racing the inventory capture and sometimes starting Migration before the
	# recorder can interrupt it.
	SETTINGS="todo.reminders: false"
	# THE HERO IS NOT SPED UP, AND IT SHOWS THE WORK. Every window used to be 1.2s
	# of lead played at 2x -- about half a second of real time before each frame --
	# so what published was a slideshow of outcomes with the session's actual work
	# fast-forwarded out: the search running across nine modules, three lanes
	# settling, a suite going green. Those stretches are minutes long in the take
	# and they are the demo.
	#
	# So speed is 1.0, and each mark's lead comes from the recording rather than
	# from a constant: `shot` writes the stretch between the end of the request and
	# the frame, which is the work and contains no typing by construction, and the
	# cut keeps it up to the cap.
	#
	# THE TRIM IS WHAT MAKES THAT WATCHABLE. Measured on a real take: 73% of it is
	# a screen nobody is touching, because a local 27B model spends most of a turn
	# with nothing rendering and the scene settles after each one. Playing that out
	# is a video of a still image, which reads as a product that has hung -- so
	# `--still-keep 4` trims any untouched stretch to a readable pause. Four
	# seconds is measured, not chosen: a settled screen puts 0 of 120 frames above
	# the detector's floor while a turn in flight puts 1 to 2, so a turn arrives as
	# a chain of roughly four-second stretches and a keep of four leaves it alone
	# while collapsing the screens where the turn is over.
	#
	# What that yields here: 3:11 of clip carrying every one of the 85s the screen
	# actually moved in, no freeze longer than four seconds, at the speed it was
	# recorded. The cap stays at 24 because the WebP is inlined by the README and
	# its bytes are all motion -- the trim buys density, not size, so a wider cap
	# is a heavier landing page rather than a better one. The WebP is published at
	# 1920 so the README's 960-pixel presentation gets two source pixels per CSS
	# pixel without an upscale. `website/index.html` declares the intrinsic size of
	# the file it points at and a test pins the two together, so publishing at a
	# new width means editing that `width`/`height` pair in the same change.
	CUT_WIDTH=1920
	WEBP_WIDTH=1920
	CUT_ARGS=(--speed 1.0 --mark-lead-max 24 --hold 4 --crf 26 --still-keep 4 --still-min 4)
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

WORK="$(mktemp -d /tmp/veyyon-hd-demo.XXXXXX)"
# Kept on failure, deleted on success. A twenty-five minute take died here on `magick:
# command not found` and the unconditional cleanup then removed the fifteen frames it had
# already taken, so a missing publishing tool cost the whole recording rather than the last
# step of it. On success there is nothing left worth keeping: every frame has been copied
# into proof/captures and resampled into assets.
trap 'if [ "$?" -eq 0 ] && [ "${REHEARSAL}" -eq 0 ]; then rm -rf "${WORK}"; else echo "record-hd-demo.sh: kept ${WORK}" >&2; fi' EXIT

# ImageMagick under either of its two names. ImageMagick 7 ships `magick` and 6 ships
# `convert`, this fleet has 6 on both hosts, and the resampling step assumed 7 -- which is
# how a take reached its publish step and lost its stills to a PATH difference. Resolved
# once, loudly, before anything is recorded, rather than at the end of a long take.
if command -v magick >/dev/null 2>&1; then
	IM=(magick)
elif command -v convert >/dev/null 2>&1; then
	IM=(convert)
else
	echo "record-hd-demo.sh: no ImageMagick (magick or convert) on PATH" >&2
	exit 2
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

# The number the session signs with, generated per run so a published frame pins one
# specific digest and the check is reproducible rather than decorative. It is passed into
# the container as an environment variable and stored there with `/secret from-env`, so it
# is typed nowhere and reaches the transcript never.
SIGNING_NUMBER="${SIGNING_NUMBER:-$(printf '%04d-%04d-%04d' $((RANDOM % 10000)) $((RANDOM % 10000)) $((RANDOM % 10000)))}"

# Warm the server before anything is recorded. The first request against a freshly
# loaded model pays for prompt evaluation, and a scene that pays for it on screen opens
# on a spinner -- which every row used to do, by spending its first turn asking the model
# to reply with the word "ready". That turn was published. This one is not on screen at
# all: same weights, same window, one throwaway request from the host.
curl -s --max-time 180 "${PROOF_LLM_BASE_URL%/}/chat/completions" \
	-H 'content-type: application/json' \
	-d "{\"model\":\"${DEMO_MODEL#local/}\",\"messages\":[{\"role\":\"user\",\"content\":\"warm\"}],\"max_tokens\":4}" \
	>/dev/null || echo "record-hd-demo.sh: warm-up request failed; the row may open on a spinner" >&2

PROOF_LLM_BASE_URL="${PROOF_LLM_BASE_URL}" \
	SCENE_HIDE_THINKING="${HIDE_THINKING}" \
	SCENE_COMMAND="${SCENE_CMD}" \
	SCENE_THEME=night \
	SCENE_WIDTH=2560 \
	SCENE_HEIGHT=1440 \
	SCENE_MARGIN=128 \
	SCENE_FONT_SIZE=21 \
	SCENE_BG="#171b22" \
	SCENE_FG="#d3dae6" \
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
# EVERY run cuts into the work directory, and a real one copies out of it afterwards. The
# cut used to write straight over the published asset, so a clip that had been resampled
# on the way through replaced a good one and was only discovered later, by reading the
# file's own frame durations. What is published now is a file that passed the gate below.
CUT_WEBP="${WORK}/$(basename "${ASSET}")"
python3 proof/hero-cut.py "${WORK}/${SCENE}.mp4" \
	--mp4 "${WORK}/${SCENE}-cut.mp4" --webp "${CUT_WEBP}" \
	--width "${CUT_WIDTH:-2560}" --webp-width "${WEBP_WIDTH:-1920}" "${CUT_ARGS[@]}"

# THE CADENCE IS PART OF THE PUBLISH CONTRACT, not a thing to notice afterwards. Both
# display servers record at 30 fps, so the typical frame of anything published from a take
# holds 33ms. The hero shipped at a 7.7 fps average because the path resampled it twice and
# nothing here was looking: it read as a laggy product rather than as a resampled file.
python3 proof/webp-cadence.py "${CUT_WEBP}" --expect-ms 33 || {
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
