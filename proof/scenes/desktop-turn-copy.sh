#!/usr/bin/env bash
# Take a transcript turn out of the window and put it back into the composer.
#
# Records visual evidence for:
#   1. the-turn-is-in-the-transcript  (the prompt sent and answered, composer empty)
#   2. the-turn-offers-to-be-copied   (that turn's menu, with Copy drawn)
#   3. the-turn-is-back-in-the-editor (one press and one paste later)
#
# THE CLAIM. A reader can take an agent's words out of the window. The composer
# owned the only clipboard write in the product, so its own draft could be
# copied and nothing else could: a turn's prose, the command a tool ran, the
# path it named, a refusal. A right-click on a turn offers `Copy`, and the words
# it writes are the words the turn states.
#
# In the other arm the right-click is the same press on the same turn and
# nothing opens, so the third frame is a paste of whatever the clipboard held,
# which is nothing.
#
# WHAT MAKES THE READING EXACT. The turn pressed is the operator's own prompt,
# whose words this scene typed, so the copy has a reference the frame already
# carries: the editor holding that sentence before it was sent. The paste is
# read against that rectangle, and the claim is that the two are the same
# drawing -- the same sentence, in the same place, in the same face -- rather
# than that some ink arrived. A copy that took the turn below it, or half the
# sentence, or the tool row beside it, lands far outside the ceiling.
#
# Both arms are seeded the same way:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-turn-copy.sh
#
# and the other arm against a build from before a turn could be copied. That
# change is inside the executable, so the arm holds no source:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-turn-copy.sh
#
# WHERE THE TURN AND THE MENU ARE IS READ, NOT COUNTED. Both come out of the
# frame through `measure-frame.py filled-band`: the operator's own turn is the
# one thing the column draws on a fill, and the menu is the one floated surface
# over the transcript, so each is found by its own colour wherever the window
# put it. A transcript is anchored to its foot, so an aim counted down from the
# column's top would land in the empty space a short session leaves.
#
# NOT RECORDED HERE: which turn the pointer resolves to, every block kind's
# words and the guards around an empty copy, which are
# `crates/veyyon-desktop-surface/tests/a-turn-the-window-drew-can-be-taken-out-of-it.rs`
# over the boxes a frame recorded, each block shape and each arm of the turn
# union.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
echo "scene: recording the ${ARM} arm" >&2

WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# ─── The Editor The Words Come Back Into ─────────────────────────────────────
# The composer card above its footer row, which is the same rectangle
# `desktop-branch-draft.sh` reads a restored prompt over: the footer's own top,
# less the gap the card keeps, down to the top of the card's text area. Reading
# the editor and not the whole band keeps the footer's chips, the run bar and
# the transcript's last block out of the count.
FOOTER_ROW_H=32
FOOTER_TOP=$(( COMPOSER_CARD_BOTTOM - CARD_PAD_BOTTOM - FOOTER_ROW_H ))
EDITOR_TOP=$(( COMPOSER_EDITOR_Y - GUTTER_PX ))
EDITOR_H=$(( FOOTER_TOP - GUTTER_PX - EDITOR_TOP ))
EDITOR_X=$(( COMPOSER_CARD_LEFT + CARD_PAD_H ))
EDITOR_W=$(( COMPOSER_CARD_W - 2 * CARD_PAD_H ))
if (( EDITOR_H < 16 || EDITOR_W < 200 )); then
	abandon_take "the-editor-is-measurable" \
		"the composer's editor came to ${EDITOR_W}x${EDITOR_H}, which is not a rectangle a line of prose is read over"
fi
EDITOR_CROP="${EDITOR_W}x${EDITOR_H}+${EDITOR_X}+${EDITOR_TOP}"
echo "scene: the words come back into ${EDITOR_CROP}" >&2

# The prompt the turn holds. One sentence, long enough that the ink it draws is
# a reading and not a rounding, and phrased so the model answers it in one
# short turn.
COPY_PROMPT="answer in one short sentence: what does a linker do?"

# Two colours this scene aims by, read from the theme this checkout ships
# rather than restated as literals, so a retheme moves both aims with it: the
# role the transcript tokens name for an operator's own turn, and the role a
# floated surface is drawn at, which is what the menu is.
read -r USER_TURN_ROLE USER_TURN_FILL MENU_FILL < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
surface = tomllib.loads((root / "tokens" / "surface" / "transcript.toml").read_text())
roles = tomllib.loads((root / "themes" / "dark.toml").read_text())["role"]
name = surface["user_turn"]["ground"]
print(name, roles[name], roles["float"])
PY
)
if [ -z "${MENU_FILL:-}" ]; then
	abandon_take "the-fills-are-known" \
		"no colour resolved for the role the transcript fills an operator's turn with"
