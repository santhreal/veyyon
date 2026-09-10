#!/usr/bin/env bash
# Fork a session from its own row menu and read what the fork left behind in
# the composer.
#
# Records visual evidence for:
#   1. the-prompt-is-in-the-transcript (the prompt sent, answered, composer empty)
#   2. the-branch-is-offered           (that row's menu, with Branch drawn)
#   3. the-branch-hands-the-prompt-back (one press later)
#
# THE CLAIM. A branch cuts the operator's last prompt off the transcript it
# forks: the fork keeps every entry before that prompt and none from it on.
# The words are then in no transcript the window draws, so the fork hands them
# back to the composer, where they can be edited and sent again. That is what
# the terminal has always done with the same fork (`agent.branch` returns the
# prompt as `selectedText`, which the editor is filled with) and what the
# desktop did not.
#
# In the other arm the fork is the same fork -- the same entry, the same
# retained prefix, the same new row in the rail -- and the prompt is gone with
# it. The composer is left empty, and the words the fork removed are reachable
# from no surface of the window.
#
# Both arms are seeded the same way:
#
#   SCENE_MOTION_FLOOR=5 proof/docker/record-native.sh \
#     proof/scenes/desktop-branch-draft.sh
#
# and the other arm against a build from before the desktop named the entry and
# read the prompt back. That change is inside the executable, so the arm holds
# no source:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=5 \
#     PROOF_NATIVE_BEFORE_BINARY=<holdback-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-branch-draft.sh
#
# WHAT IS MEASURED. Two rectangles of the window, each read across the same two
# frames.
#   * The transcript column, which both arms must repaint: a fork that kept the
#     transcript is a fork that did not happen, and a differential taken over a
#     window where nothing forked reads as a passing baseline. Both arms are
#     held to the same floor, so the before arm proves it forked and stated
#     nothing rather than proving it did nothing at all.
#   * The composer's editor, which is where the difference is. A line of prose
#     inks some hundreds of pixels there; an empty editor holds a caret, which
#     is two pixels wide and one line tall, so the ceiling the empty arm is held
#     to is above a caret and far under a line.
#
# WHERE THE ROW AND THE MENU ARE IS READ, NOT COUNTED. Both come out of the
# frame through `measure-frame.py`, the same reading `desktop-export-header.sh`
# takes: the rail's selected card by its own fill, and the menu's rows by the
# ground the menu floats on. A menu item is clicked only where its own ink says
# the gate offered it, and the menu is read again afterwards, because a refused
# row swallows the click and leaves the menu standing.
#
# NOT RECORDED HERE: where the host forks, which is
# `packages/coding-agent/test/gui-host/a-branch-forks-at-the-entry-the-desktop-named.test.ts`
# over every prompt on the branch, and which entry the window names, which is
# `crates/veyyon-desktop/tests/a-branch-forks-at-the-prompt-it-hands-back.rs`.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

ARM="${SCENE_ARM:-after}"
echo "scene: recording the ${ARM} arm" >&2

# ─── What A Card Measures ────────────────────────────────────────────────────
# Read from the tokens this checkout ships rather than restated as literals, so
# a retuned row height moves the rectangles the frames are read over.
read -r CARD_PX FOOTER_PX CONTENT_INSET NAV_HEADER_PX QUEUE_CARD_PAD_H < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

tokens = Path(sys.argv[1])
queue = tomllib.loads((tokens / "surface" / "queue.toml").read_text())["geometry"]
scale = tomllib.loads((tokens / "scale.toml").read_text())

gap_below = scale["spacing"][queue["section_layout"]["gap_below"]]
content_inset = scale["spacing"][queue["insets"]["content_inset"]]

print(
    int(queue["row_heights"]["card_px"]),
    int(queue["footer"]["height_px"]),
    int(content_inset),
    int(content_inset + 32 + gap_below),
    int(scale["spacing"][queue["card_layout"]["padding_horizontal"]]),
)
PY
)
if [ -z "${QUEUE_CARD_PAD_H:-}" ]; then
	abandon_take "tokens-resolved" "could not read queue layout tokens"
