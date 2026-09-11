#!/usr/bin/env bash
# Drag across the words of a turn and take the sentence out of the window.
#
# Records visual evidence for:
#   1. the-answer-is-in-the-transcript (the prompt sent and answered, composer empty)
#   2. the-sentence-is-selected        (one drag later, the words drawn selected)
#   3. the-selection-is-in-the-editor  (the copy chord and one paste later)
#
# THE CLAIM. A reader can select the words the transcript drew. The turn menu
# copies a whole turn, which is the answer for a turn and no answer at all for
# one sentence of it, one path out of a refusal, or one line of a command's
# output: a reader who wanted a path retyped it from the screen. A press and a
# drag select what the pointer crossed, the selection is drawn where it is, and
# the copy chord puts exactly those words on the clipboard.
#
# In the other arm the same press and the same travel select nothing, so the
# second frame is the transcript as it was and the third is a paste of whatever
# the clipboard held, which is nothing.
#
# WHAT MAKES THE READING EXACT. The words dragged over are the operator's own
# prompt, whose sentence this scene typed, so the copy has a reference the take
# already carries: the editor holding that sentence before it was sent. The
# paste is read against that rectangle, and the claim is that the two are the
# same drawing -- the same sentence, in the same place, in the same face --
# rather than that some ink arrived. A selection that took half the sentence,
# the turn below it, or the row beside it lands far outside the ceiling.
#
# Both arms are seeded the same way:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-text-select.sh
#
# and the other arm against a build from before the transcript answered a
# pointer. That change is inside the executable, so the arm holds no source:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-text-select.sh
#
# WHERE THE WORDS ARE IS READ, NOT COUNTED. The operator's own turn is the one
# thing the column draws on a fill, so `measure-frame.py filled-box` reports
# the rectangle that fill occupies wherever the window put it, and the drag
# computes its own two ends inside that rectangle. A transcript is anchored to
# its foot, so an aim counted down from the column's top would land in the
# empty space a short session leaves above it. The travel runs along the line
# the bubble holds, because the window reports a position only while the
# pointer is over the text: a travel that crosses the padding stops selecting
# where it crossed it.
#
# NOT RECORDED HERE: which offset a press resolves to inside a wrapped line, a
# right-to-left run, a combining accent, a cluster joined by a zero-width
# joiner and a line the pane truncated; the shift-click that extends a
# selection; the chord that takes a whole entry; and each block kind's spans.
# Those are the three suites under
# `crates/veyyon-desktop-surface/tests/` that open with
# `a-drag-over-the-transcript-`, `the-copy-chord-takes-` and
# `every-block-states-its-spans-`, over the boxes a frame recorded, sweeping
# every block shape the transcript draws.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
echo "scene: recording the ${ARM} arm" >&2

WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# ─── The Editor The Words Come Back Into ─────────────────────────────────────
# The composer card above its footer row: the footer's own top, less the gap
# the card keeps, down to the top of the card's text area. Reading the editor
# and not the whole band keeps the footer's chips, the run bar and the
# transcript's last block out of the count.
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
SELECT_PROMPT="answer in one short sentence: what does a linker do?"

# The role the transcript tokens name for an operator's own turn, read from the
# theme this checkout ships rather than restated as a literal, so a retheme
# moves the aim with it.
read -r USER_TURN_ROLE USER_TURN_FILL < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
surface = tomllib.loads((root / "tokens" / "surface" / "transcript.toml").read_text())
roles = tomllib.loads((root / "themes" / "dark.toml").read_text())["role"]
name = surface["user_turn"]["ground"]
print(name, roles[name])
PY
)
if [ -z "${USER_TURN_FILL:-}" ]; then
	abandon_take "the-fill-is-known" \
		"no colour resolved for the role the transcript fills an operator's turn with"
fi
echo "scene: an operator's turn is filled ${USER_TURN_ROLE} at ${USER_TURN_FILL}" >&2

# A selection is drawn as a fill behind the words, so it repaints the line box
# and not the glyphs: a line of this sentence covers thousands of pixels. The
# floor is under one such line.
SELECTION_MIN_PIXELS=1500
# A drag that selects nothing leaves the turn as it was. Nothing in the bubble
# moves, and the caret the press took away from the composer is outside this
# rectangle.
SELECTION_MAX_PIXELS=400
# How many times the drag is repeated while the window is still settling after
# the turn it just ran.
DRAG_ATTEMPTS=4
# How far inside the fill the two ends of the travel sit, so a press lands on
# the words and not on the bubble's own padding.
DRAG_INSET_PX=14
# What one line of a prompt and the bubble's padding fill: a body line is 18px
# and the bubble keeps 14 above and below it. A taller bubble wrapped.
ONE_LINE_MAX_PX=60
# A line of the prompt's own prose, back in the editor.
EDITOR_MIN_PIXELS=600
# A caret is two pixels wide and one line tall, and it is the only thing an
# empty editor draws that a full one does not draw over.
EDITOR_MAX_PIXELS=120
# What the same sentence, drawn twice in the same place, may differ by: the
# caret is the one thing that moves between the two readings, at two pixels
# wide and one line tall, so a blink phase that differs between them accounts
# for 36 pixels and antialiasing is settled by the fuzz the compare already
# carries. One character dropped off the end of the selection cost 66, which
# is what this ceiling sits under: a paste that is the sentence less its
# question mark is not the words the drag crossed.
SAME_WORDS_MAX_PIXELS=55

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