fi
echo "scene: an operator's turn is filled ${USER_TURN_ROLE} at ${USER_TURN_FILL}," \
	"a floated menu at ${MENU_FILL}" >&2

# A menu of one row: the row is the menu, so the box the menu fills is the
# control the press lands on.
# A menu is a surface floated over the transcript, so opening one repaints far
# more than a row of the rail does. The floor is under one such menu.
MENU_MIN_PIXELS=2000
# A press that opens nothing leaves the window as it was, apart from whatever
# the caret and a hover fill move.
MENU_MAX_PIXELS=400
# How many times the press is repeated while the window is still settling after
# the turn it just ran.
OFFER_ATTEMPTS=4
# A line of the prompt's own prose, back in the editor.
EDITOR_MIN_PIXELS=600
# A caret is two pixels wide and one line tall, and it is the only thing an
# empty editor draws that a full one does not draw over.
EDITOR_MAX_PIXELS=120
# What the same sentence, drawn twice in the same place, may differ by: the
# caret is the one thing that moves between the two readings, at two pixels
# wide and one line tall, and antialiasing is settled by the fuzz the compare
# already carries.
SAME_WORDS_MAX_PIXELS=200

PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

MEASURE="${BASH_SOURCE[0]%/*}/measure-frame.py"

operator_turn() { # <frame> -> <y> <x>
	python3 "${MEASURE}" filled-band "$1" "${SESSION_REGION_X}" "$(( WIN_Y + TITLEBAR_H ))" \
		"${SESSION_REGION_W}" "$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))" "${USER_TURN_FILL}"
}

# The menu's own box, read over the transcript and not the window: the composer
# card is drawn at the same elevation as a floated surface, so a reading that
# took in the band below would find the card and the menu as one box and aim
# between them.
menu_box() { # <frame> <origin-x> -> <y> <x>
	python3 "${MEASURE}" filled-band "$1" "$2" "$(( WIN_Y + TITLEBAR_H ))" \
		"$(( WIN_X + WIN_W - $2 ))" "$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))" "${MENU_FILL}"
}

# ─── 1. Say Something The Window Can Hand Back ───────────────────────────────
# The preamble leaves a slash in the editor from the palette it opened, and
# `type_prompt` clears the editor before it types, so the prompt below is the
# whole of what the session holds from the operator. The editor is read while
# it still holds the sentence, which is the reference the paste is measured
# against.
#
# The pointer is parked in the empty top of the transcript for every reading,
# so no chip of the footer and no row of the rail carries a hover fill in one
# frame and not another, and nothing the pointer draws lands in the rectangle
# the editor is read over.
PARK_X="${TRANSCRIPT_COLUMN_LEFT}"
PARK_Y=$(( WIN_Y + TITLEBAR_H + 8 ))

type_prompt "${COPY_PROMPT}"
move_px "${PARK_X}" "${PARK_Y}"
pause 0.6
TYPED="${PROBE_DIR}/turn-copy-typed.png"
probe_frame "${TYPED}"
k "Return"

if ! native_session_ready finished 2; then
	abandon_take "the-turn-ran" \
		"the session did not reach a finished turn, so there is no transcript to copy out of"
fi
pause 1.5

move_px "${PARK_X}" "${PARK_Y}"
pause 1.0
shot the-turn-is-in-the-transcript
BEFORE_COPY="${SCENE_OUT}/${SCENE_NAME}-the-turn-is-in-the-transcript.png"

# ─── 2. Offer To Copy That Turn ──────────────────────────────────────────────
# The operator's own turn is the one thing the column draws on a fill, so it is
# found by that fill wherever the column put it. Reading it out of the frame is
# what makes the press land on a turn at all: a transcript is anchored to its
# foot, and a counted aim would reach the empty space a short session leaves
# above it.
read -r TURN_Y TURN_X < <(operator_turn "${BEFORE_COPY}") || \
	abandon_take "the-operator-turn-is-readable" \
		"the operator's own turn was not readable out of the frame the copy is taken from"
echo "scene: the operator's turn is drawn at ${TURN_X}+${TURN_Y}" >&2
MENU_OPEN="${PROBE_DIR}/turn-copy-menu-open.png"

open_turn_menu() { # -> the pixels the press repainted
	local opened
	move_px "${TURN_X}" "${TURN_Y}"
	pause 0.4
	right_click
	pause 1.0
	probe_frame "${MENU_OPEN}"
	opened="$(frames_differ_pixels_at "${BEFORE_COPY}" "${MENU_OPEN}" "${WINDOW_CROP}")"
	printf '%s' "${opened}"
}