fi

if [ "${WIN_W}" -le 800 ] || [ "${RAIL_W}" -le 0 ]; then
	abandon_take "rail-drawn" "window width ${WIN_W}px has no queue rail"
fi

RAIL_LEFT=$(( WIN_X + CONTENT_INSET ))
RAIL_LIST_TOP=$(( WIN_Y + TITLEBAR_H + NAV_HEADER_PX ))
RAIL_LIST_BOTTOM=$(( WIN_Y + WIN_H - FOOTER_PX ))
CARD_X=$(( WIN_X + RAIL_W / 2 ))
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

# ─── The Editor The Prompt Comes Back Into ───────────────────────────────────
# The editor is the composer card above its footer row: the footer's own top,
# less the gap the card keeps between them, down to the top of the card's text
# area. Reading the editor and not the whole band keeps the footer's chips, the
# run bar and the transcript's last block out of the count.
FOOTER_ROW_H=32
FOOTER_TOP=$(( COMPOSER_CARD_BOTTOM - CARD_PAD_BOTTOM - FOOTER_ROW_H ))
EDITOR_TOP=$(( COMPOSER_EDITOR_Y - GUTTER_PX ))
EDITOR_H=$(( FOOTER_TOP - GUTTER_PX - EDITOR_TOP ))
EDITOR_X=$(( COMPOSER_CARD_LEFT + CARD_PAD_H ))
EDITOR_W=$(( COMPOSER_CARD_W - 2 * CARD_PAD_H ))
if (( EDITOR_H < 16 || EDITOR_W < 200 )); then
	abandon_take "the-editor-is-a-rectangle" \
		"a ${EDITOR_W}x${EDITOR_H} editor is too small to read a line of prose out of"
fi
EDITOR_CROP="${EDITOR_W}x${EDITOR_H}+${EDITOR_X}+${EDITOR_TOP}"
echo "scene: the prompt comes back into ${EDITOR_CROP}" >&2

TRANSCRIPT_CROP="${SESSION_REGION_W}x$(( WIN_H - TITLEBAR_H - COMPOSER_BAND_H ))+${SESSION_REGION_X}+$(( WIN_Y + TITLEBAR_H ))"

# The prompt the fork cuts. Long enough that the words it inks are a reading
# and not a rounding, and phrased so the model answers it in one short turn.
BRANCH_PROMPT="answer in one short sentence: what does a linker do?"

MENU_MIN_PIXELS=2000
MENU_ITEMS=8
# `Open`, `Park`, `Defer`, `Branch`, `Export`, `Compact`, `Handoff`, `Delete`.
BRANCH_ITEM=4
# What share of the menu's first row -- `Open`, the one item no gate decides --
# an offered answer is inked to. A refused one is drawn at 0.6 or 0.4 of its
# strength (§4.3), which lands far under this.
OFFERED_MIN_STRENGTH=85
# How many times the menu is reopened while the host is still answering
# whatever made the answer wait.
OFFER_ATTEMPTS=4
# A fork replaces the transcript with the prefix it kept, which repaints the
# turn that was drawn there. The floor is under one line of that turn.
TRANSCRIPT_MIN_PIXELS=400
# A line of the prompt's own prose, back in the editor.
EDITOR_MIN_PIXELS=600
# A caret is two pixels wide and one line tall, and it is the only thing an
# empty editor draws that a full one does not draw over.
EDITOR_MAX_PIXELS=120

PROBE_DIR="${SCENE_RUNTIME_DIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

MEASURE="${BASH_SOURCE[0]%/*}/measure-frame.py"

selected_card() { # <frame> -> <top> <left>
	python3 "${MEASURE}" selected-card "$1" "${RAIL_LEFT}" "${RAIL_LIST_TOP}" \
		"$(( RAIL_W - 2 * CONTENT_INSET ))" "$(( RAIL_LIST_BOTTOM - RAIL_LIST_TOP ))" "${CARD_PX}"
}

