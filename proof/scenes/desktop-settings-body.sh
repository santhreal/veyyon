#!/usr/bin/env bash
# The General settings page, measured: where the dialog draws, where the query
# field it is searched from draws, and how many controls the body under that
# field drew.
#
# Sourced by a scene rather than recorded. Two scenes search that page for
# different reasons -- one for the rows the host sends, one for what typing in
# the field does to the rows -- and both need the same three readings, so they
# are defined once here instead of copied into each.
#
# WHAT IS MEASURED. The horizontal ink bands of the control column, which draws
# one control per row the page lists and nothing between them, over the body
# under the query field. A query the page answers with rows inks one band per
# row; a query it answers with its empty state inks none, because the empty
# state is prose in the label column and draws no control.
#
# The field's own offset is composed in the executable rather than declared in
# the token files, so it is read off the window: a restated number aims at the
# field's lower edge and types into nothing.
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Dialog, Its Query Field And Its Control Column Draw ───────────
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
	abandon_take "the-settings-dialog-holds-a-page" \
		"the settings dialog is ${DEST_H}px tall, too short to hold the rows a scene reads under its query field"
fi

# The strip the field is found in runs down the label column, which the row
# controls to its right never reach.
SEARCH_STRIP_LEFT=$(( DIALOG_LEFT + 100 ))
SEARCH_STRIP_W=100
SEARCH_X=$(( DIALOG_LEFT + DIALOG_W / 2 ))
COLUMN_RIGHT=$(( DIALOG_LEFT + DIALOG_W - BODY_INSET ))
COLUMN_LEFT=$(( COLUMN_RIGHT - COLUMN_W ))

# Bands are read off the trailing hundred pixels of the control column rather
# than the whole of it. Every control is drawn to the column's trailing edge,
# so each still inks this strip, and the page's empty state is prose centred
# in the body: a crop of the whole column reads that prose as two bands and
# counts a page of no rows as a page of rows.
BAND_W=100
BAND_LEFT=$(( COLUMN_RIGHT - BAND_W ))

# A control is a band a few dozen pixels wide, and it is found by how far its
# tone stands from the ground it is drawn on rather than by how bright it is:
# a toggle is lighter than the body, and a text field's well is darker, so a
# floor on brightness reads a row with an empty field as no row at all. The
# ground is the body's own most common tone, so a retheme moves the reading
# with it.
INK_DELTA=8
INK_PIXELS=3

# The horizontal ink bands of a rectangle, as `<top>:<bottom>` lines in root
# coordinates: one band per control, and nothing for the ground between them.
# The crop crosses as raw 8-bit gray rather than a text dump, so a row is a
# window into the byte string and the reader never parses a pixel format.
INK_BANDS_PY="${TMPDIR}/settings-body-ink-bands.py"
cat >"${INK_BANDS_PY}" <<'PY'
import sys
from collections import Counter

width, height, origin, delta, minimum = (int(argument) for argument in sys.argv[1:6])
pixels = sys.stdin.buffer.read()
if len(pixels) < width * height:
	raise SystemExit(f"the crop read {len(pixels)} bytes, short of {width * height}")