MENU_PX=0
for attempt in $(seq 1 "${OFFER_ATTEMPTS}"); do
	MENU_PX="$(open_turn_menu)"
	echo "scene: the press on the turn repainted ${MENU_PX}px, on attempt ${attempt}" >&2
	if [ "${MENU_PX}" -ge "${MENU_MIN_PIXELS}" ]; then
		break
	fi
	pause 1.0
done
shot the-turn-offers-to-be-copied

COPY_Y=0
COPY_X=0
case "${ARM}" in
	after)
		if [ "${MENU_PX}" -lt "${MENU_MIN_PIXELS}" ]; then
			abandon_take "the-turn-offers-to-be-copied" \
				"the press on the turn repainted ${MENU_PX}px, under the ${MENU_MIN_PIXELS} a menu floated over the transcript inks, so nothing was offered"
		fi
		read -r COPY_Y COPY_X < <(menu_box "${MENU_OPEN}" "${TURN_X}") || \
			abandon_take "the-copy-row-is-readable" \
				"the menu's own box was not readable out of the frame the copy is taken from"
		echo "scene: the Copy row is drawn at ${COPY_X}+${COPY_Y}" >&2
		move_px "${COPY_X}" "${COPY_Y}"
		pause 0.4
		click
		pause 1.0
		;;
	before)
		if [ "${MENU_PX}" -gt "${MENU_MAX_PIXELS}" ]; then
			abandon_take "the-turn-offers-nothing" \
				"the press on the turn repainted ${MENU_PX}px, over the ${MENU_MAX_PIXELS} a caret and a hover fill account for, so something opened in the arm that has nothing to open"
		fi
		k "Escape"
		pause 0.6
		;;
	*)
		abandon_take "the-arm-is-known" "SCENE_ARM=${ARM} is neither arm of this scene"
		;;
esac

# ─── 3. Put It Back In The Composer ──────────────────────────────────────────
# The paste is what makes the clipboard visible: the words are drawn in the one
# surface of the window that draws what it holds, so the frame states the copy
# rather than a report about it.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.4
click
k "ctrl+v"
pause 1.5
move_px "${PARK_X}" "${PARK_Y}"
pause 1.0
shot the-turn-is-back-in-the-editor
AFTER_COPY="${SCENE_OUT}/${SCENE_NAME}-the-turn-is-back-in-the-editor.png"

PASTED_PX="$(frames_differ_pixels_at "${BEFORE_COPY}" "${AFTER_COPY}" "${EDITOR_CROP}")"
SAME_PX="$(frames_differ_pixels_at "${TYPED}" "${AFTER_COPY}" "${EDITOR_CROP}")"
echo "scene: the paste drew ${PASTED_PX}px in the editor, ${SAME_PX}px away from the sentence as it was typed" >&2

case "${ARM}" in
	after)
		if [ "${PASTED_PX}" -lt "${EDITOR_MIN_PIXELS}" ]; then
			abandon_take "the-turn-is-back-in-the-editor" \
				"the paste drew ${PASTED_PX}px in the editor, under the ${EDITOR_MIN_PIXELS} a line of prose inks, so nothing was taken out of the window"
		fi
		if [ "${SAME_PX}" -gt "${SAME_WORDS_MAX_PIXELS}" ]; then
			abandon_take "the-words-are-the-turn-s-own" \
				"the paste is ${SAME_PX}px away from the sentence this scene typed, over the ${SAME_WORDS_MAX_PIXELS} a caret accounts for, so what came back is not the words the turn states"
		fi
		echo "scene: after arm -- the turn came back ${SAME_PX}px from how it was typed" >&2
		;;
	before)
		if [ "${PASTED_PX}" -gt "${EDITOR_MAX_PIXELS}" ]; then
			abandon_take "the-editor-stays-empty" \
				"the paste drew ${PASTED_PX}px in the editor, over the ${EDITOR_MAX_PIXELS} a caret accounts for, so the arm with nothing to copy pasted something"
		fi
		echo "scene: before arm -- the paste left ${PASTED_PX}px in the editor" >&2
		;;
esac

# ─── What These Frames State ─────────────────────────────────────────────────
# Frame 1 is the session holding one prompt and its answer, with the composer
# empty: the state a copy is taken from.
#
# Frame 2 is the turn's own menu, offering `Copy` over the words it would take.
# There the same press opens nothing, and the frame is the transcript.
#
# Frame 3 is the clipboard, drawn. Here the editor holds the turn's sentence,
# the same drawing the editor held before it was sent. There the editor is
# empty, because the press took nothing and the clipboard was never written.
#
# WHAT IS NOT HERE. What a second application reads out of the selection, which
# is the framework's write and not this window's; and copying a turn that
# scrolled out of the viewport, which has no box for a press to land in.
