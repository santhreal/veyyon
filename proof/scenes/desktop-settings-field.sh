#!/usr/bin/env bash
# Type into a real General settings field in the native GPUI window and
# photograph what the field holds and what the host stored.
#
# Records visual evidence for:
#   1. settings-field-rest    (the Argot Models row at the value the host reports)
#   2. settings-field-typed   (the same row while a new value is being typed)
#   3. settings-field-stored  (the row after Enter, redrawn from the host)
#
# WHY THIS ROW. `Argot Models` is a free-form array: no declared choices, so it
# takes the JSON text control, which is one of the four kinds whose field was
# drawn from its value and carried no keystroke. It is reachable from the
# palette without a credential, and its value is a list of model ids, so a turn
# is never sent to whatever is typed here.
#
# WHAT IS MEASURED. The value column of that row is reduced to its count of lit
# pixels: `[]` at rest is two glyphs, and a typed value is several more. The
# arms are judged on how that count moves between the three frames, because a
# whole-frame difference cannot separate the field from the queue's own elapsed
# times, which tick between any two shots.
#
# The before arm draws the same row and takes the same keystrokes, and its
# count does not move: an element is rebuilt every frame, so the field a
# keystroke reached is discarded before the next frame draws the value again.
# The after arm's count rises while the value is typed and stays risen once the
# host has stored it.
#
# NOT RECORDED HERE: the secret field, which needs a provider that is waiting
# on a key, so a capture of it would have to unauthenticate the recorder's
# profile. Its behaviour is asserted at the value level by
# `crates/veyyon-desktop/tests/a-field-sends-what-the-operator-typed-into-it.rs`
# through the same window, and its mask by
# `crates/veyyon-desktop-kit/tests/a-masked-field-draws-nothing-of-what-it-holds.rs`
# over the drawn pixels.
#
# Sourced by proof/docker/xsession.sh with SCENE_WINDOW, SCENE_NAME, SCENE_OUT
# and SCENE_LIB already initialized. Record it with:
#
#   proof/docker/record-native.sh proof/scenes/desktop-settings-field.sh
#
# and its other arm against a build whose fields are ephemeral again. The
# change is entirely inside the executable, so the arm holds no source:
#
#   SCENE_ARM=before PROOF_BASE_REF=HEAD \
#     PROOF_NATIVE_BEFORE_BINARY=<pre-fix-build> \
#     proof/docker/record-native.sh proof/scenes/desktop-settings-field.sh
set -euo pipefail

source "${BASH_SOURCE[0]%/*}/desktop-composer.sh"

# ─── Where The Settings Dialog Draws ─────────────────────────────────────────
# Read from the tokens this checkout ships, the way desktop-surface-navigation
# does, so a retheme moves the crop with the dialog instead of leaving it
# measuring the backdrop.
read -r PALETTE_W TITLEBAR_H MARGIN COLUMN_W BODY_INSET < <(
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
)
PY
)
PALETTE_LEFT=$(( WIN_X + (WIN_W - PALETTE_W) / 2 ))
COLUMNS_H=$(( WIN_H - TITLEBAR_H ))
COLUMNS_CENTER_Y=$(( WIN_Y + TITLEBAR_H + COLUMNS_H / 2 ))
DEST_H=$(( COLUMNS_H - 2 * MARGIN ))
if (( DEST_H > 560 )); then DEST_H=560; fi
DEST_TOP=$(( COLUMNS_CENTER_Y - DEST_H / 2 ))
if (( DEST_H < 480 )); then
	abandon_take "settings-field-rest" \
		"the settings dialog is ${DEST_H}px tall, too short to hold the row this scene types into"
fi

# The scroll column, and the row this scene types into: twelve wheel steps down
# the General page, where the value column of `Argot Models` sits. The column
# ends a body inset short of the dialog's trailing edge and is as wide as the
# tokens declare, so the press lands at its centre wherever the dialog draws.
SETTINGS_SCROLL_X=$(( PALETTE_LEFT + PALETTE_W / 2 ))
COLUMN_RIGHT=$(( PALETTE_LEFT + PALETTE_W - BODY_INSET ))
FIELD_X=$(( COLUMN_RIGHT - COLUMN_W / 2 ))
FIELD_Y=$(( DEST_TOP + 190 ))
# The crop is the row's whole value column, so it holds the field's value at
# rest and everything typed into it, and never reaches the label column beside
# it.
VALUE_CROP_W=${COLUMN_W}
VALUE_CROP_H=32
VALUE_CROP_X=$(( COLUMN_RIGHT - COLUMN_W ))
VALUE_CROP_Y=$(( FIELD_Y - 16 ))

# `[]` is two glyphs of a 13px body ramp, a few dozen lit pixels. A typed
# `["a"]` is five, and the arm is judged on the rise rather than an absolute.
FIELD_INK_RISE=25

value_ink_pixels() { # <shot> -> count of lit pixels in the row's value column
	local png="${SCENE_OUT}/${SCENE_NAME}-$1.png"
	local counted
	counted="$(magick "${png}" \
		-crop "${VALUE_CROP_W}x${VALUE_CROP_H}+${VALUE_CROP_X}+${VALUE_CROP_Y}" +repage \
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

# ─── Scroll To The Row ───────────────────────────────────────────────────────
move_px "${SETTINGS_SCROLL_X}" "${COLUMNS_CENTER_Y}"
wheel_down 12
pause 0.6
shot settings-field-rest
REST="$(value_ink_pixels settings-field-rest)"

# ─── Type Into It ────────────────────────────────────────────────────────────
# The click lands in the field, and the select-all clears whatever the host
# reported so the count measures only what was typed.
move_px "${FIELD_X}" "${FIELD_Y}"
click
pause 0.4
k "ctrl+a"
k "BackSpace"
pause 0.2
t '["local/qwen2.5-1.5b"]'
pause 0.8
shot settings-field-typed
TYPED="$(value_ink_pixels settings-field-typed)"

# ─── Commit It And Let The Host Answer ───────────────────────────────────────
k "Return"
pause 2.0
shot settings-field-stored
STORED="$(value_ink_pixels settings-field-stored)"

if [ "${SCENE_ARM:-after}" = "before" ]; then
	if [ "${TYPED}" -ge $(( REST + FIELD_INK_RISE )) ]; then
		abandon_take "settings-field-typed" \
			"the baseline drew what was typed: value ink ${REST} -> ${TYPED}, a rise of at least ${FIELD_INK_RISE}"
	fi
	echo "scene: before arm -- value ink ${REST} -> ${TYPED} -> ${STORED}, the row drew none of it" >&2
else
	if [ "${TYPED}" -lt $(( REST + FIELD_INK_RISE )) ]; then
		abandon_take "settings-field-typed" \
			"the field drew nothing of what was typed: value ink ${REST} -> ${TYPED}, under a rise of ${FIELD_INK_RISE}"
	fi
	if [ "${STORED}" -lt $(( REST + FIELD_INK_RISE )) ]; then
		abandon_take "settings-field-stored" \
			"the value did not survive the commit: value ink ${REST} -> ${TYPED} -> ${STORED}"
	fi
	echo "scene: after arm -- value ink ${REST} -> ${TYPED} -> ${STORED}, typed and then stored" >&2
fi