MEASURE="${BASH_SOURCE[0]%/*}/measure-frame.py"

operator_box() { # <frame> -> <top> <left> <height> <width>
	python3 "${MEASURE}" filled-box "$1" "${SESSION_REGION_X}" "$(( WIN_Y + TITLEBAR_H ))" \
		"${SESSION_REGION_W}" "$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))" "${USER_TURN_FILL}"
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

type_prompt "${SELECT_PROMPT}"
move_px "${PARK_X}" "${PARK_Y}"
pause 0.6
TYPED="${PROBE_DIR}/text-select-typed.png"
probe_frame "${TYPED}"
k "Return"

if ! native_session_ready finished 2; then
	abandon_take "the-turn-ran" \
		"the session did not reach a finished turn, so there is no transcript to select in"
fi
pause 1.5

move_px "${PARK_X}" "${PARK_Y}"
pause 1.0
shot the-answer-is-in-the-transcript
BEFORE_SELECT="${SCENE_OUT}/${SCENE_NAME}-the-answer-is-in-the-transcript.png"

# ─── 2. Drag Across The Words ────────────────────────────────────────────────
# The rectangle the operator's turn fills is what the travel is computed from:
# along the line the bubble holds, from inside its left padding to inside its
# right. A drag whose head runs past the last glyph lands on the end of the
# line, which is what makes the whole sentence the selection rather than as
# much of it as the pointer stopped on.
#
# THE TRAVEL STAYS ON THE LINE. The window reports a position while the
# pointer is over the text and nothing once it has left, so a travel that
# crosses the bubble's padding stops selecting where it crossed it: a diagonal
# from the top of the bubble to its foot ended the selection at the padding and
# pasted the 62% of the sentence the pointer had reached by then. The prompt
# this scene types is one line at the width the recorder opens, which is what
# the height is read for: a bubble that wrapped is a different gesture and
# abandons the take rather than pasting part of a sentence.
read -r TURN_TOP TURN_LEFT TURN_H TURN_W < <(operator_box "${BEFORE_SELECT}") || \
	abandon_take "the-operator-turn-is-readable" \
		"the operator's own turn was not readable out of the frame the selection is taken from"
echo "scene: the operator's turn fills ${TURN_W}x${TURN_H}+${TURN_LEFT}+${TURN_TOP}" >&2
if (( TURN_W < 120 || TURN_H < 20 )); then
	abandon_take "the-operator-turn-is-draggable" \
		"the operator's turn came to ${TURN_W}x${TURN_H}, which is not a rectangle a sentence is dragged across"
fi
if (( TURN_H > ONE_LINE_MAX_PX )); then
	abandon_take "the-prompt-is-one-line" \
		"the operator's turn came to ${TURN_H}px tall, over the ${ONE_LINE_MAX_PX} one line and its padding fill, so the sentence wrapped and a travel along one line would cross part of it"
fi

DRAG_Y=$(( TURN_TOP + TURN_H / 2 ))
DRAG_FROM_X=$(( TURN_LEFT + DRAG_INSET_PX ))
DRAG_FROM_Y="${DRAG_Y}"
DRAG_TO_X=$(( TURN_LEFT + TURN_W - DRAG_INSET_PX ))
DRAG_TO_Y="${DRAG_Y}"
TURN_CROP="${TURN_W}x${TURN_H}+${TURN_LEFT}+${TURN_TOP}"
echo "scene: the drag runs ${DRAG_FROM_X}+${DRAG_FROM_Y} to ${DRAG_TO_X}+${DRAG_TO_Y}" >&2

DRAGGED="${PROBE_DIR}/text-select-dragged.png"

drag_the_sentence() { # -> the pixels the drag repainted in the turn
	local painted
	drag_px "${DRAG_FROM_X}" "${DRAG_FROM_Y}" "${DRAG_TO_X}" "${DRAG_TO_Y}"
	pause 0.8
	probe_frame "${DRAGGED}"
	painted="$(frames_differ_pixels_at "${BEFORE_SELECT}" "${DRAGGED}" "${TURN_CROP}")"
	printf '%s' "${painted}"
}

SELECTION_PX=0
for attempt in $(seq 1 "${DRAG_ATTEMPTS}"); do
	SELECTION_PX="$(drag_the_sentence)"
	echo "scene: the drag repainted ${SELECTION_PX}px of the turn, on attempt ${attempt}" >&2
	if [ "${SELECTION_PX}" -ge "${SELECTION_MIN_PIXELS}" ]; then
		break
	fi
	pause 1.0
done
move_px "${PARK_X}" "${PARK_Y}"
pause 0.6
shot the-sentence-is-selected

case "${ARM}" in
	after)
		if [ "${SELECTION_PX}" -lt "${SELECTION_MIN_PIXELS}" ]; then
			abandon_take "the-sentence-is-selected" \
				"the drag repainted ${SELECTION_PX}px of the turn, under the ${SELECTION_MIN_PIXELS} a selected line of this sentence fills, so nothing was selected"
		fi
		;;
	before)
		if [ "${SELECTION_PX}" -gt "${SELECTION_MAX_PIXELS}" ]; then
			abandon_take "the-sentence-stays-unselected" \
				"the drag repainted ${SELECTION_PX}px of the turn, over the ${SELECTION_MAX_PIXELS} a settling transcript accounts for, so something was drawn in the arm that draws nothing"
		fi
		;;
	*)
		abandon_take "the-arm-is-known" "SCENE_ARM=${ARM} is neither arm of this scene"
		;;