menu_item() { # <frame-with-menu> <origin-x> <origin-y> <item-index> -> <y> <x> <strength>
	python3 "${MEASURE}" menu-rows "$1" "$2" "$3" "${MENU_ITEMS}" "$4" "$(( WIN_Y + WIN_H ))"
}

# ─── 1. Say Something The Fork Can Cut ───────────────────────────────────────
# The preamble leaves a slash in the editor from the palette it opened, and
# `type_prompt` clears the editor before it types, so the prompt below is the
# whole of what the session holds from the operator.
submit_prompt "${BRANCH_PROMPT}"
if ! native_session_ready finished 2; then
	abandon_take "the-prompt-was-answered" \
		"the prompt was not answered within 90s, so the session holds no turn for a fork to cut"
fi
pause 1.5

# The pointer rests on the editor for both readings, so no row of the rail and
# no chip of the footer carries a hover fill in one frame and not the other.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 1.0
shot the-prompt-is-in-the-transcript
BEFORE_FORK="${SCENE_OUT}/${SCENE_NAME}-the-prompt-is-in-the-transcript.png"

# ─── 2. Find The Row The Window Is On ────────────────────────────────────────
# The session just prompted is the session the window is on, so it is the card
# the rail fills, and it is the row the fork is taken from.
read -r CARD_TOP FILL_LEFT < <(selected_card "${BEFORE_FORK}") || \
	abandon_take "the-session-on-screen-is-drawn-as-selected" \
		"the rail's selected card was not readable out of the frame the fork is taken from"
echo "scene: the window is on the card at ${CARD_TOP}px, filled from ${FILL_LEFT}px" >&2
MENU_ORIGIN_Y=$(( CARD_TOP + CARD_PX / 2 ))

# ─── 3. Open That Row's Menu ─────────────────────────────────────────────────
ROW_HOVERED="${PROBE_DIR}/branch-row-hovered.png"
MENU_OPEN="${PROBE_DIR}/branch-menu-open.png"

open_row_menu() { # -> 0 once the menu is drawn over the row
	local drawn
	move_px "${CARD_X}" "${MENU_ORIGIN_Y}"
	pause 0.5
	probe_frame "${ROW_HOVERED}"
	right_click
	pause 0.8
	probe_frame "${MENU_OPEN}"
	drawn="$(frames_differ_pixels_at "${ROW_HOVERED}" "${MENU_OPEN}" "${WINDOW_CROP}")"
	if [ "${drawn}" -lt "${MENU_MIN_PIXELS}" ]; then
		abandon_take "the-row-menu-opened" \
			"the right-click on the row at ${MENU_ORIGIN_Y}px changed ${drawn}px of the window, under the ${MENU_MIN_PIXELS} a menu draws"
	fi
}

BRANCH_Y=0
BRANCH_X=0
BRANCH_STRENGTH=0
for attempt in $(seq 1 "${OFFER_ATTEMPTS}"); do
	open_row_menu
	read -r BRANCH_Y BRANCH_X BRANCH_STRENGTH < <(menu_item "${MENU_OPEN}" "${CARD_X}" "${MENU_ORIGIN_Y}" "${BRANCH_ITEM}") || \
		abandon_take "the-branch-row-is-locatable" \
			"the ${MENU_ITEMS} rows of the row menu were not readable out of the frame it opened in"
	if [ "${BRANCH_STRENGTH}" -ge "${OFFERED_MIN_STRENGTH}" ]; then
		echo "scene: the Branch row is offered, inked to ${BRANCH_STRENGTH}% of the menu's first row, on attempt ${attempt}" >&2
		break
	fi
	echo "scene: the Branch row is inked to ${BRANCH_STRENGTH}% of the menu's first row, which is an answer the gate refused; waiting for the host" >&2
	k Escape
	pause 2.0
done
if [ "${BRANCH_STRENGTH}" -lt "${OFFERED_MIN_STRENGTH}" ]; then
	abandon_take "the-branch-row-is-offered" \
		"the Branch row stayed inked to ${BRANCH_STRENGTH}% of the menu's first row over ${OFFER_ATTEMPTS} attempts, under the ${OFFERED_MIN_STRENGTH} an offered answer draws, so a click on it answers nothing"
