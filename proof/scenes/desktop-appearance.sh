#!/usr/bin/env bash
# Photograph the Themes settings page in the appearance it opens in, under the
# pointer resting on another appearance, and after that appearance was chosen.
#
# Records visual evidence for:
#   1. appearance-dark    (the page in the appearance the window opened in)
#   2. appearance-preview (the pointer resting on the other appearance's row)
#   3. appearance-chosen  (that appearance selected, pointer parked away)
#
# WHAT IS MEASURED. Two readings per shot, each the mean grey of a rectangle
# rather than a pixel or a whole frame: a mean is unmoved by the elapsed times
# ticking in the session rail, and a ground swap moves it by a hundred levels
# while a row's hover tint moves it by one.
#
#   * THE PAGE'S OWN GROUND: the dialog body, which is drawn on the float
#     ground of whichever appearance is installed. The dark appearance authors
#     it at #1e232a and the light one at #ffffff, so the two are a hundred and
#     eighty grey levels apart and no threshold between them is delicate.
#   * THE WINDOW BEHIND THE DIALOG: a rectangle of the session rail, which the
#     dialog does not cover. A preview that reached only the row under the
#     pointer, or only the sheet, leaves this reading where it was; an
#     appearance reaching the installed tokens moves the whole window with it.
#
# THE ARMS. The after arm opens dark, lightens both readings while the pointer
# rests on the light row, and keeps them light after the row's Select was
# pressed and the pointer parked off the page -- so a preview that never
# reverted and a selection that did not stick are separate failures. The before
# arm draws no appearance row at all: its page lists only what the host
# reported, and the pointer resting where the row would be, and the press that
# would choose it, leave both readings dark.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-appearance.sh
#
# The change is entirely inside the executable, so the before arm holds no
# source and takes a build of the pre-change tree:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     <commit> appearance-before
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/appearance-before/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-appearance.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Dialog And Its Rows Draw ─────────────────────────────────────
# Read from the tokens this checkout ships, so a retheme moves the crops with
# the surfaces instead of leaving them measuring the backdrop.
read -r DIALOG_W TITLEBAR_H MARGIN COLUMN_W BODY_INSET ROW_H ROW_GAP SHEET_H < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
palette = tomllib.loads((root / "surface/palette.toml").read_text())
shell = tomllib.loads((root / "surface/shell.toml").read_text())
settings = tomllib.loads((root / "surface/settings.toml").read_text())
scale = tomllib.loads((root / "scale.toml").read_text())
print(
	palette["geometry"]["width_px"],
	shell["titlebar"]["height_px"],
	scale["spacing"]["s4"],
	settings["layout"]["control_column_width_px"],
	scale["spacing"]["s6"],
	settings["layout"]["row_height_px"],
	scale["spacing"][settings["layout"]["row_gap"]],
	settings["layout"]["sheet_height_px"],
)
PY
)
DIALOG_LEFT=$(( WIN_X + (WIN_W - DIALOG_W) / 2 ))
COLUMNS_H=$(( WIN_H - TITLEBAR_H ))
COLUMNS_CENTER_Y=$(( WIN_Y + TITLEBAR_H + COLUMNS_H / 2 ))
DEST_H=$(( COLUMNS_H - 2 * MARGIN ))
if (( DEST_H > SHEET_H )); then DEST_H=$SHEET_H; fi
DEST_TOP=$(( COLUMNS_CENTER_Y - DEST_H / 2 ))
if (( DEST_H < 480 )); then
	abandon_take "appearance-dark" \
		"the settings dialog is ${DEST_H}px tall, too short to hold the rows this scene points at"
fi

# The body of the page: below the dialog's own header and the page's title,
# which are drawn once and are not rows. The same offset the settings-row scene
# reads its bands from.
BODY_TOP=$(( DEST_TOP + 120 ))
BODY_H=$(( DEST_TOP + DEST_H - MARGIN - BODY_TOP ))
LABEL_LEFT=$(( DIALOG_LEFT + BODY_INSET ))
COLUMN_RIGHT=$(( DIALOG_LEFT + DIALOG_W - BODY_INSET ))
COLUMN_LEFT=$(( COLUMN_RIGHT - COLUMN_W ))

