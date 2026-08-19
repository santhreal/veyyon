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
# Qwen3.8 27B, served locally with a 64k window. The window is the part that matters
# to a take: this session runs fifteen turns with tool output in every one, and at 32k
# it compacted mid-recording, so the footer gauge and the context report were both
# describing a session that had just lost half its history.
DEMO_MODEL="${DEMO_MODEL:-local/demo-qwen38-27b-64k}"
SCENE="${1:-demo-hd}"

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
	# gets half a minute out of it -- a demo whose majority is a screen waiting on a
	# model reads as a broken product -- so both are published and the short one can
	# be checked against the long one.
	PUBLISH_TAKE=1
	CUT_ARGS=()
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
	CUT_ARGS=()
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
	CUT_ARGS=(--speed 1.4)
	;;
*)
	echo "record-hd-demo.sh: no recipe for scene '${SCENE}'" >&2
	exit 2
	;;
esac

WORK="$(mktemp -d /tmp/veyyon-hd-demo.XXXXXX)"
# Kept on failure, deleted on success. A twenty-five minute take died here on `magick:
# command not found` and the unconditional cleanup then removed the fifteen frames it had
# already taken, so a missing publishing tool cost the whole recording rather than the last
# step of it. On success there is nothing left worth keeping: every frame has been copied
# into proof/captures and resampled into assets.
trap 'if [ "$?" -eq 0 ]; then rm -rf "${WORK}"; else echo "record-hd-demo.sh: kept ${WORK}" >&2; fi' EXIT

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
	bash "proof/docker/record-x11.sh" "proof/scenes/${SCENE}.sh"

mkdir -p assets proof/captures/x11

if [[ ${PUBLISH_TAKE} -eq 1 ]]; then
	# The take is captured at 2560x1440 so the published 1920-wide frame is a
	# downscale rather than an upscale, and text stays sharp after the resample.
	# The full-resolution take itself is not a file to put in a git history: 1440p at
	# crf 20 is hundreds of megabytes for twenty minutes, so the archived copy is
	# 1920 at crf 30.
	ffmpeg -loglevel error -y -i "${WORK}/${SCENE}.mp4" \
		-vf "scale=1920:-2:flags=lanczos" \
		-c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -an \
		"proof/captures/x11/${SCENE}.mp4"
	# Every frame the scene took, published twice: archived at full capture size under
	# proof/captures for the proof page, and resampled to 1920 as the screenshot the
	# landing page carries. This is what makes one take enough. A surface that does not
	# move needs a frame, not a clip, and the frames come free from the session that was
	# already running -- so the gallery costs one recording instead of one per feature.
	# WHAT A MARKS FILE IS FOR HERE. The scene appends one row per shot it takes, so it is an
	# independent record of what the take believed it captured. The loop below copies whatever
	# PNGs exist and nothing else, which means a shot that never landed does not fail the run:
	# it leaves the PREVIOUS take's frame sitting in assets/ and proof/captures, published,
	# timestamped by the copy, and indistinguishable from a fresh one. A gallery whose caption
	# says every frame came from one session cannot be assembled by a step that silently keeps
	# frames from another. So a mark without a frame stops the publish.
	missing=()
	while IFS=$'\t' read -r mark _; do
		[[ -n "${mark}" ]] || continue
		[[ -f "${WORK}/${SCENE}-${mark}.png" ]] || missing+=("${mark}")
	done < "${WORK}/${SCENE}-marks.tsv"
	if [[ ${#missing[@]} -gt 0 ]]; then
		echo "record-hd-demo.sh: the scene marked ${#missing[@]} shot(s) it never wrote: ${missing[*]}" >&2
		echo "record-hd-demo.sh: refusing to publish a set that would keep an older take's frames" >&2
		exit 1
	fi
	for still in "${WORK}/${SCENE}"-*.png; do
		base="$(basename "${still}" .png)"
		cp "${still}" "proof/captures/x11/${base}.png"
		"${IM[@]}" "${still}" -resize 1920x -strip "assets/${base}.png"
	done
	if [[ -f "${WORK}/signature-crosscheck.txt" ]]; then
		cp "${WORK}/signature-crosscheck.txt" "proof/captures/x11/${SCENE}-signature-crosscheck.txt"
		echo "--- the signature anyone can check ---"
		cat "${WORK}/signature-crosscheck.txt"
	fi
fi

if [[ "${STILL}" == "all" ]]; then
	# Every frame, for a scene that exists to take frames. Named after the scene and the
	# shot, so a surface added to the scene arrives as an asset without a recipe change.
	shopt -s nullglob
	published=0
	for still in "${WORK}/${SCENE}"-*.png; do
		base="$(basename "${still}" .png)"
		cp "${still}" "proof/captures/x11/${base}.png"
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
python3 proof/hero-cut.py "${WORK}/${SCENE}.mp4" \
	--mp4 "${WORK}/${SCENE}-cut.mp4" --webp "${ASSET}" \
	--width 2560 --webp-width 1920 "${CUT_ARGS[@]}"

if [[ "${SCENE}" == "demo-hd" ]]; then
	# The website band carries the hero and nothing else.
	cp assets/demo-hd.webp website/demo-hd.webp
fi

python3 proof/tighten.py audit --base proof/captures
ls -la "${ASSET}"
