#!/usr/bin/env bash
# Photograph the General settings page at rest and with the pointer on a row's
# description, and count what the page fits and what the pointer opens.
#
# Records visual evidence for:
#   1. settings-row-rest  (the General page at rest, one row per setting)
#   2. settings-row-hover (the same page with the pointer on a row's prose)
#
# WHAT IS MEASURED. Three readings, each over a rectangle rather than a whole
# frame, because the queue rail's elapsed times tick between any two shots:
#
#   * THE ROWS THE PAGE FITS: the number of horizontal ink bands in the row
#     control column, which draws one control per setting and nothing between
#     them. A page of 44px rows fits eleven controls in the dialog's body; a
#     page whose rows grew to the length of their descriptions fits six.
#   * THE PITCH OF THOSE BANDS: the distance between the first two, which is
#     the row height plus the row gap the tokens author (44 + 8). A row that
#     grows to its prose draws the next control 100px and more below.
#   * WHAT THE POINTER OPENS: the pixels that change under the hovered row
#     between the two shots. A row that states one truncated line hands the
#     rest over in a tag drawn over the rows below it; a row that wrapped its
#     description has nothing to hand over and changes nothing.
#
# THE ARMS. The after arm fits at least nine controls at a pitch no greater
# than the authored one, and opens a tag. The before arm fits at most seven, at
# a pitch of at least seventy, and opens nothing. Each arm is guarded in the
# direction it is true in, so a page that failed to open fails the before arm
# rather than passing both.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-settings-row.sh
#
# The change is entirely inside the executable, so the before arm holds no
# source and takes a build of the pre-change tree:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     <commit> settings-row-before
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/settings-row-before/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-settings-row.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Dialog, Its Rows And Its Control Column Draw ──────────────────
# Read from the tokens this checkout ships, so a retheme moves the crops with
# the surfaces instead of leaving them measuring the backdrop.
read -r DIALOG_W TITLEBAR_H MARGIN COLUMN_W BODY_INSET ROW_H ROW_GAP < <(
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
)
PY
)
DIALOG_LEFT=$(( WIN_X + (WIN_W - DIALOG_W) / 2 ))
COLUMNS_H=$(( WIN_H - TITLEBAR_H ))
COLUMNS_CENTER_Y=$(( WIN_Y + TITLEBAR_H + COLUMNS_H / 2 ))
DEST_H=$(( COLUMNS_H - 2 * MARGIN ))
if (( DEST_H > 560 )); then DEST_H=560; fi
DEST_TOP=$(( COLUMNS_CENTER_Y - DEST_H / 2 ))
if (( DEST_H < 480 )); then
	abandon_take "settings-row-rest" \
		"the settings dialog is ${DEST_H}px tall, too short to hold the rows this scene counts"
fi

# The body of the page: below the dialog's own header and the page's title,
# which are drawn once and are not rows.
BODY_TOP=$(( DEST_TOP + 120 ))
BODY_H=$(( DEST_TOP + DEST_H - MARGIN - BODY_TOP ))
COLUMN_RIGHT=$(( DIALOG_LEFT + DIALOG_W - BODY_INSET ))
COLUMN_LEFT=$(( COLUMN_RIGHT - COLUMN_W ))
LABEL_LEFT=$(( DIALOG_LEFT + BODY_INSET ))
# The label column, which the tag opens over: the body width the control column
# leaves. The tag is authored a little wider than it, so the crop reads the
# prose rather than the whole of the tag's ground.
LABEL_W=$(( COLUMN_LEFT - LABEL_LEFT ))

# A control is a toggle or a field: a band a few dozen pixels wide, so a row
# counts as inked on a handful of lit pixels and the ground between rows on
# none.
INK_FLOOR=90
INK_PIXELS=3

# A page of authored rows fits eleven controls in this body; one of grown rows
# fits six. The arms are guarded either side of that gap.
ROWS_FITTED_MIN=9
ROWS_GROWN_MAX=7
PITCH_AUTHORED_MAX=$(( ROW_H + ROW_GAP + 4 ))
PITCH_GROWN_MIN=70

# The tag is several lines of 12/16 prose on its own ground: a few hundred lit
# pixels. The renderer's own frame-to-frame noise over a crop this size was
# measured at 26 pixels by the turn-footer scene.
TAG_CHANGE_MIN=200
TAG_NOISE_MAX=40

# The horizontal ink bands of a rectangle, as `<top>:<bottom>` lines in root
# coordinates: one band per line of text or per control, and nothing for the
# ground between them. The reader is written to a file rather than fed on
# standard input, which carries the crop's own bytes.
INK_BANDS_PY="${SCENE_RUNTIME_DIR}/ink-bands.py"
cat >"${INK_BANDS_PY}" <<'PY'
import sys

width, height, origin, floor, minimum = (int(argument) for argument in sys.argv[1:6])
pixels = sys.stdin.buffer.read()
if len(pixels) < width * height:
	raise SystemExit(f"the crop read {len(pixels)} bytes, short of {width * height}")

inked = [
	sum(1 for value in pixels[row * width : (row + 1) * width] if value >= floor) >= minimum
	for row in range(height)
]
bands: list[tuple[int, int]] = []
start = None
for row, lit in enumerate(inked):
	if lit and start is None:
		start = row
	elif not lit and start is not None:
		if row - start >= 2:
			bands.append((start, row))
		start = None
