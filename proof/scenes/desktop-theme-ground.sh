#!/usr/bin/env bash
# Choose one of the host's own themes on the Themes page and photograph whether
# the choice settled on the row it was pressed on.
#
# Records visual evidence for:
#   1. theme-page    (the page as it opens, with the host's themes listed)
#   2. theme-chosen  (the same page after a host theme row's Select was pressed)
#
# THE PAIR IS TWO BINARIES. The window wrote the chosen theme to a setting key
# named `theme`, which the host's schema does not have, so the host answered
# `INVALID_SETTING` and nothing changed. Nothing in the window reads that
# refusal, so the row went on drawing its Select and no row ever carried an
# Active badge. Both arms open the same page and press Select on the same row.
#
#   proof/docker/record-native.sh proof/scenes/desktop-theme-ground.sh
#
# The change is in both the window and the host, so the before arm takes the
# pre-change build and holds the source with it:
#
#   SCENE_ARM=before PROOF_BASE_REF=<fix>^ \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/proof-bins/theme-before \
#     proof/docker/record-native.sh proof/scenes/desktop-theme-ground.sh
#
# WHAT IS MEASURED. A row's control column, which draws either a Select button
# or an Active badge and never both. The reading is the count of rows whose
# control band lies inside the host's own listing, and the width of the band on
# the row that was pressed: a badge is narrower than the button it replaces, so
# a press that settled moves that one band and leaves the rest of the column
# where it was. A mean over the whole page would answer for the elapsed times
# ticking in the rail behind the sheet, and a single pixel would answer for the
# hover the pointer leaves.
#
# WHAT IT DOES NOT SHOW. Which ground the window is drawing in: that is the
# appearance choice, photographed by `desktop-appearance.sh`, and a theme chosen
# here changes what the agent reports rather than what this window draws.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Dialog And Its Rows Draw ─────────────────────────────────────
# Read from the tokens this checkout ships, so a retheme moves the crops with
# the surfaces instead of leaving them measuring the backdrop.
read -r DIALOG_W TITLEBAR_H MARGIN COLUMN_W BODY_INSET ROW_H ROW_GAP SHEET_H < <(
	python3 - "${BASH_SOURCE[0]%/*}" <<'PY'
from pathlib import Path
import sys

scenes_dir = Path(sys.argv[1]).resolve()
if scenes_dir.is_file():
    scenes_dir = scenes_dir.parent
sys.path.insert(0, str(scenes_dir))
import token_px

print(
	token_px.value_of("surface/palette.toml", "geometry.width_px"),
	token_px.value_of("surface/shell.toml", "titlebar.height_px"),
	token_px.value_of("scale.toml", "spacing.s4"),
	token_px.value_of("surface/settings.toml", "layout.control_column_width_px"),
	token_px.value_of("scale.toml", "spacing.s6"),
	token_px.value_of("surface/settings.toml", "layout.row_height_px"),
	token_px.value_of("surface/settings.toml", "layout.row_gap"),
	token_px.value_of("surface/settings.toml", "layout.sheet_height_px"),
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
	abandon_take "theme-page" \
		"the settings dialog is ${DEST_H}px tall, too short to hold the rows this scene points at"
fi

# The rows of the page: below the dialog's own header and the page's
# description, which are drawn once and are not rows.
BODY_TOP=$(( DEST_TOP + 70 ))
BODY_H=$(( DEST_TOP + DEST_H - MARGIN - BODY_TOP ))
COLUMN_RIGHT=$(( DIALOG_LEFT + DIALOG_W - BODY_INSET ))
COLUMN_LEFT=$(( COLUMN_RIGHT - COLUMN_W ))

# A control is a badge or a button: a band a few dozen pixels wide, so a row
# counts as inked on a handful of lit pixels and the ground between rows on
# none.
INK_FLOOR=90
INK_PIXELS=3

# The horizontal ink bands of the row control column, as `<top>:<bottom>` lines
# in root coordinates. The reader is written to a file rather than fed on
# standard input, which carries the crop's own bytes.
INK_BANDS_PY="${TMPDIR}/theme-ink-bands.py"
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

row_bands() { # <shot>
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local bands
	bands="$(magick "${png}" -crop "${COLUMN_W}x${BODY_H}+${COLUMN_LEFT}+${BODY_TOP}" +repage \
		-colorspace Gray -depth 8 gray:- |
		python3 "${INK_BANDS_PY}" "${COLUMN_W}" "${BODY_H}" "${BODY_TOP}" "${INK_FLOOR}" "${INK_PIXELS}")"
	if [ -z "${bands}" ]; then
		abandon_take "theme-rows-readable" \
			"the control column at +${COLUMN_LEFT}+${BODY_TOP} holds no ink in $1, so the page drew no row"
	fi
	printf '%s\n' "${bands}"
}

# The lit width of one band's control, and the middle of that ink. A button is
# set against the far end of the column and a badge is narrower than it, so a
# press is aimed at the ink rather than at the middle of the column, and the
# width states which of the two is drawn.
band_ink() { # <shot> <top> <bottom> -> "<width> <middle-x>"
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local trimmed offset width
	trimmed="$(magick "${png}" -crop "${COLUMN_W}x$(( $3 - $2 ))+${COLUMN_LEFT}+$2" +repage \
		-colorspace Gray -threshold "$(( INK_FLOOR * 100 / 255 ))%" -trim -format '%w %X' info: 2>/dev/null)"
	case "${trimmed}" in
		'' | *[!0-9\ +-]*)
			abandon_take "theme-rows-readable" \
				"trimming the band at $2 in $1 reported '${trimmed}' instead of a width and an offset"
			;;
	esac
	width="${trimmed%% *}"
	offset="${trimmed#* }"
	printf '%s %s' "${width}" "$(( COLUMN_LEFT + offset + width / 2 ))"
}

