#!/usr/bin/env bash
# Have the host refuse a value typed into a real General settings row in the
# native GPUI window, and photograph where the refusal is stated.
#
# Records visual evidence for:
#   1. settings-refusal-rest   (the General page with nothing refused)
#   2. settings-refusal-typed  (the row with the value that will be refused)
#   3. settings-refusal-sent   (the same page after the host refused it)
#
# THE CLAIM. A page of the settings sheet states the refusal of what that page
# asked for. The after arm draws the host's sentence on the page, under its
# header, with the `Dismiss` the refusal offers. The before arm draws the same
# sentence across the top of the window, above the titlebar's content and away
# from the row that sent it, because every request the sheet sends resolved to
# the window's own line rather than to a control the sheet draws.
#
# WHY THIS ROW. `Argot Models` is a free-form array, so it takes the JSON text
# control: any valid JSON is sent as typed. An object is valid JSON and is not
# a list of model ids, so the host answers `INVALID_VALUE` over the wire it
# already answers on, with no credential, no network and no turn involved. The
# refusal is final, so the row offers `Dismiss` and no `Retry`.
#
# WHAT IS MEASURED. Two colours, each counted where only one thing draws it.
# `tint.error.fill` inside the settings page is the ground `error_hairline`
# carries, which nothing else on the General page draws. `tint.attention.fill`
# in the band under the titlebar is the ground of the window's attention strip,
# which is where an unrouted refusal lands. Both are read from the theme this
# checkout ships, so a retheme moves the reading with the colour.
#
# Counting a ground rather than differencing the frames keeps the reading off
# the queue's elapsed times, which tick between any two shots.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. The settings sheet is still between
# keystrokes, so the take carries a motion floor. Record it with:
#
#   SCENE_MOTION_FLOOR=4 proof/docker/record-native.sh \
#     proof/scenes/desktop-settings-refusal.sh
#
# and its other arm against a build that routed every sheet request to the
# window's line. The change is entirely inside the executable, so the arm holds
# no source:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD SCENE_MOTION_FLOOR=4 \
#     PROOF_NATIVE_BEFORE_BINARY=<pre-fix-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-settings-refusal.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Settings Page Draws, And In Which Colours ─────────────────────
# Read from the tokens and the theme this checkout ships, the way
# desktop-settings-field does, so a retheme moves the crop and the colours with
# the surface instead of leaving them measuring the backdrop.
read -r PALETTE_W TITLEBAR_H MARGIN SHEET_H COLUMN_W BODY_INSET ERROR_FILL ATTENTION_FILL < <(
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
	theme["tint"]["attention"]["fill"].lstrip("#").upper(),
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
	abandon_take "settings-refusal-rest" \
		"the settings page is ${DEST_H}px tall, too short to hold the row this scene types into"
fi

# The page, and the band the window's own line draws in. The band starts under
# the titlebar and is deeper than the strip, so the strip is inside it wherever
# a micro line lands.
PAGE_GEOM="${PALETTE_W}x${DEST_H}+${PALETTE_LEFT}+${DEST_TOP}"
STRIP_GEOM="${WIN_W}x40+${WIN_X}+$(( WIN_Y + TITLEBAR_H ))"

# The row this scene types into. The page lists every setting the host reports
# in key order, so `argot.encode.models` is the ninth of them and eight wheel
# steps bring it to the top of the list: one step is one row. Its value column
# ends a body inset short of the page's trailing edge and is as wide as the
# tokens declare, so the press lands at its centre wherever the page draws,
# half a row below the top of the list.
SETTINGS_SCROLL_X=$(( PALETTE_LEFT + PALETTE_W / 2 ))
FIELD_X=$(( PALETTE_LEFT + PALETTE_W - BODY_INSET - COLUMN_W / 2 ))
FIELD_Y=$(( DEST_TOP + 88 ))
# The crop the typed value is counted in: that row's whole value column, never
# reaching the label column beside it.
VALUE_GEOM="${COLUMN_W}x32+$(( FIELD_X - COLUMN_W / 2 ))+$(( FIELD_Y - 16 ))"

# A refusal row is the page's width less its insets by a micro line's height:
# several thousand lit pixels. A strip is the window's width by the same
# height. Both floors sit far under what either draws and far over the few
# antialiased pixels a rounded corner leaves.
ROW_FILL_MIN=3000
STRIP_FILL_MIN=5000
QUIET_MAX=200
# `[]` at rest is two glyphs of a 13px ramp; the object typed over it is
# thirty. The rise is what says the press reached a field that takes text
# rather than a row beside it.
FIELD_INK_RISE=25

fill_pixels() { # <shot> <geometry> <hex> -> count of pixels of exactly that colour
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local dump="${SCENE_RUNTIME_DIR}/frame-compare/$1-$3.txt"
	mkdir -p "${SCENE_RUNTIME_DIR}/frame-compare"
	magick "${png}" -crop "$2" +repage txt:- >"${dump}"
	python3 - "${dump}" "$3" <<'PY'
import re
import sys

pixel = re.compile(r"^\d+,\d+: \([^)]*\)\s+#([0-9A-Fa-f]+)")
wanted = sys.argv[2]
counted = 0
with open(sys.argv[1], encoding="ascii") as dump:
	for line in dump:
		match = pixel.match(line)
		if match and match.group(1).upper()[:6] == wanted[:6]:
			counted += 1
print(counted)
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
shot settings-refusal-rest
PAGE_REST="$(fill_pixels settings-refusal-rest "${PAGE_GEOM}" "${ERROR_FILL}")"
STRIP_REST="$(fill_pixels settings-refusal-rest "${STRIP_GEOM}" "${ATTENTION_FILL}")"
if [ "${PAGE_REST}" -gt "${QUIET_MAX}" ]; then
	abandon_take "settings-refusal-rest" \
		"the page already carried ${PAGE_REST} pixels of error ground before anything was refused"
fi
if [ "${STRIP_REST}" -gt "${QUIET_MAX}" ]; then
	abandon_take "settings-refusal-rest" \
		"the window already carried ${STRIP_REST} pixels of attention ground before anything was refused"
fi

# ─── Type A Value The Host Will Not Take ─────────────────────────────────────
# The select-all clears what the host reported, so what is sent is exactly what
# is typed: an object where the setting declares a list.
VALUE_REST="$(lit_pixels settings-refusal-rest "${VALUE_GEOM}")"
move_px "${FIELD_X}" "${FIELD_Y}"
click
pause 0.4
k "ctrl+a"
k "BackSpace"
pause 0.2
t '{"model":"local/qwen2.5-1.5b"}'
pause 0.8
shot settings-refusal-typed
VALUE_TYPED="$(lit_pixels settings-refusal-typed "${VALUE_GEOM}")"
if [ "${VALUE_TYPED}" -lt $(( VALUE_REST + FIELD_INK_RISE )) ]; then
	abandon_take "settings-refusal-typed" \
		"the press reached no field that takes text: value ink ${VALUE_REST} -> ${VALUE_TYPED}, under a rise of ${FIELD_INK_RISE}"
fi

# ─── Commit It And Let The Host Refuse ───────────────────────────────────────
k "Return"
pause 2.5
shot settings-refusal-sent
PAGE_SENT="$(fill_pixels settings-refusal-sent "${PAGE_GEOM}" "${ERROR_FILL}")"
STRIP_SENT="$(fill_pixels settings-refusal-sent "${STRIP_GEOM}" "${ATTENTION_FILL}")"

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${STRIP_SENT}" -lt "${STRIP_FILL_MIN}" ]; then
		abandon_take "settings-refusal-sent" \
			"nothing was refused: the window's line drew ${STRIP_SENT} pixels of attention ground, under ${STRIP_FILL_MIN}"
	fi
	if [ "${PAGE_SENT}" -ge "${ROW_FILL_MIN}" ]; then
		abandon_take "settings-refusal-sent" \
			"the baseline already stated the refusal on the page: ${PAGE_SENT} pixels of error ground"
	fi
	echo "scene: before arm -- page error ground ${PAGE_REST} -> ${PAGE_SENT}, window line ${STRIP_REST} -> ${STRIP_SENT}: the refusal was stated across the window, not on the page that asked" >&2
else
	if [ "${PAGE_SENT}" -lt "${ROW_FILL_MIN}" ]; then
		abandon_take "settings-refusal-sent" \
			"the page stated nothing: ${PAGE_SENT} pixels of error ground, under ${ROW_FILL_MIN}"
	fi
	if [ "${STRIP_SENT}" -gt "${QUIET_MAX}" ]; then
		abandon_take "settings-refusal-sent" \
			"the window's line kept the refusal as well: ${STRIP_SENT} pixels of attention ground"
	fi
	echo "scene: after arm -- page error ground ${PAGE_REST} -> ${PAGE_SENT}, window line ${STRIP_REST} -> ${STRIP_SENT}: the page that asked stated the refusal" >&2
fi