if start is not None and height - start >= 2:
	bands.append((start, height))
for top, bottom in bands:
	print(f"{top + origin}:{bottom + origin}")
PY

ink_bands() { # <shot> <x> <y> <w> <h>
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local bands
	bands="$(magick "${png}" -crop "$4x$5+$2+$3" +repage -colorspace Gray -depth 8 gray:- |
		python3 "${INK_BANDS_PY}" "$4" "$5" "$3" "${INK_FLOOR}" "${INK_PIXELS}")"
	if [ -z "${bands}" ]; then
		abandon_take "settings-row-bands" "the rectangle at +$2+$3 holds no ink at all in $1"
	fi
	printf '%s\n' "${bands}"
}

# ─── Open The General Page ───────────────────────────────────────────────────
k "ctrl+k"
pause 0.3
t "settings"
pause 0.3
k "Return"
pause 0.3
k "Return"
pause 2.0

# ─── The Page At Rest ────────────────────────────────────────────────────────
# The pointer is parked outside the dialog, so the resting frame carries no tag
# of its own to compare against.
move_px "$(( WIN_X + 40 ))" "$(( WIN_Y + WIN_H - 40 ))"
pause 0.5
shot settings-row-rest

CONTROL_BANDS="$(ink_bands settings-row-rest "${COLUMN_LEFT}" "${BODY_TOP}" "${COLUMN_W}" "${BODY_H}")"
ROWS_FITTED="$(printf '%s\n' "${CONTROL_BANDS}" | wc -l | tr -d ' ')"
FIRST_TOP="$(printf '%s\n' "${CONTROL_BANDS}" | sed -n '1p' | cut -d: -f1)"
SECOND_TOP="$(printf '%s\n' "${CONTROL_BANDS}" | sed -n '2p' | cut -d: -f1)"
if [ -z "${SECOND_TOP}" ]; then
	abandon_take "settings-row-pitch" \
		"the page drew one control band in its body, so it states no pitch to measure"
fi
PITCH=$(( SECOND_TOP - FIRST_TOP ))

# ─── The Pointer On A Row's Prose ────────────────────────────────────────────
# The second row of the body, so the reading is of a row the page drew rather
# than of the group heading above it, and its tag opens over rows below it
# rather than off the bottom of the dialog.
HOVER_Y=$(( SECOND_TOP + 8 ))
move_px "$(( LABEL_LEFT + 60 ))" "${HOVER_Y}"
pause 1.0
shot settings-row-hover

# Under the hovered row and over the rows below it, which is where the tag
# opens and where a row that wrapped its prose has nothing to draw.
use_crop "${LABEL_LEFT}" "$(( SECOND_TOP + ROW_H ))" "${LABEL_W}" 96
TAG_CHANGED="$(shots_differ_pixels settings-row-rest settings-row-hover)"

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${ROWS_FITTED}" -gt "${ROWS_GROWN_MAX}" ]; then
		abandon_take "settings-row-rest" \
			"the baseline fitted ${ROWS_FITTED} controls in its body, over the ${ROWS_GROWN_MAX} a page of grown rows holds, so this arm proves nothing about the height"
	fi
	if [ "${PITCH}" -lt "${PITCH_GROWN_MIN}" ]; then
		abandon_take "settings-row-rest" \
			"the baseline drew its controls ${PITCH}px apart, under the ${PITCH_GROWN_MIN}px a grown row takes"
	fi
	if [ "${TAG_CHANGED}" -gt "${TAG_NOISE_MAX}" ]; then
		abandon_take "settings-row-hover" \
			"the baseline opened something under the hovered row: ${TAG_CHANGED} pixels changed, over the ${TAG_NOISE_MAX} this renderer's noise moves"
	fi
	echo "scene: before arm -- ${ROWS_FITTED} controls at a ${PITCH}px pitch, and hovering a row changed ${TAG_CHANGED} pixels under it" >&2
else
	if [ "${ROWS_FITTED}" -lt "${ROWS_FITTED_MIN}" ]; then
		abandon_take "settings-row-rest" \
			"the page fitted ${ROWS_FITTED} controls in its body, under the ${ROWS_FITTED_MIN} rows of ${ROW_H}px hold"
	fi
	if [ "${PITCH}" -gt "${PITCH_AUTHORED_MAX}" ]; then
		abandon_take "settings-row-rest" \
			"the page drew its controls ${PITCH}px apart, over the ${PITCH_AUTHORED_MAX}px the ${ROW_H}px row and its ${ROW_GAP}px gap author"
	fi
	if [ "${TAG_CHANGED}" -lt "${TAG_CHANGE_MIN}" ]; then
		abandon_take "settings-row-hover" \
			"pointing at a row's description changed ${TAG_CHANGED} pixels under it, under the ${TAG_CHANGE_MIN} a tag of prose draws, so the truncated description is unrecoverable"
	fi
	echo "scene: after arm -- ${ROWS_FITTED} controls at a ${PITCH}px pitch, and hovering a row opened ${TAG_CHANGED} pixels of prose under it" >&2
fi