# The second row of the body. The page lists the appearances this build ships
# before anything a host reported, in the order they were loaded, so the row
# under the one the window opened in is the other appearance.
SECOND_ROW_TOP=$(( BODY_TOP + ROW_H + ROW_GAP ))
SECOND_ROW_MID=$(( SECOND_ROW_TOP + ROW_H / 2 ))
if (( SECOND_ROW_TOP + ROW_H > DEST_TOP + DEST_H - MARGIN )); then
	abandon_take "appearance-preview" \
		"the second row would draw at ${SECOND_ROW_TOP}px, past the bottom of the ${DEST_H}px dialog"
fi

# ─── What The Two Readings Are Taken Over ───────────────────────────────────
# The page's own ground, inset from the rows' text so the reading is of the
# ground the sheet draws and not of one column of prose.
PAGE_X=$(( LABEL_LEFT ))
PAGE_Y=$(( BODY_TOP ))
PAGE_W=$(( COLUMN_RIGHT - LABEL_LEFT ))
PAGE_H=$(( BODY_H ))
# The session rail, which the dialog does not cover: the window behind the
# sheet, whose ground comes from the same installed tokens.
RAIL_X=$(( WIN_X + 8 ))
RAIL_Y=$(( WIN_Y + TITLEBAR_H + 40 ))
RAIL_W=200
RAIL_H=200
if (( DIALOG_LEFT < RAIL_X + RAIL_W )); then
	abandon_take "appearance-dark" \
		"the dialog's left edge is at ${DIALOG_LEFT}px, over the rail rectangle this scene reads the window's ground from"
fi

# A dark appearance authors every ground under #202020 and a light one over
# #ee; the thresholds sit either side of that gap with a hundred levels of
# margin, and the scrim over the window behind the sheet is what keeps the rail
# floor lower than the page's.
DARK_MAX=90
PAGE_LIGHT_MIN=150
RAIL_LIGHT_MIN=100
# Two shots of one appearance read within a few levels of each other; the gap
# to the other appearance is over a hundred.
SAME_APPEARANCE_MAX=25

# The mean grey of a rectangle, 0 to 255.
crop_mean_grey() { # <shot> <x> <y> <w> <h>
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local mean
	mean="$(magick "${png}" -crop "$4x$5+$2+$3" +repage \
		-colorspace Gray -format '%[fx:round(mean*255)]' info: 2>/dev/null || true)"
	case "${mean}" in
		'' | *[!0-9]*)
			abandon_take "appearance-grey-readable" \
				"reading the mean grey of $1 at +$2+$3 reported '${mean}' instead of a level"
			;;
	esac
	printf '%s' "${mean}"
}

page_grey() { # <shot>
	crop_mean_grey "$1" "${PAGE_X}" "${PAGE_Y}" "${PAGE_W}" "${PAGE_H}"
}

rail_grey() { # <shot>
	crop_mean_grey "$1" "${RAIL_X}" "${RAIL_Y}" "${RAIL_W}" "${RAIL_H}"
}

# ─── Open The Themes Page ───────────────────────────────────────────────────
k "ctrl+k"
pause 0.3
t "settings themes"
pause 0.5
k "Return"
pause 2.0

# ─── The Page In The Appearance The Window Opened In ────────────────────────
# The pointer is parked outside the dialog, so the resting frame carries no
# hover of its own for the later readings to answer for.
move_px "$(( WIN_X + 40 ))" "$(( WIN_Y + WIN_H - 40 ))"
pause 0.6
shot appearance-dark
OPENED_PAGE="$(page_grey appearance-dark)"
OPENED_RAIL="$(rail_grey appearance-dark)"
if [ "${OPENED_PAGE}" -gt "${DARK_MAX}" ]; then
	abandon_take "appearance-dark" \
		"the page opened at a mean grey of ${OPENED_PAGE}, over the ${DARK_MAX} a dark ground draws, so this take starts in the wrong appearance"
fi

# ─── The Pointer Resting On The Other Appearance's Row ──────────────────────
move_px "$(( LABEL_LEFT + 60 ))" "${SECOND_ROW_MID}"
pause 1.2
shot appearance-preview
PREVIEW_PAGE="$(page_grey appearance-preview)"
PREVIEW_RAIL="$(rail_grey appearance-preview)"

