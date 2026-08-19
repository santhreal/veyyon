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
# The dense 32B, in the one window its server serves. It drives a tool turn more
# directly than the sparse 30B, and a row is read by someone deciding whether this
# product works, so the slower model is the right trade: the recording is cut down
# to its moments either way.
DEMO_MODEL="${DEMO_MODEL:-local/demo-qwen3-32b-32k}"
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
	ASSET=assets/demo-settings-hd.webp
	PUBLISH_TAKE=0
	CUT_ARGS=(--single --scene-score 0.004 --speed 1.4)
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
	# Automatic maintenance is off for this row: the window is 32k, the prompt with the
	# server's statements is about 20k of it, so compaction fires on the first turn and
	# reports it cannot free enough to help. Two short turns need no maintenance, and
	# the row that is about maintenance is the compaction row.
	SETTINGS=$'lsp.enabled: true\ncompaction.enabled: false'
	CUT_ARGS=()
	;;
prompt-architecture)
	ASSET=assets/demo-prompt-hd.webp
	PUBLISH_TAKE=0
	# Two subcommands printing tables, so the terminal runs a shell and the cut has
	# no streaming to wait through.
	SCENE_CMD="bash -l"
	CUT_ARGS=(--speed 1.6)
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
trap 'rm -rf "${WORK}"' EXIT

PROOF_LLM_BASE_URL="${PROOF_LLM_BASE_URL}" \
	SCENE_HIDE_THINKING="${HIDE_THINKING}" \
	SCENE_COMMAND="${SCENE_CMD}" \
	SCENE_THEME=night \
	SCENE_WIDTH=1920 \
	SCENE_HEIGHT=1080 \
	SCENE_FONT_SIZE=16 \
	SCENE_BG="#1a1b26" \
	SCENE_FG="#c0caf5" \
	SCENE_SETTLE_SCALE="${SETTLE_SCALE:-2}" \
	SCENE_GIF=0 \
	SCENE_SETTINGS="${SETTINGS}" \
	OUT_DIR="${WORK}" \
	bash "proof/docker/record-x11.sh" "proof/scenes/${SCENE}.sh"

mkdir -p assets proof/captures/x11

if [[ ${PUBLISH_TAKE} -eq 1 ]]; then
	# 1920x1080 at crf 20 is 71 MB for seven minutes, which is not a file to put in
	# a git history; 1280 at crf 30 is the same seven minutes at a size the page
	# can serve.
	ffmpeg -loglevel error -y -i "${WORK}/${SCENE}.mp4" \
		-vf "scale=1280:-2:flags=lanczos" \
		-c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -an \
		"proof/captures/x11/${SCENE}.mp4"
	for still in "${WORK}/${SCENE}"-*.png; do
		cp "${still}" "proof/captures/x11/$(basename "${still}")"
	done
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
	--mp4 "${WORK}/${SCENE}-cut.mp4" --webp "${ASSET}" "${CUT_ARGS[@]}"

if [[ "${SCENE}" == "demo-hd" ]]; then
	# The website band carries the hero and nothing else.
	cp assets/demo-hd.webp website/demo-hd.webp
fi

python3 proof/tighten.py audit --base proof/captures
ls -la "${ASSET}"