esac

# ─── 3. Put The Selection In The Composer ────────────────────────────────────
# The paste is what makes the clipboard visible: the words are drawn in the one
# surface of the window that draws what it holds, so the frame states the copy
# rather than a report about it. The chord is the same press in both arms, and
# in the arm with no selection it has nothing to write.
k "ctrl+c"
pause 0.6
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.4
click
k "ctrl+v"
pause 1.5
move_px "${PARK_X}" "${PARK_Y}"
pause 1.0
shot the-selection-is-in-the-editor
AFTER_SELECT="${SCENE_OUT}/${SCENE_NAME}-the-selection-is-in-the-editor.png"

PASTED_PX="$(frames_differ_pixels_at "${BEFORE_SELECT}" "${AFTER_SELECT}" "${EDITOR_CROP}")"
SAME_PX="$(frames_differ_pixels_at "${TYPED}" "${AFTER_SELECT}" "${EDITOR_CROP}")"
echo "scene: the paste drew ${PASTED_PX}px in the editor, ${SAME_PX}px away from the sentence as it was typed" >&2

case "${ARM}" in
	after)
		if [ "${PASTED_PX}" -lt "${EDITOR_MIN_PIXELS}" ]; then
			abandon_take "the-selection-is-in-the-editor" \
				"the paste drew ${PASTED_PX}px in the editor, under the ${EDITOR_MIN_PIXELS} a line of prose inks, so nothing was taken out of the window"
		fi
		if [ "${SAME_PX}" -gt "${SAME_WORDS_MAX_PIXELS}" ]; then
			abandon_take "the-words-are-the-ones-crossed" \
				"the paste is ${SAME_PX}px away from the sentence this scene typed, over the ${SAME_WORDS_MAX_PIXELS} a caret accounts for, so what came back is not the words the drag crossed"
		fi
		echo "scene: after arm -- the sentence came back ${SAME_PX}px from how it was typed" >&2
		;;
	before)
		if [ "${PASTED_PX}" -gt "${EDITOR_MAX_PIXELS}" ]; then
			abandon_take "the-editor-stays-empty" \
				"the paste drew ${PASTED_PX}px in the editor, over the ${EDITOR_MAX_PIXELS} a caret accounts for, so the arm with nothing selected pasted something"
		fi
		echo "scene: before arm -- the paste left ${PASTED_PX}px in the editor" >&2
		;;
esac

# ─── What These Frames State ─────────────────────────────────────────────────
# Frame 1 is the session holding one prompt and its answer, with the composer
# empty: the state a selection is made from.
#
# Frame 2 is the drag, landed. Here the words the pointer crossed are drawn on
# the selection fill, over the two lines the travel ran between. There the same
# travel leaves the transcript as frame 1 drew it, because a press on the words
# reports nothing and the pointer has nothing to select with.
#
# Frame 3 is the clipboard, drawn. Here the editor holds the sentence the drag
# crossed, the same drawing the editor held before it was sent. There the
# editor is empty, because the drag selected nothing, the chord wrote nothing,
# and the clipboard was never written.
#
# WHAT IS NOT HERE. Which offset a press resolves to inside a wrapped line, a
# right-to-left run and a joined cluster, and what a second application reads
# out of the selection, which is the framework's write and not this window's.
