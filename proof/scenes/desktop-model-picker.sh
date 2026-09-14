#!/usr/bin/env bash
# Open the desktop model picker on this machine's credentials and read back how
# much of the catalog it offers.
#
# Records visual evidence for:
#   1. picker-closed (the composer with no overlay, the baseline both readings
#      are measured against)
#   2. query-gpt     (the picker searched for a provider the recorder holds no
#      credential for)
#   3. query-qwen    (the picker searched for the one provider it can run)
#
# THE CLAIM. The list holds the models a turn could run. The host built it from
# the whole bundled catalog instead -- 5234 models across 62 providers on the
# machine this branch was written on, of which 4186 across 49 providers held no
# credential -- so four fifths of the picker were rows that fail at the first
# prompt, and selecting one persisted it as the model in effect. The recorder's
# profile holds one provider, the local llama.cpp server its models.yml
# declares, and no other credential of any kind.
#
# THE ARMS. Before, searching the picker for `gpt` lists rows: the catalog's
# OpenAI, Azure and OpenRouter models, none of which this machine can send a
# turn to. After, that search lists nothing, and searching for `qwen` still
# lists the local models, so the list shrank to what the machine holds rather
# than emptying.
#
# WHAT IS MEASURED. The height of what the overlay draws, taken as the bounding
# box of everything that changed against the closed-picker frame inside the
# composer's own column. A row of results is 8 rows tall at the surface's cap
# and a "No matching items" line is one, so the reading separates a list from
# an empty answer without naming a colour or reading a label. The crop excludes
# the queue rail, whose elapsed times tick between any two frames.
#
# The change is inside the host the window talks to, not the executable, so
# both arms share one build and the before arm holds the source:
#
#   proof/docker/record-native.sh proof/scenes/desktop-model-picker.sh
#   SCENE_ARM=before PROOF_BASE_REF=<fix>^ \
#     proof/docker/record-native.sh proof/scenes/desktop-model-picker.sh
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Overlay Draws ─────────────────────────────────────────────────
# The model picker is anchored to the composer's model chip and grows upward,
# so the region it can reach is the composer card's own column between the
# titlebar and the card. Both readings use this one crop.
PICKER_CROP_X="${COMPOSER_CARD_LEFT}"
PICKER_CROP_W="${COMPOSER_CARD_W}"
PICKER_CROP_Y=$(( WIN_Y + TITLEBAR_H ))
PICKER_CROP_H=$(( COMPOSER_CARD_BOTTOM - COMPOSER_BAND_H - PICKER_CROP_Y ))
if [ "${PICKER_CROP_H}" -lt 240 ]; then
	abandon_take "the-overlay-has-room" \
		"the region above the composer card is ${PICKER_CROP_H}px, too short to tell a list from a line"
fi
PICKER_CROP="${PICKER_CROP_W}x${PICKER_CROP_H}+${PICKER_CROP_X}+${PICKER_CROP_Y}"
echo "scene: the picker is read over ${PICKER_CROP}" >&2

# The height of what the overlay drew, as the bounding box of everything that
# changed against the closed-picker frame. A frame that changed nothing has no
# bounding box, which `-trim` reports as a failure and which is a height of 0.
#
# Sets DRAWN_H.
read_overlay() { # <shot>
	local closed="${SCENE_OUT}/${SCENE_NAME}-picker-closed.png"
	local open="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local scratch="${TMPDIR}/frame-compare"
	mkdir -p "${scratch}"
	magick "${closed}" -crop "${PICKER_CROP}" +repage "${scratch}/picker-closed.png"
	magick "${open}" -crop "${PICKER_CROP}" +repage "${scratch}/picker-open.png"
	local box
	box="$(magick "${scratch}/picker-closed.png" "${scratch}/picker-open.png" \
		-compose difference -composite -colorspace Gray -threshold 8% \
		-format '%@' info: 2>/dev/null || true)"
	# `%@` is WxH+X+Y over the lit pixels, or empty when none are lit.
	case "${box}" in
		*x*+*+*) DRAWN_H="${box#*x}"; DRAWN_H="${DRAWN_H%%+*}" ;;
		*) DRAWN_H=0 ;;
	esac
}

# ─── The Closed Composer ─────────────────────────────────────────────────────
# The preamble left the slash palette dismissed and a draft in the composer.
# The draft is cleared first, so what the crop holds is the composer at rest
# and neither reading measures a leftover row of slash commands.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
click
pause 0.3
k "ctrl+a"
k "BackSpace"
pause 0.6
shot picker-closed

# ─── A Provider This Machine Holds No Credential For ─────────────────────────
k "ctrl+shift+m"
pause 1.0
t "gpt"
pause 1.2
shot query-gpt
read_overlay query-gpt
GPT_H="${DRAWN_H}"
k "Escape"
pause 0.6

# ─── The Provider It Can Run ─────────────────────────────────────────────────
k "ctrl+shift+m"
pause 1.0
t "qwen"
pause 1.2
shot query-qwen
read_overlay query-qwen
QWEN_H="${DRAWN_H}"
k "Escape"
pause 0.4

# A search that lists the machine's own models is what proves the picker is
# drawn at all: without it a collapsed `gpt` reading could be an overlay that
# never opened.
if [ "${QWEN_H}" -lt 120 ]; then
	abandon_take "the-picker-opened" \
		"searching for the local provider drew ${QWEN_H}px, so the picker never listed anything"
fi

ARM="${SCENE_ARM:-after}"
if [ "${ARM}" = "before" ]; then
	# Both searches list rows, because the catalog is offered whole: the two
	# readings are the same list at the surface's own cap.
	if [ "${GPT_H}" -lt $(( QWEN_H * 3 / 5 )) ]; then
		abandon_take "the-catalog-is-offered-whole" \
			"the before arm drew ${GPT_H}px for gpt against ${QWEN_H}px for qwen, so it was already filtered"
	fi
else
	# The search lists nothing: an empty answer is one line, and a list of rows
	# is several times that.
	if [ "${GPT_H}" -ge $(( QWEN_H / 2 )) ]; then
		abandon_take "the-catalog-is-filtered" \
			"the after arm drew ${GPT_H}px for gpt against ${QWEN_H}px for qwen, so it still offers what it cannot run"
	fi
fi

echo "scene: ${ARM} arm -- searching for gpt drew ${GPT_H}px and searching for qwen drew ${QWEN_H}px" >&2
