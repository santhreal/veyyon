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
#   SCENE_MOTION_FLOOR=3 proof/docker/record-native.sh \
#     proof/scenes/desktop-theme-ground.sh
#
# The change is in both the window and the host, so the before arm takes a
# build from the base ref and holds the source at the same ref, which is a
# revision before the fix rather than its parent when the binary at hand was
# built there:
#
#   SCENE_ARM=before PROOF_BASE_REF=bc300a571b SCENE_MOTION_FLOOR=3 \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/proof-bins/share-before \
#     proof/docker/record-native.sh proof/scenes/desktop-theme-ground.sh
#
# The take is a still one -- a sheet opens and one row's control is replaced --
# so both arms are recorded under the 5 fps floor the driver defaults to.
#
# WHAT IS MEASURED. The control column of the rows, one cell per row, between
# the frame the page opened on and the frame after the press. A row draws
# either a Select button or an Active badge and never both, so a press that
# settled repaints the cell it landed in — a filled badge where a ghost button
# was — and leaves every other cell byte-identical. The reading is the count of
# changed pixels in the pressed row's cell and the count in all the others. A
# width of lit ink cannot tell the two apart: `Select` and `Active` are the
# same length in glyphs, and the badge's fill is darker than its letters.
#
# WHAT IT DOES NOT SHOW. Which ground the window is drawing in: that is the
# appearance choice, photographed by `desktop-appearance.sh`, and a theme chosen
# here changes what the agent reports rather than what this window draws.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Sheet And Its Rows Draw ──────────────────────────────────────
# Read from the tokens this checkout ships, so a retheme moves the crops with
# the surfaces instead of leaving them measuring the backdrop. The settings
# sheet is the settings surface's own box rather than the palette's: its rows
# carry a label, a description and a control column, and a crop taken at the
# palette's width lands between the label and the control and reads no ink.
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
	token_px.value_of("surface/settings.toml", "layout.group_width_px"),
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

# Where a row's control is pressed: the middle of the column's lit ink, which
# is a button set against the far end of the column rather than the column's
# own middle, so the press lands on the control and not beside it.
control_point() { # <shot> <top> <bottom> -> "<x> <y>"
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
	# Newline-terminated: `read` reports failure on a last line without one, and
	# under `set -e` that ends the take rather than the reading.
	printf '%s %s\n' "$(( COLUMN_LEFT + offset + width / 2 ))" "$(( ($2 + $3) / 2 ))"
}

# How many pixels of one row's control cell the two frames disagree on. A cell
# is the whole column at the row's height, so a button replaced by a filled
# badge is thousands and a cell nothing touched is none.
CELL_DIFF_PY="${TMPDIR}/theme-cell-diff.py"
cat >"${CELL_DIFF_PY}" <<'PY'
import sys

left, right = (open(path, "rb").read() for path in sys.argv[1:3])
if len(left) != len(right):
	raise SystemExit(f"the two crops read {len(left)} and {len(right)} bytes")
# 6 of 255 is the antialiasing either frame puts on the same glyph edge.
print(sum(1 for a, b in zip(left, right) if abs(a - b) > 6))
PY

cell_changes() { # <shot> <shot> <top> <bottom> -> <changed pixels>
	local height=$(( $4 - $3 ))
	local crop="${COLUMN_W}x${height}+${COLUMN_LEFT}+$3"
	magick "${SCENE_OUT}/${SCENE_NAME}-$1.png" -crop "${crop}" +repage \
		-colorspace Gray -depth 8 gray:- >"${TMPDIR}/cell-left.gray"
	magick "${SCENE_OUT}/${SCENE_NAME}-$2.png" -crop "${crop}" +repage \
		-colorspace Gray -depth 8 gray:- >"${TMPDIR}/cell-right.gray"
	python3 "${CELL_DIFF_PY}" "${TMPDIR}/cell-left.gray" "${TMPDIR}/cell-right.gray"
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
read -r TARGET_CONTROL TARGET_MID < <(control_point theme-page "${TARGET_TOP}" "${TARGET_BOTTOM}")

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

TARGET_CHANGED="$(cell_changes theme-page theme-chosen "${TARGET_TOP}" "${TARGET_BOTTOM}")"
OTHERS_CHANGED=0
while IFS=: read -r BAND_TOP BAND_BOTTOM; do
	if [ "${BAND_TOP}" = "${TARGET_TOP}" ]; then
		continue
	fi
	OTHERS_CHANGED=$(( OTHERS_CHANGED + $(cell_changes theme-page theme-chosen "${BAND_TOP}" "${BAND_BOTTOM}") ))
done <<<"${ROW_BANDS}"

# A badge drawn where a button was fills its own box and letters a word in it,
# which is hundreds of pixels; a cell the press did not reach is none, and the
# few a glyph's antialiasing can differ by are not a control.
SETTLED_PX=200
UNTOUCHED_PX=8

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${TARGET_CHANGED}" -gt "${UNTOUCHED_PX}" ]; then
		abandon_take "theme-chosen" \
			"the baseline repainted ${TARGET_CHANGED} pixels of the pressed row's control, so this arm proves nothing about a refused choice"
	fi
	echo "scene: before arm -- the press left the row's control at ${TARGET_CHANGED} changed pixels:" \
		"the host refused the key the window wrote, and the row draws its Select as though nothing was pressed" >&2
else
	if [ "${TARGET_CHANGED}" -lt "${SETTLED_PX}" ]; then
		abandon_take "theme-chosen" \
			"the pressed row's control changed ${TARGET_CHANGED} pixels, under the ${SETTLED_PX} a badge drawn over a button changes, so the choice never settled on the row"
	fi
	if [ "${OTHERS_CHANGED}" -gt "${UNTOUCHED_PX}" ]; then
		abandon_take "theme-chosen" \
			"the press changed ${OTHERS_CHANGED} pixels in the controls of the rows it did not land on, so the page moved more than the row that was chosen"
	fi
	echo "scene: after arm -- the pressed row's control changed ${TARGET_CHANGED} pixels and every other" \
		"row's control changed ${OTHERS_CHANGED}: the choice settled on the row it was pressed on" >&2
fi
