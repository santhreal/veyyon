#!/usr/bin/env bash
# Have the host refuse a long value in the native GPUI window, and photograph
# what the refusal keeps of its own controls.
#
# Records visual evidence for:
#   1. long-refusal-rest      (the General page with nothing refused)
#   2. long-refusal-sent      (the same page after the host refused a long value)
#   3. long-refusal-dismissed (the page after a click where `Dismiss` belongs)
#
# THE CLAIM. A refusal keeps its own controls on the surface it is drawn on
# however long the host's sentence is. The after arm draws the sentence over
# two lines, ending in an ellipsis, with the `Dismiss` the refusal offers at
# the row's trailing edge, and a click there clears the refusal. The before arm
# draws the sentence on one line that takes the whole row and pushes `Dismiss`
# out past the page's edge, so the same click finds nothing and the refusal
# stays on the page.
#
# WHY THIS VALUE. `Argot Models` is a free-form array, so any valid JSON is
# sent as typed, and the host quotes the value it rejected back in full. An
# object carrying two hundred characters of text is refused with a sentence
# longer than the page is wide, over the wire the host already answers on: no
# credential, no network and no turn are involved. The refusal is final, so the
# row offers `Dismiss` and no `Retry`.
#
# WHAT IS MEASURED. Two readings of one colour, neither of them a word.
#
#   * How many pixel rows inside the settings page carry `tint.error.fill`.
#     Nothing else on the General page draws that colour, so the count is the
#     refusal row's height: one micro line of sentence with the row's padding
#     is 28 rows, two lines 36. The count states how many lines the row took,
#     and both arms draw the row over the same columns, so the height is the
#     only thing that moves.
#   * Whether that ground is still there after a click at the row's trailing
#     edge, at a point inside the row in both arms. A `Dismiss` under the
#     pointer clears the refusal and the colour goes to nothing; a `Dismiss`
#     pushed past the row's edge leaves every row of it.
#
# The colour is read from the theme this checkout ships, so a retheme moves the
# reading with the colour.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. The settings sheet is still between
# keystrokes, so the take carries a motion floor. Record it with:
#
#   SCENE_MOTION_FLOOR=4 proof/docker/record-native.sh \
#     proof/scenes/desktop-long-refusal.sh
#
# and its other arm against a build whose refusal row bounded nothing. The
# change is entirely inside the executable, so the arm holds no source:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=4 \
#     PROOF_NATIVE_BEFORE_BINARY=<pre-fix-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-long-refusal.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Settings Page Draws, And In Which Colours ─────────────────────
read -r PALETTE_W TITLEBAR_H MARGIN SHEET_H COLUMN_W BODY_INSET ERROR_FILL < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
palette = tomllib.loads((root / "tokens/surface/palette.toml").read_text())
shell = tomllib.loads((root / "tokens/surface/shell.toml").read_text())
settings = tomllib.loads((root / "tokens/surface/settings.toml").read_text())
scale = tomllib.loads((root / "tokens/scale.toml").read_text())
theme = tomllib.loads((root / "themes/dark.toml").read_text())
print(
	palette["geometry"]["width_px"],
	shell["titlebar"]["height_px"],
	scale["spacing"]["s4"],
	settings["layout"]["sheet_height_px"],
	settings["layout"]["control_column_width_px"],
	scale["spacing"]["s6"],
	theme["tint"]["error"]["fill"].lstrip("#").upper(),
)
PY
)
PALETTE_LEFT=$(( WIN_X + (WIN_W - PALETTE_W) / 2 ))
COLUMNS_H=$(( WIN_H - TITLEBAR_H ))
COLUMNS_CENTER_Y=$(( WIN_Y + TITLEBAR_H + COLUMNS_H / 2 ))
DEST_H=$(( COLUMNS_H - 2 * MARGIN ))
if (( DEST_H > SHEET_H )); then DEST_H=$SHEET_H; fi
DEST_TOP=$(( COLUMNS_CENTER_Y - DEST_H / 2 ))
if (( DEST_H < 480 )); then
	abandon_take "long-refusal-rest" \
		"the settings page is ${DEST_H}px tall, too short to hold the row this scene types into"
fi

PAGE_GEOM="${PALETTE_W}x${DEST_H}+${PALETTE_LEFT}+${DEST_TOP}"

# The row this scene types into: `argot.encode.models`, the ninth setting the
# host reports in key order, which eight wheel steps bring to the top of the
# list. Its value column ends a body inset short of the page's trailing edge.
SETTINGS_SCROLL_X=$(( PALETTE_LEFT + PALETTE_W / 2 ))
FIELD_X=$(( PALETTE_LEFT + PALETTE_W - BODY_INSET - COLUMN_W / 2 ))
FIELD_Y=$(( DEST_TOP + 88 ))

# Where the refusal's own `Dismiss` belongs: at the row's trailing edge, a
# button inset in, centred on the second of the two lines the bounded sentence
# takes. That point is inside the row in both arms -- the before arm's row is
# one line, but its padding still reaches this far down -- and only one of them
# puts a control there.
DISMISS_X=$(( PALETTE_LEFT + PALETTE_W - BODY_INSET - 36 ))
DISMISS_Y=$(( DEST_TOP + 94 ))

# The refusal row is as tall as the sentence it holds: one micro line of it
# with the row's padding is 28 pixel rows of ground, two lines 36. The floors
# sit between the two. Nothing else on the General page draws that colour, so a
# page with nothing refused reads zero.
ONE_LINE_ROWS_MAX=30
TWO_LINE_ROWS_MIN=33
QUIET_ROWS_MAX=2
# `[]` at rest is two glyphs of a 13px ramp; the object typed over it is far
# more. The rise is what says the press reached a field that takes text.
FIELD_INK_RISE=25
VALUE_GEOM="${COLUMN_W}x32+$(( FIELD_X - COLUMN_W / 2 ))+$(( FIELD_Y - 16 ))"

