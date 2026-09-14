#!/usr/bin/env bash
# Rebind a keymap action from the Keybindings page in the native GPUI window,
# and photograph what the row holds, what the host stored, and what a chord no
# key press matches is answered with.
#
# Records visual evidence for:
#   1. keybinding-rest     (the first row at the chords the host reports)
#   2. keybinding-typed    (the same row while new chords are being typed)
#   3. keybinding-stored   (the row after Enter, redrawn from the host)
#   4. keybinding-refused  (the strip a chord no press matches is answered with)
#
# WHY THIS ROW. The first row of the page is whatever the host reports first,
# so the scene rebinds an action it did not choose, and the chords it types
# (`ctrl-alt-9`) are bound to nothing else, so a take never rebinds a chord the
# next take needs.
#
# WHAT IS MEASURED. Two readings, each over a rectangle rather than a whole
# frame, because the queue rail's elapsed times tick between any two shots:
#
#   * WHAT THE ROW HOLDS: the lit pixels of the row's control column. Chords
#     drawn as chips at rest, several more glyphs once a longer pair is typed,
#     and the same count again once the host has answered.
#   * WHAT A REFUSAL DRAWS: the pixels that change in the band under the
#     titlebar, which is where the attention strip opens. A refusal states
#     itself there and the page keeps the binding it had.
#
# THE ARMS. The after arm's count rises while the chords are typed and stays
# risen once the host has stored them, and the refusal opens the strip. The
# before arm draws the same row and takes the same keystrokes: the row was a
# read-only chip of what the host reported, so its count does not move and
# nothing is refused, because nothing was submitted.
#
# NOT RECORDED HERE: the Agents page's task field, which spawns a subagent. Its
# sender is asserted at the action level by
# `crates/veyyon-desktop/tests/every-action-the-host-answers-has-a-control-that-sends-it.rs`,
# which sweeps every host action through the real window, and its field is the
# same retained editor this scene photographs.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-settings-keybinding.sh
#
# The change is entirely inside the executable, so the before arm holds no
# source and takes a build of HEAD with the field taken back out of it:
#
#   SANTH_BUILD_GOVERNED=1 python3 .internal/build-commit-before.py \
#     --holdback .internal/before-edits/keybinding.patch keybinding-before
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=.internal/captures/keybinding-before/veyyon-desktop \
#     proof/docker/record-native.sh proof/scenes/desktop-settings-keybinding.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Dialog, Its Rows And The Strip Draw ───────────────────────────
# Read from the tokens this checkout ships, so a retheme moves the crops with
# the surfaces instead of leaving them measuring the backdrop.
read -r DIALOG_W TITLEBAR_H MARGIN COLUMN_W BODY_INSET ROW_H ROW_GAP STRIP_H SHEET_H < <(
	python3 - "${BASH_SOURCE[0]%/*}/../../crates/veyyon-desktop-tokens/tokens" <<'PY'
from pathlib import Path
import sys
import tomllib

root = Path(sys.argv[1])
palette = tomllib.loads((root / "surface/palette.toml").read_text())
shell = tomllib.loads((root / "surface/shell.toml").read_text())
settings = tomllib.loads((root / "surface/settings.toml").read_text())
scale = tomllib.loads((root / "scale.toml").read_text())
# The attention strip is one line of the micro ramp with one spacing step above
# and below it, which is what `attention_strip_height` comes to.
strip = 2 * scale["spacing"]["s2"] + scale["type"]["size"]["micro"]["line_height"]
print(
	palette["geometry"]["width_px"],
	shell["titlebar"]["height_px"],
	scale["spacing"]["s4"],
	settings["layout"]["control_column_width_px"],
	scale["spacing"]["s6"],
	settings["layout"]["row_height_px"],
	scale["spacing"][settings["layout"]["row_gap"]],
	int(strip),
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
	abandon_take "keybinding-rest" \
		"the settings dialog is ${DEST_H}px tall, too short to hold the row this scene rebinds"
fi

# The body of the page: below the dialog's own header and the page's title,
# which are drawn once and are not rows. The control column ends a body inset
# short of the dialog's trailing edge and is as wide as the tokens declare.
BODY_TOP=$(( DEST_TOP + 120 ))
COLUMN_RIGHT=$(( DIALOG_LEFT + DIALOG_W - BODY_INSET ))
COLUMN_LEFT=$(( COLUMN_RIGHT - COLUMN_W ))
# The row a press lands in and every reading counts. The crop is that row's
# whole control column, so it holds the chords at rest and everything typed
# over them, and never reaches the label column beside it. The row below it is
# where the press that takes the keyboard back off this field goes: an
# unfocused field is redrawn from the value the host reports, and a focused one
# is left alone, so a reading of what was stored has to be taken with the
# keyboard somewhere else.
FIELD_X=$(( COLUMN_RIGHT - COLUMN_W / 2 ))
FIELD_Y=$(( BODY_TOP + ROW_H / 2 ))
NEXT_FIELD_Y=$(( FIELD_Y + ROW_H + ROW_GAP ))
VALUE_CROP_H=${ROW_H}
VALUE_CROP_Y=$(( BODY_TOP ))

# The band the attention strip opens in: directly under the titlebar, above the
# columns row, which is what the strip displaces when it appears.
STRIP_CROP_Y=$(( WIN_Y + TITLEBAR_H ))

# A pair of chords is a dozen glyphs of a 13px ramp, a few hundred lit pixels
# against the one or two chips a row states at rest. The arm is judged on how
# the count moves rather than on an absolute, and the floor is well inside the
# gap the two states measured on this renderer.
FIELD_INK_RISE=60
# The strip is one line of prose across the window on its own ground: several
# thousand pixels of the band, against a renderer noise measured at 26 pixels
# over a crop of this size by the turn-footer scene.
STRIP_CHANGE_MIN=2000
STRIP_NOISE_MAX=200

value_ink_pixels() { # <shot> -> count of lit pixels in the row's control column
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local counted
	counted="$(magick "${png}" \
		-crop "${COLUMN_W}x${VALUE_CROP_H}+${COLUMN_LEFT}+${VALUE_CROP_Y}" +repage \
		-colorspace Gray -threshold 40% \
		-format '%[fx:round(mean*w*h)]' info: 2>/dev/null || true)"
	case "${counted}" in
		'' | *[!0-9]*)
			abandon_take "value-ink-countable" \
				"counting the control column in $1 reported '${counted}' instead of a pixel count"
			;;
	esac
	printf '%s' "${counted}"
}

# ─── Open The Keybindings Page ───────────────────────────────────────────────
k "ctrl+k"
pause 0.3
t "hotkeys"
pause 0.5
k "Return"
pause 2.0

# The pointer is parked outside the dialog, so the resting frame carries no
# hover of its own for a later comparison to read as a change.
move_px "$(( WIN_X + 40 ))" "$(( WIN_Y + WIN_H - 40 ))"
pause 0.5
shot keybinding-rest
REST="$(value_ink_pixels keybinding-rest)"
if [ "${REST}" -lt 1 ]; then
	abandon_take "keybinding-rest" \
		"the first row's control column holds no ink, so the Keybindings page did not open at ${COLUMN_LEFT}+${VALUE_CROP_Y}"
fi

# ─── Type A Pair Of Chords Into It ───────────────────────────────────────────
# The click lands in the row's control, and the select-all clears whatever the
# host reported so the count measures only what was typed.
move_px "${FIELD_X}" "${FIELD_Y}"
click
pause 0.4
k "ctrl+a"
k "BackSpace"
pause 0.2
t "ctrl-alt-9, ctrl-alt-0"
pause 0.8
shot keybinding-typed
TYPED="$(value_ink_pixels keybinding-typed)"

# ─── Commit It And Read Back What The Host Stored ────────────────────────────
# A focused field is left alone when a snapshot arrives, so a frame taken with
# the keyboard still in it would state the keystrokes whatever the host did
# with them. The press on the row below hands the keyboard over, which redraws
# this row from the binding the host reports: a risen count is then the host's
# own value, and a submit that never reached it draws the chords the row
# started at. Both readings are of an unfocused field, so neither carries the
# ring a focused one draws.
k "Return"
pause 2.0
move_px "${FIELD_X}" "${NEXT_FIELD_Y}"
click
pause 1.2
shot keybinding-stored
STORED="$(value_ink_pixels keybinding-stored)"

# ─── A Chord No Press Matches Is Refused Rather Than Written ─────────────────
# The grammar joins a chord's modifiers to its key with `-`, so `ctrl alt` is
# one token with a space in it and names no key at all. §9.3 refuses it where
# it was typed instead of writing a binding to the keymap that no key press
# would ever match.
move_px "${FIELD_X}" "${FIELD_Y}"
click
pause 0.3
k "ctrl+a"
k "BackSpace"
pause 0.2
t "ctrl alt"
pause 0.4
k "Return"
pause 1.2
shot keybinding-refused

use_crop "${WIN_X}" "${STRIP_CROP_Y}" "${WIN_W}" "${STRIP_H}"
REFUSED="$(shots_differ_pixels keybinding-stored keybinding-refused)"

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${TYPED}" -ge $(( REST + FIELD_INK_RISE )) ]; then
		abandon_take "keybinding-typed" \
			"the baseline drew what was typed: control ink ${REST} -> ${TYPED}, a rise of at least ${FIELD_INK_RISE}"
	fi
	if [ "${REFUSED}" -gt "${STRIP_NOISE_MAX}" ]; then
		abandon_take "keybinding-refused" \
			"the baseline answered the submit: ${REFUSED} pixels changed in the strip band, over the ${STRIP_NOISE_MAX} this renderer's noise moves"
	fi
	echo "scene: before arm -- control ink ${REST} -> ${TYPED} -> ${STORED}, and the strip band moved ${REFUSED} pixels" >&2
else
	if [ "${TYPED}" -lt $(( REST + FIELD_INK_RISE )) ]; then
		abandon_take "keybinding-typed" \
			"the row drew nothing of the chords typed into it: control ink ${REST} -> ${TYPED}, under a rise of ${FIELD_INK_RISE}"
	fi
	if [ "${STORED}" -lt $(( REST + FIELD_INK_RISE )) ]; then
		abandon_take "keybinding-stored" \
			"the chords did not survive the commit: control ink ${REST} -> ${TYPED} -> ${STORED}"
	fi
	if [ "${REFUSED}" -lt "${STRIP_CHANGE_MIN}" ]; then
		abandon_take "keybinding-refused" \
			"a chord no press matches changed ${REFUSED} pixels in the strip band, under the ${STRIP_CHANGE_MIN} a line of prose draws, so it was taken rather than refused"
	fi
	echo "scene: after arm -- control ink ${REST} -> ${TYPED} -> ${STORED}, and the refusal drew ${REFUSED} pixels of strip" >&2
fi