# ─── That Appearance Chosen, And The Pointer Taken Away ─────────────────────
# The press lands in the row's control column, which is where its Select is
# drawn, and the pointer is then parked off the page: a preview would revert
# there and a choice would not.
move_px "$(( COLUMN_LEFT + COLUMN_W / 2 ))" "${SECOND_ROW_MID}"
click
pause 0.8
move_px "$(( WIN_X + 40 ))" "$(( WIN_Y + WIN_H - 40 ))"
pause 1.2
shot appearance-chosen
CHOSEN_PAGE="$(page_grey appearance-chosen)"
CHOSEN_RAIL="$(rail_grey appearance-chosen)"

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${PREVIEW_PAGE}" -gt "${DARK_MAX}" ]; then
		abandon_take "appearance-preview" \
			"the baseline lightened its page under the pointer: mean grey ${PREVIEW_PAGE}, over the ${DARK_MAX} a dark ground draws, so this arm proves nothing about the preview"
	fi
	if [ "${CHOSEN_PAGE}" -gt "${DARK_MAX}" ]; then
		abandon_take "appearance-chosen" \
			"the baseline lightened its page after the press: mean grey ${CHOSEN_PAGE}, over the ${DARK_MAX} a dark ground draws"
	fi
	if [ "${CHOSEN_RAIL}" -gt "${DARK_MAX}" ]; then
		abandon_take "appearance-chosen" \
			"the baseline lightened the window behind the sheet: rail mean grey ${CHOSEN_RAIL}, over the ${DARK_MAX} a dark ground draws"
	fi
	echo "scene: before arm -- page grey ${OPENED_PAGE} -> ${PREVIEW_PAGE} -> ${CHOSEN_PAGE}, rail ${OPENED_RAIL} -> ${PREVIEW_RAIL} -> ${CHOSEN_RAIL}: the page lists no appearance to point at" >&2
else
	if [ "${PREVIEW_PAGE}" -lt "${PAGE_LIGHT_MIN}" ]; then
		abandon_take "appearance-preview" \
			"the pointer resting on the row drew the page at a mean grey of ${PREVIEW_PAGE}, under the ${PAGE_LIGHT_MIN} a light ground draws: the appearance never reached the installed tokens"
	fi
	if [ "${PREVIEW_RAIL}" -lt "${RAIL_LIGHT_MIN}" ]; then
		abandon_take "appearance-preview" \
			"the preview reached the sheet and not the window: the rail read ${PREVIEW_RAIL}, under the ${RAIL_LIGHT_MIN} a light ground draws there"
	fi
	if [ "${CHOSEN_PAGE}" -lt "${PAGE_LIGHT_MIN}" ]; then
		abandon_take "appearance-chosen" \
			"the pointer left the page and the appearance went with it: the page read ${CHOSEN_PAGE}, under the ${PAGE_LIGHT_MIN} a light ground draws, so the Select was a preview rather than a choice"
	fi
	if [ "${CHOSEN_RAIL}" -lt "${RAIL_LIGHT_MIN}" ]; then
		abandon_take "appearance-chosen" \
			"the chosen appearance left the window behind the sheet dark: the rail read ${CHOSEN_RAIL}, under the ${RAIL_LIGHT_MIN} a light ground draws there"
	fi
	DRIFT=$(( CHOSEN_PAGE - PREVIEW_PAGE ))
	if [ "${DRIFT}" -lt 0 ]; then DRIFT=$(( -DRIFT )); fi
	if [ "${DRIFT}" -gt "${SAME_APPEARANCE_MAX}" ]; then
		abandon_take "appearance-chosen" \
			"the chosen page reads ${DRIFT} grey levels from the previewed one, over the ${SAME_APPEARANCE_MAX} two shots of one appearance differ by: the press changed the appearance rather than settling the one being previewed"
	fi
	echo "scene: after arm -- page grey ${OPENED_PAGE} -> ${PREVIEW_PAGE} -> ${CHOSEN_PAGE}, rail ${OPENED_RAIL} -> ${PREVIEW_RAIL} -> ${CHOSEN_RAIL}: the pointer previewed the appearance and the press kept it" >&2
fi