fill_rows() { # <shot> <geometry> <hex> -> pixel rows carrying exactly that colour
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local dump="${TMPDIR}/frame-compare/$1-$3.txt"
	mkdir -p "${TMPDIR}/frame-compare"
	magick "${png}" -crop "$2" +repage txt:- >"${dump}"
	python3 - "${dump}" "$3" <<'PY'
import re
import sys

pixel = re.compile(r"^\d+,(\d+): \([^)]*\)\s+#([0-9A-Fa-f]+)")
wanted = sys.argv[2][:6]
rows = set()
with open(sys.argv[1], encoding="ascii") as dump:
	for line in dump:
		match = pixel.match(line)
		if match and match.group(2).upper()[:6] == wanted:
			rows.add(int(match.group(1)))
print(len(rows))
PY
}

lit_pixels() { # <shot> <geometry> -> count of lit pixels in that rectangle
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local counted
	counted="$(magick "${png}" -crop "$2" +repage \
		-colorspace Gray -threshold 40% \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "value-ink-countable" \
				"counting the value column in $1 reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
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

# ─── Scroll To The Row, With Nothing Refused ─────────────────────────────────
move_px "${SETTINGS_SCROLL_X}" "${COLUMNS_CENTER_Y}"
wheel_down 8
pause 0.6
move_px "${SETTINGS_SCROLL_X}" "${COLUMNS_CENTER_Y}"
pause 0.4
shot long-refusal-rest
PAGE_REST="$(fill_rows long-refusal-rest "${PAGE_GEOM}" "${ERROR_FILL}")"
if [ "${PAGE_REST}" -gt "${QUIET_ROWS_MAX}" ]; then
	abandon_take "long-refusal-rest" \
		"the page already carried ${PAGE_REST} rows of error ground before anything was refused"
fi

# ─── Type A Long Value The Host Will Not Take ────────────────────────────────
VALUE_REST="$(lit_pixels long-refusal-rest "${VALUE_GEOM}")"
move_px "${FIELD_X}" "${FIELD_Y}"
click
pause 0.4
k "ctrl+a"
k "BackSpace"
pause 0.2
LONG_NOTE="$(printf 'a%.0s' $(seq 1 200))"
t "{\"model\":\"local/qwen2.5-1.5b\",\"note\":\"${LONG_NOTE}\"}"
pause 0.8
shot long-refusal-typed
VALUE_TYPED="$(lit_pixels long-refusal-typed "${VALUE_GEOM}")"
if [ "${VALUE_TYPED}" -lt $(( VALUE_REST + FIELD_INK_RISE )) ]; then
	abandon_take "long-refusal-typed" \
		"the press reached no field that takes text: value ink ${VALUE_REST} -> ${VALUE_TYPED}, under a rise of ${FIELD_INK_RISE}"
fi

# ─── Commit It And Let The Host Refuse ───────────────────────────────────────
move_px "${SETTINGS_SCROLL_X}" "${COLUMNS_CENTER_Y}"
k "Return"
pause 2.5
shot long-refusal-sent
PAGE_SENT="$(fill_rows long-refusal-sent "${PAGE_GEOM}" "${ERROR_FILL}")"
if [ "${PAGE_SENT}" -lt 12 ]; then
	abandon_take "long-refusal-sent" \
		"nothing was refused: the page drew ${PAGE_SENT} rows of error ground"
fi

# ─── Press Where The Refusal's Own Control Belongs ───────────────────────────
move_px "${DISMISS_X}" "${DISMISS_Y}"
pause 0.4
click
pause 1.2
shot long-refusal-dismissed
PAGE_AFTER_CLICK="$(fill_rows long-refusal-dismissed "${PAGE_GEOM}" "${ERROR_FILL}")"

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${PAGE_SENT}" -gt "${ONE_LINE_ROWS_MAX}" ]; then
		abandon_take "long-refusal-sent" \
			"the baseline already bounded the sentence: ${PAGE_SENT} rows of error ground, over ${ONE_LINE_ROWS_MAX}"
	fi
	if [ "${PAGE_AFTER_CLICK}" -lt "${PAGE_SENT}" ]; then
		abandon_take "long-refusal-dismissed" \
			"the baseline answered the press at the row's trailing edge: ${PAGE_SENT} -> ${PAGE_AFTER_CLICK} rows of error ground"
	fi
	echo "scene: before arm -- the sentence took ${PAGE_SENT} rows on one line and the press at the row's trailing edge left ${PAGE_AFTER_CLICK} of them: Dismiss was pushed off the row" >&2
else
	if [ "${PAGE_SENT}" -lt "${TWO_LINE_ROWS_MIN}" ]; then
		abandon_take "long-refusal-sent" \
			"the refusal drew ${PAGE_SENT} rows of error ground, under the ${TWO_LINE_ROWS_MIN} two lines of it take"
	fi
	if [ "${PAGE_AFTER_CLICK}" -gt "${QUIET_ROWS_MAX}" ]; then
		abandon_take "long-refusal-dismissed" \
			"the press where Dismiss belongs left ${PAGE_AFTER_CLICK} rows of error ground on the page"
	fi
	echo "scene: after arm -- the sentence took ${PAGE_SENT} rows over two lines and the press on Dismiss cleared it to ${PAGE_AFTER_CLICK}: the control stayed on the page" >&2
fi