ground = Counter(pixels[: width * height]).most_common(1)[0][0]
inked = [
	sum(1 for value in pixels[row * width : (row + 1) * width] if abs(value - ground) >= delta)
	>= minimum
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

ink_bands() { # <shot> -> one `<top>:<bottom>` line per control band in the body
	magick "${SCENE_OUT}/${SCENE_NAME}-$1.png" \
		-crop "${BAND_W}x${BODY_H}+${BAND_LEFT}+${BODY_TOP}" +repage \
		-colorspace Gray -depth 8 gray:- |
		python3 "${INK_BANDS_PY}" "${BAND_W}" "${BODY_H}" "${BODY_TOP}" \
			"${INK_DELTA}" "${INK_PIXELS}"
}

band_count() { # <shot> -> how many controls the body drew
	local bands
	bands="$(ink_bands "$1")"
	if [ -z "${bands}" ]; then
		printf '0'
		return
	fi
	printf '%s' "$(printf '%s\n' "${bands}" | wc -l | tr -d ' ')"
}

# The field's own strokes, as `<top> <bottom>` rows: the page draws the field
# inside the dialog with an edge and no ground of its own, so a row where the
# whole strip is one tone above the dialog's ground is an edge of it, and the
# first pair of them a field's height apart is this field. The tone itself is
# not pinned, because the edge rises to the focus colour while the field holds
# the keyboard and stands at a hairline while it does not, and the page hands
# it the keyboard as it opens. Prose rows are several tones, which is what
# separates an edge from the label beside it. The scan starts clear of the
# dialog's own upper edge, which is a stroke across the same strip.
SEARCH_FIELD_PY="${TMPDIR}/settings-body-search-field.py"
cat >"${SEARCH_FIELD_PY}" <<'PY'
import sys
from collections import Counter

width, height, strip_left, strip_width, first, last = (int(argument) for argument in sys.argv[1:7])
pixels = sys.stdin.buffer.read()
if len(pixels) < width * height:
	raise SystemExit(f"the capture read {len(pixels)} bytes, short of {width * height}")

rows = range(max(0, first), min(height, last))


def strip_of(row: int) -> bytes:
	start = row * width + strip_left
	return pixels[start : start + strip_width]


ground = Counter(value for row in rows for value in strip_of(row)).most_common(1)[0][0]
strokes = [
	row
	for row in rows
	if len(set(strip_of(row))) == 1 and strip_of(row)[0] - ground >= 2
]
if len(strokes) < 2:
	raise SystemExit(
		f"the strip at +{strip_left} between {first} and {last} holds {len(strokes)} rows of the field's own edge over the dialog's ground {ground}, not the two a field is bounded by"
	)
top = strokes[0]
bottom = next((row for row in strokes if row - top >= 12), 0)
if not bottom:
	raise SystemExit(f"the edge rows after {top} are all within 12px of it, so no field is bounded by them")
print(top, bottom)
PY

# Sets SEARCH_Y, BODY_TOP and BODY_H from the field the page drew, and the
# rectangle the query is read back over. A take whose field is gone ends here,
# so a page that closed under a keystroke is never counted as a page that
# answered one.
measure_search_field() {
	local probe="${TMPDIR}/settings-body-search.png"
	probe_frame "${probe}"
	local screen reading
	screen="$(magick identify -format '%w %h' "${probe}")"
	if ! reading="$(magick "${probe}" -colorspace Gray -depth 8 gray:- |
		python3 "${SEARCH_FIELD_PY}" ${screen} "${SEARCH_STRIP_LEFT}" "${SEARCH_STRIP_W}" \
			"$(( DEST_TOP + 40 ))" "$(( DEST_TOP + 240 ))")"; then
		abandon_take "the-search-field-is-locatable" \
			"the settings page's search field was not found: ${reading:-the reader printed nothing}"
	fi
	read -r FIELD_TOP FIELD_BOTTOM <<<"${reading}"
	SEARCH_Y=$(( (FIELD_TOP + FIELD_BOTTOM) / 2 ))
	BODY_TOP=$(( FIELD_BOTTOM + MARGIN ))
	BODY_H=$(( DEST_TOP + DEST_H - MARGIN - BODY_TOP ))
	if (( BODY_H < 200 )); then
		abandon_take "the-search-field-is-locatable" \
			"the body under the field measured ${BODY_H}px, too short to hold the rows this scene counts"
	fi
	echo "scene: the search field is rows ${FIELD_TOP}..${FIELD_BOTTOM}, so the query is typed at" \
		"+${SEARCH_X}+${SEARCH_Y} and the body read ${COLUMN_W}x${BODY_H}+${COLUMN_LEFT}+${BODY_TOP}" >&2
}

# Whether the field is still drawn, for a step that asks what a keystroke did
# to the page rather than ending the take over it.
search_field_is_drawn() {
	local probe="${TMPDIR}/settings-body-probe.png"
	probe_frame "${probe}"
	local screen
	screen="$(magick identify -format '%w %h' "${probe}")"
	magick "${probe}" -colorspace Gray -depth 8 gray:- |
		python3 "${SEARCH_FIELD_PY}" ${screen} "${SEARCH_STRIP_LEFT}" "${SEARCH_STRIP_W}" \
			"$(( DEST_TOP + 40 ))" "$(( DEST_TOP + 240 ))" >/dev/null 2>&1
}

# What the field itself states, so a query that reached nothing ends the take
# instead of counting the page it left alone. The rectangle is the field's own
# band across the dialog, which holds the placeholder or the typed query and
# nothing else that moves between two shots.
query_ink_moved() { # <shot-before> <shot-after>
	use_crop "${DIALOG_LEFT}" "${FIELD_TOP}" "${DIALOG_W}" "$(( FIELD_BOTTOM - FIELD_TOP ))"
	shots_differ_pixels "$1" "$2"
}

# The General page, reached the way an operator reaches it: the palette, its
# `settings` row, and the page the row opens.
open_general_page() {
	k "ctrl+k"
	pause 0.3
	t "settings"
	pause 0.3
	k "Return"
	pause 0.3
	k "Return"
	pause 2.0
}
