#!/usr/bin/env bash
# Export a session the window is not on, from that row's own context menu, and
# photograph the rail before and after the export.
#
# Records visual evidence for:
#   1. the-export-target-is-another-session (the session on screen, and the row below it)
#   2. the-export-states-the-session-it-opened (the export's own session is the one on screen)
#
# The two frames are the differential. Exporting a session activates it in the
# host, and the client's session pointer follows the host only when a frame says
# so: the after arm answers `ExportSession` with an `ActiveSession` header naming
# the session it activated, so the rail's selection moves onto the exported row
# and the window is on the session whose transcript the export wrote. The before
# arm answers with the export alone, so the host is on one session and the
# window still draws another as selected, and the next transcript or append
# lands under the wrong row.
#
# WHAT IS MEASURED. The export writes a transcript to a file and opens nothing,
# so the only thing either arm draws differently is where the rail's selection
# is, and a whole-window difference is dominated by the age each row states and
# the clock in the footer. Each frame is read twice inside the rail alone, over
# a sliver of each card's own left padding: the card's fill covers its padding
# and no glyph does, so a selection that moved repaints the whole sliver and a
# row whose age ticked from `1s` to `9s` changes none of it.
#
# A REFUSED ANSWER IS NOT A TAKE. A menu item the gate refused swallows the
# click (§4.3), and both arms of a pair taken that way show the export never
# running, which is a differential of nothing that reads as a passing baseline.
# The Export row's own ink states whether it is offered -- a refused item draws
# at a fraction of its strength -- so the take waits out whatever the host is
# answering, reopens the menu, and abandons rather than clicking a row that
# answers nothing. The menu is then read again after the click: an answer that
# took the click closes the menu it was on.
#
# WHERE THE CARDS ARE IS READ, NOT COUNTED. The rail draws whatever sections its
# sessions come to -- a draft in an idle session lifts its row into `Unsent`
# above `Live` -- so a card position counted down from the rail's top lands a
# section out. The selected card is found by its own fill, which is the session
# the window is on, and the export is taken from the row directly below it,
# which is therefore a session the window is not on. A right-click that lands on
# anything but a card opens no menu and the take abandons.
#
# THE AIM IS GUARDED BY THE OTHER ARM. The Export row of the context menu is
# found by reading the menu's own ink out of the frame it opened in -- its ground
# colour, the box that ground fills, and the rows of ink inside it -- rather than
# from an item height written here, so a retheme moves the aim with it. A menu
# whose order changed lands on a neighbouring item, and the neighbours that also
# activate a session (`Compact`, `Handoff`) already stated their header before
# this change, so the before arm sees the selection move and abandons the take
# instead of publishing a pair that names the wrong item.
#
# NOT RECORDED HERE: which host actions carry a header at all, which is swept at
# the protocol level by
# `packages/coding-agent/test/gui-host/a-transcript-arrives-behind-the-header-that-says-whose-it-is.test.ts`
# over every action tag, and the reducer's side of it, held by
# `crates/veyyon-desktop-model/tests/a-session-created-or-branched-is-the-one-in-hand-before-it-is-listed.rs`.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-export-header.sh
#
# and its other arm, whose executable is this one: the change is inside the host
# the window talks to, so the arm holds the host's source at the commit before
# it and names no second build.
#
#   SCENE_ARM=before PROOF_BASE_REF=da49c36a25^ \
#     proof/docker/record-native.sh proof/scenes/desktop-export-header.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── What A Card Measures ────────────────────────────────────────────────────
# Read from the tokens this checkout ships rather than restated as literals, so
# a retuned row height moves the rectangles the frames are read over.
read -r CARD_PX FOOTER_PX CONTENT_INSET NAV_HEADER_PX CARD_PAD_H < <(
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
if [ -z "${CARD_PAD_H:-}" ]; then
	abandon_take "tokens-resolved" "could not read queue layout tokens"
fi

if [ "${WIN_W}" -le 800 ] || [ "${RAIL_W}" -le 0 ]; then
	abandon_take "rail-drawn" "window width ${WIN_W}px has no queue rail"
fi

RAIL_LEFT=$(( WIN_X + CONTENT_INSET ))
RAIL_LIST_TOP=$(( WIN_Y + TITLEBAR_H + NAV_HEADER_PX ))
RAIL_LIST_BOTTOM=$(( WIN_Y + WIN_H - FOOTER_PX ))
CARD_X=$(( WIN_X + RAIL_W / 2 ))
RAIL_CROP="$(( RAIL_W - 2 ))x$(( RAIL_LIST_BOTTOM - RAIL_LIST_TOP ))+${WIN_X}+${RAIL_LIST_TOP}"
WINDOW_CROP="${WIN_W}x${WIN_H}+${WIN_X}+${WIN_Y}"

MENU_MIN_PIXELS=2000
SELECTION_MIN_PIXELS=200
SELECTION_MAX_PIXELS=8
MENU_ITEMS=8
# `Open`, `Park`, `Defer`, `Branch`, `Export`, `Compact`, `Handoff`, `Delete`.
EXPORT_ITEM=5
# What share of the menu's first row -- `Open`, the one item no gate decides --
# an offered answer is inked to. A refused one is drawn at 0.6 or 0.4 of its
# strength (§4.3), which lands far under this.
OFFERED_MIN_STRENGTH=85
# How many times the menu is reopened while the host is still answering
# whatever made the answer wait. Bounded, so a permanently refused answer
# abandons the take instead of reopening a menu forever.
OFFER_ATTEMPTS=4

PROBE_DIR="${TMPDIR}/frame-compare"
mkdir -p "${PROBE_DIR}"

# ─── What Is Read Out Of A Frame ─────────────────────────────────────────────
# Where the cards are, and where a menu's rows are, is read from the frame
# rather than counted down from the rail's top: the rail draws whatever sections
# its sessions come to, so a counted position lands a section out the moment a
# draft lifts a row into `Unsent`. Both readings, and what each one fails on,
# are in `measure-frame.py` beside this scene.
MEASURE="${BASH_SOURCE[0]%/*}/measure-frame.py"

selected_card() { # <frame> -> <top> <left>
	python3 "${MEASURE}" selected-card "$1" "${RAIL_LEFT}" "${RAIL_LIST_TOP}" \
		"$(( RAIL_W - 2 * CONTENT_INSET ))" "$(( RAIL_LIST_BOTTOM - RAIL_LIST_TOP ))" "${CARD_PX}"
}

menu_item() { # <frame-with-menu> <origin-x> <origin-y> <item-index> -> <y> <x> <strength>
	python3 "${MEASURE}" menu-rows "$1" "$2" "$3" "${MENU_ITEMS}" "$4" "$(( WIN_Y + WIN_H ))"
}

# ─── Waiting Out The Selection Wash ──────────────────────────────────────────
# A card the selection moved onto is washed with a tint that settles over the
# following moment (§7.3), so two frames of one unmoved selection differ while
# it runs. The wash is waited out where the differential is read -- the card's
# own padding, which no glyph and no ticking age reaches -- so the wait ends
# when the fill stops moving rather than after a guess.
fill_settled() { # <crop>
	local previous="${PROBE_DIR}/fill-settle.png" moved poll
	probe_frame "${previous}"
	for poll in $(seq 1 20); do
		pause 0.4
		moved="$(screen_differs_from_frame_pixels_at "${previous}" "$1")"
		if [ "${moved}" -le "${SELECTION_MAX_PIXELS}" ]; then
			echo "scene: the fill over $1 settled after ${poll} polls" >&2
			return 0
		fi
		cp "${PROBE_DIR}/probe-at.png" "${previous}"
	done
	return 1
}

# ─── 1. Create The Session The Window Is On ──────────────────────────────────
# The newest session is selected on arrival, so it is the session the export is
# not taken from: the row below it is another session, and the frames are read
# over both.
k "ctrl+n"
if ! native_session_ready created; then
	abandon_take "native-session-b-created" "session B creation interaction produced no session within 10s"
fi
pause 1.5

# ─── 2. Read The Two Cards Off The Screen ────────────────────────────────────
# Park the pointer on the composer first, and leave it there for both frames,
# so no row carries hover styling in either.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 0.5
RAIL_AT_REST="${PROBE_DIR}/export-rail-at-rest.png"
probe_frame "${RAIL_AT_REST}"
read -r CARD_1_TOP FILL_LEFT < <(selected_card "${RAIL_AT_REST}") || \
	abandon_take "the-session-on-screen-is-drawn-as-selected" \
		"the rail's selected card was not readable out of the screen the export is taken from"
CARD_2_TOP=$(( CARD_1_TOP + CARD_PX ))
if [ "$(( CARD_2_TOP + CARD_PX ))" -gt "${RAIL_LIST_BOTTOM}" ]; then
	abandon_take "a-row-below-the-selection-is-drawn" \
		"the selected card ends at $(( CARD_1_TOP + CARD_PX ))px, with no room for a row below it above the ${RAIL_LIST_BOTTOM}px footer"
fi
# A sliver of each card's own left padding: fill against rail ground, no glyph,
# so an age that ticked between the frames reads as nothing.
SLIVER_W=$(( CARD_PAD_H - 4 ))
if [ "${SLIVER_W}" -lt 4 ]; then
	abandon_take "a-card-has-padding-to-read" \
		"a ${CARD_PAD_H}px card padding leaves no sliver of fill to read a selection over"
fi
CARD_1_CROP="${SLIVER_W}x${CARD_PX}+$(( FILL_LEFT + 2 ))+${CARD_1_TOP}"
CARD_2_CROP="${SLIVER_W}x${CARD_PX}+$(( FILL_LEFT + 2 ))+${CARD_2_TOP}"
echo "scene: the window is on the card at ${CARD_1_TOP}px; the export is taken from the row at ${CARD_2_TOP}px" >&2

# ─── 3. Frame 1: The Export's Session Is Not The One On Screen ───────────────
if ! fill_settled "${CARD_1_CROP}"; then
	abandon_take "the-selection-is-settled" \
		"the selected card's fill was still moving after 8s, so a frame of it states a moment rather than a selection"
fi
shot the-export-target-is-another-session
FRAME_1="${SCENE_OUT}/${SCENE_NAME}-the-export-target-is-another-session.png"
read -r SHOT_CARD_TOP SHOT_FILL_LEFT < <(selected_card "${FRAME_1}") || \
	abandon_take "the-session-on-screen-is-drawn-as-selected" \
		"the rail's selected card was not readable out of the frame the export was taken in"
if [ "${SHOT_CARD_TOP}" != "${CARD_1_TOP}" ] || [ "${SHOT_FILL_LEFT}" != "${FILL_LEFT}" ]; then
	abandon_take "the-rail-held-still" \
		"the selected card moved from ${FILL_LEFT}+${CARD_1_TOP} to ${SHOT_FILL_LEFT}+${SHOT_CARD_TOP} between the reading and the frame"
fi

# ─── 4. Open That Row's Context Menu ─────────────────────────────────────────
MENU_ORIGIN_Y=$(( CARD_2_TOP + CARD_PX / 2 ))
ROW_HOVERED="${PROBE_DIR}/export-row-hovered.png"
MENU_OPEN="${PROBE_DIR}/export-menu-open.png"

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

# ─── 5. Take The Export Only Where The Row Offers It ─────────────────────────
EXPORT_Y=0
EXPORT_X=0
EXPORT_STRENGTH=0
for attempt in $(seq 1 "${OFFER_ATTEMPTS}"); do
	open_row_menu
	read -r EXPORT_Y EXPORT_X EXPORT_STRENGTH < <(menu_item "${MENU_OPEN}" "${CARD_X}" "${MENU_ORIGIN_Y}" "${EXPORT_ITEM}") || \
		abandon_take "the-export-row-is-locatable" \
			"the ${MENU_ITEMS} rows of the row menu were not readable out of the frame it opened in"
	if [ "${EXPORT_STRENGTH}" -ge "${OFFERED_MIN_STRENGTH}" ]; then
		echo "scene: the Export row is offered, inked to ${EXPORT_STRENGTH}% of the menu's first row, on attempt ${attempt}" >&2
		break
	fi
	echo "scene: the Export row is inked to ${EXPORT_STRENGTH}% of the menu's first row, which is an answer the gate refused; waiting for the host" >&2
	k Escape
	pause 2.0
done
if [ "${EXPORT_STRENGTH}" -lt "${OFFERED_MIN_STRENGTH}" ]; then
	abandon_take "the-export-row-is-offered" \
		"the Export row stayed inked to ${EXPORT_STRENGTH}% of the menu's first row over ${OFFER_ATTEMPTS} attempts, under the ${OFFERED_MIN_STRENGTH} an offered answer draws, so a click on it answers nothing"
fi
move_px "${EXPORT_X}" "${EXPORT_Y}"
pause 0.4
click
pause 2.0

# The answer took the click only if the menu it was on closed: a refused row
# swallows the click and leaves the menu standing over the rail the frames are
# read in.
MENU_CLOSED="${PROBE_DIR}/export-menu-closed.png"
probe_frame "${MENU_CLOSED}"
MENU_GONE_PX="$(frames_differ_pixels_at "${MENU_OPEN}" "${MENU_CLOSED}" "${WINDOW_CROP}")"
if [ "${MENU_GONE_PX}" -lt "${MENU_MIN_PIXELS}" ]; then
	abandon_take "the-row-menu-closed" \
		"the click on Export changed ${MENU_GONE_PX}px of the window, under the ${MENU_MIN_PIXELS} closing the menu draws, so the menu is still open over the rail"
fi

# ─── 6. Frame 2: What The Export Left On Screen ──────────────────────────────
# The wash the export's own selection change starts is waited out over the row
# it moved onto, so the frame states where the selection is rather than the
# moment it arrived. In the arm that moves no selection there is nothing to
# wash and the wait returns on its first poll.
move_px "${COMPOSER_EDITOR_X}" "${COMPOSER_EDITOR_Y}"
pause 1.0
if ! fill_settled "${CARD_2_CROP}"; then
	abandon_take "the-selection-is-settled" \
		"the exported row's fill was still moving after 8s, so a frame of it states a moment rather than a selection"
fi
shot the-export-states-the-session-it-opened

# ─── 7. Evaluate The Differential ────────────────────────────────────────────
FRAME_2="${SCENE_OUT}/${SCENE_NAME}-the-export-states-the-session-it-opened.png"
CARD_1_PX="$(frames_differ_pixels_at "${FRAME_1}" "${FRAME_2}" "${CARD_1_CROP}")"
CARD_2_PX="$(frames_differ_pixels_at "${FRAME_1}" "${FRAME_2}" "${CARD_2_CROP}")"
RAIL_PX="$(frames_differ_pixels_at "${FRAME_1}" "${FRAME_2}" "${RAIL_CROP}")"

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${CARD_1_PX}" -gt "${SELECTION_MAX_PIXELS}" ] || [ "${CARD_2_PX}" -gt "${SELECTION_MAX_PIXELS}" ]; then
		abandon_take "the-export-stated-nothing" \
			"the baseline moved the selection: card 1 ${CARD_1_PX}px and card 2 ${CARD_2_PX}px differ across the export, over the ${SELECTION_MAX_PIXELS} an unchanged card holds"
	fi
	echo "scene: before arm -- card 1 ${CARD_1_PX}px, card 2 ${CARD_2_PX}px, rail ${RAIL_PX}px across the export" >&2
else
	if [ "${CARD_1_PX}" -lt "${SELECTION_MIN_PIXELS}" ] || [ "${CARD_2_PX}" -lt "${SELECTION_MIN_PIXELS}" ]; then
		abandon_take "the-export-states-its-session" \
			"the selection did not move onto the exported row: card 1 ${CARD_1_PX}px and card 2 ${CARD_2_PX}px differ across the export, under the ${SELECTION_MIN_PIXELS} a selection change draws"
	fi
	echo "scene: after arm -- card 1 ${CARD_1_PX}px, card 2 ${CARD_2_PX}px, rail ${RAIL_PX}px across the export" >&2
fi
