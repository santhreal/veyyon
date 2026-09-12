#!/usr/bin/env bash
# Aim the pointer at a settings row's control column and at a queue card an open
# dialog covers, and photograph what each press reaches.
#
# Records visual evidence for:
#   1. settings-column-rest    (the Argot Models row at rest, its field drawn)
#   2. settings-column-aimed   (the same row after a press at the column's
#                               leading third and four keystrokes)
#   3. settings-column-through (the window after a press over the scrim, on a
#                               queue card the dialog covers, and Escape)
#
# WHAT IS MEASURED. Two regions, each reduced to pixels rather than compared as
# whole frames, because the queue's elapsed times tick between any two shots:
#
#   * The LEADING HALF of the row's control column. The column is 240px wide and
#     ends a body inset short of the dialog's trailing edge, so its leading half
#     is where a field that takes the column's width draws its value and where a
#     field collapsed to its own padding draws nothing at all.
#   * The titlebar's centre, which states the name of the session the window is
#     showing. A press that reaches a queue card behind the dialog selects that
#     session and rewrites this region; a press the dialog swallows leaves it
#     byte-identical to the frame before the press.
#
# THE ARMS. The after arm's field draws its value in the leading half, takes the
# press at the point the pointer landed, and the press over the scrim reaches no
# card. The before arm's field sits past the leading half holding nothing there,
# the press at that point lands on ground, and the press over the scrim selects
# the session behind it. Each arm is guarded in the direction it is true in, so a
# mis-aimed press fails the before arm rather than passing both.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-settings-column.sh
#
# and its other arm against a build whose scrim, popover and control column are
# the pre-fix ones. The change is entirely inside the executable, so the arm
# holds no source:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=<pre-fix-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-settings-column.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Dialog And Its Control Column Draw ────────────────────────────
# Read from the tokens this checkout ships, so a retheme moves the crops with
# the surfaces instead of leaving them measuring the backdrop.
read -r PALETTE_W TITLEBAR_H MARGIN COLUMN_W BODY_INSET SHEET_H < <(
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
	settings["layout"]["sheet_height_px"],
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
	abandon_take "settings-column-rest" \
		"the settings dialog is ${DEST_H}px tall, too short to hold the row this scene presses"
fi

# The row this scene presses: twelve wheel steps down the General page, where
# the value column of `Argot Models` sits.
SETTINGS_SCROLL_X=$(( PALETTE_LEFT + PALETTE_W / 2 ))
ROW_Y=$(( DEST_TOP + 190 ))
COLUMN_RIGHT=$(( PALETTE_LEFT + PALETTE_W - BODY_INSET ))
COLUMN_LEFT=$(( COLUMN_RIGHT - COLUMN_W ))
LEAD_W=$(( COLUMN_W / 2 ))
LEAD_X=${COLUMN_LEFT}
LEAD_Y=$(( ROW_Y - 16 ))
LEAD_H=32
# The press lands in the leading third of the column, which is inside a field
# that takes the column's width and outside one collapsed to its own padding.
AIM_X=$(( COLUMN_LEFT + COLUMN_W / 3 ))

# The second card of the queue rail, which the dialog covers with its scrim
# rather than with its own rect.
CARD_X=$(( WIN_X + 130 ))
CARD_Y=$(( WIN_Y + 258 ))

# The titlebar's centre, where the name of the session on screen is drawn.
NAME_W=300
NAME_H=32
NAME_X=$(( WIN_X + WIN_W / 2 - NAME_W / 2 ))
NAME_Y=$(( WIN_Y + 8 ))

# `[]` in the leading half is two glyphs of a 13px body ramp: a few dozen lit
# pixels where a collapsed field leaves ground. Four typed letters ink several
# dozen more, and both arms are judged against these rather than each other.
LEAD_FLOOR=10
AIM_RISE=30
# A session name is one 13px line: a few hundred ink pixels, so a name replaced
# by another moves far more than this renderer's own frame-to-frame noise, which
# the turn-footer scene measured at 26 pixels over a region seventy times this
# crop.
NAME_CHANGE_MIN=150
NAME_NOISE_MAX=40

lead_ink_pixels() { # <shot> -> lit pixels in the leading half of the column
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local counted
	counted="$(magick "${png}" \
		-crop "${LEAD_W}x${LEAD_H}+${LEAD_X}+${LEAD_Y}" +repage \
		-colorspace Gray -threshold 40% \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "lead-ink-countable" \
				"counting the column's leading half in $1 reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
}

name_pixels_changed() { # <shot> <shot> -> pixels differing in the titlebar name
	local scratch="${TMPDIR}/name-compare"
	mkdir -p "${scratch}"
	local crop="${NAME_W}x${NAME_H}+${NAME_X}+${NAME_Y}" changed
	magick "${SCENE_OUT}/${SCENE_NAME}-$1.png" -crop "${crop}" +repage "${scratch}/a.png"
	magick "${SCENE_OUT}/${SCENE_NAME}-$2.png" -crop "${crop}" +repage "${scratch}/b.png"
	# `compare` exits non-zero whenever the two images differ at all, so only
	# the count it prints is read.
	changed="$(compare -metric AE "${scratch}/a.png" "${scratch}/b.png" null: 2>&1 || true)"
	case "${changed}" in
		'' | *[!0-9]*)
			abandon_take "name-diff-countable" \
				"comparing the titlebar name of $1 and $2 reported '${changed}' instead of a pixel count"
			;;
	esac
	printf '%s' "${changed}"
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

# ─── The Row At Rest ─────────────────────────────────────────────────────────
move_px "${SETTINGS_SCROLL_X}" "${COLUMNS_CENTER_Y}"
wheel_down 12
pause 0.6
shot settings-column-rest
REST="$(lead_ink_pixels settings-column-rest)"

# ─── A Press At The Column's Leading Third ───────────────────────────────────
move_px "${AIM_X}" "${ROW_Y}"
click
pause 0.4
t "qwen"
pause 0.6
shot settings-column-aimed
AIMED="$(lead_ink_pixels settings-column-aimed)"

# ─── A Press Over The Scrim, On A Card The Dialog Covers ─────────────────────
move_px "${CARD_X}" "${CARD_Y}"
click
pause 0.6
k "Escape"
pause 1.2
shot settings-column-through
SELECTED="$(name_pixels_changed settings-column-aimed settings-column-through)"

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${REST}" -ge "${LEAD_FLOOR}" ]; then
		abandon_take "settings-column-rest" \
			"the baseline drew a value in the column's leading half: ${REST} lit pixels, at or over ${LEAD_FLOOR}"
	fi
	if [ "${AIMED}" -ge $(( REST + AIM_RISE )) ]; then
		abandon_take "settings-column-aimed" \
			"the baseline took the press at the column's leading third: lead ink ${REST} -> ${AIMED}"
	fi
	if [ "${SELECTED}" -lt "${NAME_CHANGE_MIN}" ]; then
		abandon_take "settings-column-through" \
			"the press over the scrim reached no card in the baseline either: ${SELECTED} pixels of the session name changed, under ${NAME_CHANGE_MIN}, so this arm proves nothing about the scrim"
	fi
	echo "scene: before arm -- lead ink ${REST} -> ${AIMED}, and the press behind the scrim moved ${SELECTED} pixels of the session name" >&2
else
	if [ "${REST}" -lt "${LEAD_FLOOR}" ]; then
		abandon_take "settings-column-rest" \
			"the field drew nothing in the column's leading half: ${REST} lit pixels, under ${LEAD_FLOOR}"
	fi
	if [ "${AIMED}" -lt $(( REST + AIM_RISE )) ]; then
		abandon_take "settings-column-aimed" \
			"the press at the column's leading third reached no field: lead ink ${REST} -> ${AIMED}, under a rise of ${AIM_RISE}"
	fi
	if [ "${SELECTED}" -gt "${NAME_NOISE_MAX}" ]; then
		abandon_take "settings-column-through" \
			"the press over the scrim reached a card behind it: ${SELECTED} pixels of the session name changed, over the ${NAME_NOISE_MAX} this renderer's own noise moves"
	fi
	echo "scene: after arm -- lead ink ${REST} -> ${AIMED}, and the press behind the scrim left the session name untouched" >&2
fi