fi
shot the-branch-is-offered

# ─── 4. Take The Fork ────────────────────────────────────────────────────────
move_px "${BRANCH_X}" "${BRANCH_Y}"
pause 0.4
click
pause 3.0

MENU_CLOSED="${PROBE_DIR}/branch-menu-closed.png"
probe_frame "${MENU_CLOSED}"
MENU_GONE_PX="$(frames_differ_pixels_at "${MENU_OPEN}" "${MENU_CLOSED}" "${WINDOW_CROP}")"
if [ "${MENU_GONE_PX}" -lt "${MENU_MIN_PIXELS}" ]; then
	abandon_take "the-row-menu-closed" \
		"the click on Branch changed ${MENU_GONE_PX}px of the window, under the ${MENU_MIN_PIXELS} closing the menu draws, so the menu is still open over the rail"
fi

# ─── 5. What The Fork Left Behind ────────────────────────────────────────────
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 1.5
shot the-branch-hands-the-prompt-back
AFTER_FORK="${SCENE_OUT}/${SCENE_NAME}-the-branch-hands-the-prompt-back.png"

TRANSCRIPT_PX="$(frames_differ_pixels_at "${BEFORE_FORK}" "${AFTER_FORK}" "${TRANSCRIPT_CROP}")"
EDITOR_PX="$(frames_differ_pixels_at "${BEFORE_FORK}" "${AFTER_FORK}" "${EDITOR_CROP}")"
echo "scene: the fork repainted ${TRANSCRIPT_PX}px of the transcript and ${EDITOR_PX}px of the editor" >&2

# The fork happened in both arms or neither reading means anything, so this is
# read once and not per arm.
if [ "${TRANSCRIPT_PX}" -lt "${TRANSCRIPT_MIN_PIXELS}" ]; then
	abandon_take "the-fork-cut-the-transcript" \
		"the transcript changed ${TRANSCRIPT_PX}px across the fork, under the ${TRANSCRIPT_MIN_PIXELS} dropping a turn draws, so no fork was taken"
fi

case "${ARM}" in
	before)
		if [ "${EDITOR_PX}" -gt "${EDITOR_MAX_PIXELS}" ]; then
			abandon_take "the-baseline-hands-nothing-back" \
				"the baseline put ${EDITOR_PX}px into the editor across the fork, over the ${EDITOR_MAX_PIXELS} an empty editor's caret draws, so this arm is not the state the fix changed"
		fi
		echo "scene: before arm -- the fork left ${EDITOR_PX}px in the editor" >&2
		;;
	*)
		if [ "${EDITOR_PX}" -lt "${EDITOR_MIN_PIXELS}" ]; then
			abandon_take "the-fork-hands-the-prompt-back" \
				"the fork put ${EDITOR_PX}px into the editor, under the ${EDITOR_MIN_PIXELS} a line of the prompt inks, so the words it cut came back to nothing"
		fi
		echo "scene: after arm -- the fork handed ${EDITOR_PX}px of prompt back to the editor" >&2
		;;
esac

# ─── What These Frames State ─────────────────────────────────────────────────
# Frame 1 is the session holding one prompt and its answer, with the composer
# empty: the state a fork is taken from.
#
# Frame 2 is that row's own menu, with `Branch` drawn at full strength, which
# is the gate stating the answer is offered rather than the window drawing a
# row that answers nothing.
#
# Frame 3 is the window one press later. The transcript is the fork's, which
# stops before the prompt, in both arms. Here the prompt is in the composer,
# ready to be edited and sent down the new branch. There the composer is empty
# and the words are gone with the turn.
#
# WHAT IS NOT HERE. The fork's own file -- the entries it kept, the source it
# left whole -- which is the host suite named above; and a fork taken from a
# row the window is not on, which forks the same way and hands nothing back,
# because the prompt it cut belongs to a transcript that is not on screen.