# ─── Open The Themes Page ───────────────────────────────────────────────────
k "ctrl+k"
pause 0.3
t "settings themes"
pause 0.5
k "Return"
pause 2.0

# The pointer is parked outside the dialog, so the resting frame carries no
# hover of its own for the later readings to answer for.
move_px "$(( WIN_X + 40 ))" "$(( WIN_Y + WIN_H - 40 ))"
pause 0.6
shot theme-page

# ─── Which Row Is Pressed ───────────────────────────────────────────────────
# The page lists the appearances this build ships before the themes the host
# reported, so the host's own listing starts after them. The last row is taken
# rather than counted from the top: its index does not move when a build ships
# another appearance, and it is a theme the host reported in either arm.
ROW_BANDS="$(row_bands theme-page)"
ROW_COUNT="$(printf '%s\n' "${ROW_BANDS}" | wc -l | tr -d ' ')"
if [ "${ROW_COUNT}" -lt 3 ]; then
	abandon_take "theme-rows-readable" \
		"the page drew ${ROW_COUNT} control band in its body, too few to hold an appearance listing and a host theme under it"
fi
FIRST_TOP="$(printf '%s\n' "${ROW_BANDS}" | sed -n '1p' | cut -d: -f1)"
SECOND_TOP="$(printf '%s\n' "${ROW_BANDS}" | sed -n '2p' | cut -d: -f1)"
PITCH=$(( SECOND_TOP - FIRST_TOP ))
AUTHORED_PITCH=$(( ROW_H + ROW_GAP ))
if (( PITCH < AUTHORED_PITCH - 4 || PITCH > AUTHORED_PITCH + 4 )); then
	abandon_take "theme-rows-readable" \
		"the page drew its first two controls ${PITCH}px apart, not the ${AUTHORED_PITCH}px a ${ROW_H}px row and its ${ROW_GAP}px gap author, so these bands are not two rows"
fi
TARGET_TOP="$(printf '%s\n' "${ROW_BANDS}" | tail -n 1 | cut -d: -f1)"
TARGET_BOTTOM="$(printf '%s\n' "${ROW_BANDS}" | tail -n 1 | cut -d: -f2)"
TARGET_MID=$(( (TARGET_TOP + TARGET_BOTTOM) / 2 ))
read -r OPENED_WIDTH TARGET_CONTROL < <(band_ink theme-page "${TARGET_TOP}" "${TARGET_BOTTOM}")

# ─── The Row's Select Pressed, And The Pointer Taken Away ───────────────────
# The press lands on the control the row's own band drew, and the pointer is
# then parked off the page, so the frame carries the settled row rather than a
# row under a pointer.
move_px "${TARGET_CONTROL}" "${TARGET_MID}"
click
pause 1.2
move_px "$(( WIN_X + 40 ))" "$(( WIN_Y + WIN_H - 40 ))"
pause 1.2
shot theme-chosen

CHOSEN_BANDS="$(row_bands theme-chosen)"
CHOSEN_COUNT="$(printf '%s\n' "${CHOSEN_BANDS}" | wc -l | tr -d ' ')"
if [ "${CHOSEN_COUNT}" -ne "${ROW_COUNT}" ]; then
	abandon_take "theme-chosen" \
		"the page drew ${CHOSEN_COUNT} control bands after the press and ${ROW_COUNT} before it: the press changed which rows are listed rather than which one is settled"
fi
read -r CHOSEN_WIDTH _ < <(band_ink theme-chosen "${TARGET_TOP}" "${TARGET_BOTTOM}")

# A badge and the button it replaces differ by more than the antialiasing on
# either one's edge.
SAME_CONTROL_MAX=4
DELTA=$(( CHOSEN_WIDTH - OPENED_WIDTH ))
if [ "${DELTA}" -lt 0 ]; then DELTA=$(( -DELTA )); fi

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${DELTA}" -gt "${SAME_CONTROL_MAX}" ]; then
		abandon_take "theme-chosen" \
			"the baseline changed the pressed row's control: ${OPENED_WIDTH}px of ink became ${CHOSEN_WIDTH}px, so this arm proves nothing about a refused choice"
	fi
	echo "scene: before arm -- the pressed row's control held ${OPENED_WIDTH}px of ink and still holds ${CHOSEN_WIDTH}px: the host refused the key the window wrote, and the row draws its Select as though nothing was pressed" >&2
else
	if [ "${DELTA}" -le "${SAME_CONTROL_MAX}" ]; then
		abandon_take "theme-chosen" \
			"the pressed row's control is unchanged at ${CHOSEN_WIDTH}px of ink: the choice never settled on the row, so the page draws the same Select it drew before the press"
	fi
	echo "scene: after arm -- the pressed row's control went from ${OPENED_WIDTH}px of ink to ${CHOSEN_WIDTH}px: the choice settled on the row it was pressed on" >&2
fi
